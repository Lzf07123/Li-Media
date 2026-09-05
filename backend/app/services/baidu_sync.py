from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.memory import Memory, MemoryFile, MemoryFileStatus, MemoryKind, MemoryStatus
from app.services.baidu_pan import BaiduPanError, BaiduRemoteFile
from app.services.memory_files import guess_mime_type, infer_memory_kind_or_none
from app.services.memory_metadata import extract_memory_metadata
from app.services.memory_thumbnails import create_memory_thumbnail


class RemoteMediaClient(Protocol):
    def list_directory(self, remote_dir: str) -> list[BaiduRemoteFile]:
        ...

    def download(
        self,
        remote_id: str,
        target_path: Path,
        *,
        max_bytes: int,
    ) -> int:
        ...


@dataclass(frozen=True, slots=True)
class BaiduSyncSummary:
    discovered: int = 0
    matched: int = 0
    failed: int = 0


def sync_remote_directory(
    db: Session,
    client: RemoteMediaClient,
    *,
    remote_dir: str,
) -> int:
    remote_files = client.list_directory(remote_dir)
    now = datetime.now(timezone.utc)
    discovered_count = 0
    scanned_paths: set[str] = set()

    for remote_file in remote_files:
        kind = infer_memory_kind_or_none(remote_file.filename, None)
        if kind is None:
            scanned_paths.add(remote_file.remote_path)
            continue

        scanned_paths.add(remote_file.remote_path)

        memory_file = db.scalar(
            select(MemoryFile).where(
                MemoryFile.source == "baidupan",
                MemoryFile.remote_path == remote_file.remote_path,
            )
        )

        if memory_file is None:
            memory_id = uuid4()
            fallback_title = Path(remote_file.filename).stem.strip()[:255]
            memory = Memory(
                id=memory_id,
                title=fallback_title or "未命名回忆",
                kind=kind,
                status=MemoryStatus.PENDING,
            )
            memory_file = MemoryFile(
                memory_id=memory_id,
                source="baidupan",
                remote_path=remote_file.remote_path,
                remote_id=remote_file.remote_id,
                source_path="",
                mime_type=guess_mime_type(remote_file.filename, None),
                size_bytes=remote_file.size_bytes,
                status=MemoryFileStatus.PENDING,
                last_synced_at=now,
            )
            db.add(memory)
            db.add(memory_file)
            discovered_count += 1
        else:
            memory_file.remote_id = remote_file.remote_id
            memory_file.size_bytes = remote_file.size_bytes
            memory_file.last_synced_at = now
            if memory_file.status == MemoryFileStatus.MATCHED and (
                memory_file.remote_id != remote_file.remote_id
                or memory_file.size_bytes != remote_file.size_bytes
            ):
                memory_file.status = MemoryFileStatus.PENDING
                memory_file.sync_error = None

            if memory_file.status in {
                MemoryFileStatus.MISSING,
                MemoryFileStatus.REMOVED,
            }:
                memory_file.status = MemoryFileStatus.PENDING

    existing_files = db.scalars(
        select(MemoryFile).where(MemoryFile.source == "baidupan")
    ).all()
    for memory_file in existing_files:
        if memory_file.remote_path not in scanned_paths:
            memory_file.status = MemoryFileStatus.MISSING
            memory_file.sync_error = "网盘目录中未找到该文件"
            memory_file.last_synced_at = now

    db.commit()
    return discovered_count


def sync_baidu_files(
    db: Session,
    client: RemoteMediaClient,
    media_root: Path,
    *,
    remote_dir: str,
    max_files: int = 5,
    max_bytes: int = 2 * 1024 * 1024 * 1024,
) -> BaiduSyncSummary:
    discovered = sync_remote_directory(db, client, remote_dir=remote_dir)
    processed = sync_pending_remote_files(
        db,
        client,
        media_root,
        max_files=max_files,
        max_bytes=max_bytes,
    )
    return BaiduSyncSummary(
        discovered=discovered,
        matched=processed.matched,
        failed=processed.failed,
    )


def sync_pending_remote_files(
    db: Session,
    client: RemoteMediaClient,
    media_root: Path,
    *,
    max_files: int = 5,
    max_bytes: int = 2 * 1024 * 1024 * 1024,
) -> BaiduSyncSummary:
    pending_files = db.scalars(
        select(MemoryFile)
        .where(
            MemoryFile.source == "baidupan",
            MemoryFile.status.in_(
                [MemoryFileStatus.PENDING, MemoryFileStatus.FAILED]
            ),
        )
        .order_by(MemoryFile.updated_at.asc())
        .limit(max_files)
    ).all()
    matched_count = 0
    failed_count = 0

    for memory_file in pending_files:
        memory = memory_file.memory or db.get(Memory, memory_file.memory_id)

        if memory is None:
            memory_file.status = MemoryFileStatus.MISSING
            memory_file.sync_error = "缺少关联回忆记录"
            memory_file.last_synced_at = datetime.now(timezone.utc)
            db.commit()
            failed_count += 1
            continue

        memory_file.status = MemoryFileStatus.SYNCING
        memory_file.sync_error = None
        db.commit()

        target_path = media_root / "remote" / str(memory_file.id)
        try:
            downloaded_size = client.download(
                memory_file.remote_id or "",
                target_path,
                max_bytes=max_bytes,
            )
            kind = MemoryKind(memory.kind)
            metadata = extract_memory_metadata(target_path, kind)
            thumbnail_path = create_memory_thumbnail(
                target_path,
                media_root,
                kind=kind,
                memory_id=memory.id,
                duration_seconds=metadata.duration_seconds,
            )
            fallback_title = Path(memory_file.remote_path).stem.strip()[:255]

            if memory.title == fallback_title and metadata.title:
                memory.title = metadata.title.strip()[:255] or memory.title
            if not memory.description:
                memory.description = metadata.description or ""
            if memory.captured_at is None:
                memory.captured_at = metadata.captured_at
            if memory.location is None:
                memory.location = metadata.location
            if memory.width is None:
                memory.width = metadata.width
            if memory.height is None:
                memory.height = metadata.height
            if memory.duration_seconds is None:
                memory.duration_seconds = metadata.duration_seconds
            if memory.status in {MemoryStatus.PENDING, MemoryStatus.ERROR}:
                memory.status = MemoryStatus.PENDING

            memory_file.source_path = target_path.relative_to(media_root).as_posix()
            memory_file.size_bytes = downloaded_size or memory_file.size_bytes
            memory.thumbnail_path = thumbnail_path
            memory_file.status = MemoryFileStatus.MATCHED
            memory_file.sync_error = None
            memory_file.last_synced_at = datetime.now(timezone.utc)
            db.commit()
            matched_count += 1
        except Exception as exc:
            target_path.unlink(missing_ok=True)
            memory_file.status = MemoryFileStatus.FAILED
            memory_file.sync_error = (
                str(exc) if isinstance(exc, BaiduPanError) else type(exc).__name__
            )
            memory_file.last_synced_at = datetime.now(timezone.utc)
            if memory.status not in {MemoryStatus.PUBLISHED, MemoryStatus.HIDDEN}:
                memory.status = MemoryStatus.ERROR
            db.commit()
            failed_count += 1

    return BaiduSyncSummary(matched=matched_count, failed=failed_count)
