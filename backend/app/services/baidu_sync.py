from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import PurePosixPath
from collections.abc import Callable
from typing import Protocol
from uuid import UUID, uuid4

from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session, sessionmaker

from app.models.memory import (
    Memory,
    MemoryFile,
    MemoryFileStatus,
    MemoryKind,
    MemoryStatus,
    RemoteFileState,
    RemoteScanStatus,
    RemoteScanTask,
    RemoteStreamState,
    RemoteThumbnailState,
)
from app.services.admin_logs import record_admin_operation
from app.services.baidu_pan import BaiduListPage, BaiduPanError, BaiduRemoteItem
from app.services.memory_files import guess_mime_type, infer_memory_kind_or_none


class RemoteMediaClient(Protocol):
    def list_page(
        self,
        remote_dir: str,
        *,
        start: int,
        limit: int | None = None,
    ) -> BaiduListPage:
        ...

    def get_file_metadata(self, remote_id: str) -> BaiduRemoteItem:
        ...


@dataclass(frozen=True, slots=True)
class BaiduScanSummary:
    task_id: UUID
    status: RemoteScanStatus
    processed_items: int = 0
    scanned_files: int = 0
    scanned_directories: int = 0
    discovered: int = 0
    refreshed: int = 0
    skipped: int = 0
    deleted: int = 0
    limit_reached: bool = False
    failure_reason: str | None = None
    cursor: str | None = None


def scan_remote_directory(
    db: Session,
    client: RemoteMediaClient,
    *,
    remote_dir: str,
    max_depth: int = 8,
    max_items: int = 5000,
    resume_task_id: UUID | None = None,
    delete_missing: bool = False,
) -> BaiduScanSummary:
    if resume_task_id is not None:
        task = db.get(RemoteScanTask, resume_task_id)
        if task is None or task.status == RemoteScanStatus.COMPLETED:
            raise ValueError("扫描任务不存在或已完成")
    else:
        task = RemoteScanTask(
            remote_dir=remote_dir,
            max_depth=max(0, max_depth),
            max_items=max(1, max_items),
            delete_missing=delete_missing,
            cursor=json.dumps(
                [{"path": remote_dir, "start": 0, "depth": 0}],
                ensure_ascii=False,
            ),
        )
        db.add(task)
        db.commit()
        db.refresh(task)

    summary = BaiduScanSummary(task_id=task.id, status=RemoteScanStatus.RUNNING)
    queue = _decode_cursor(task.cursor, remote_dir)
    limit_reached = False

    try:
        while queue:
            current = queue[-1]
            directory = str(current["path"])
            start = int(current.get("start", 0))
            depth = int(current.get("depth", 0))
            pending_directories: list[dict[str, object]] = list(
                current.get("pending_dirs", [])
            )
            page = client.list_page(
                directory,
                start=start,
            )
            child_directories: list[dict[str, object]] = []
            page_consumed = 0

            for item in page.items:
                if task.processed_items >= task.max_items:
                    limit_reached = True
                    break

                task.processed_items += 1
                page_consumed += 1
                if item.is_dir:
                    task.scanned_directories += 1
                    if depth + 1 <= task.max_depth:
                        child_directories.append(
                            {"path": item.remote_path, "start": 0, "depth": depth + 1}
                        )
                    else:
                        task.skipped += 1
                    continue

                task.scanned_files += 1
                _upsert_remote_file(db, item, task=task)

            pending_directories.extend(child_directories)

            if limit_reached:
                queue[-1] = {
                    "path": directory,
                    "start": start + page_consumed,
                    "depth": depth,
                    "pending_dirs": pending_directories,
                }
                task.cursor = json.dumps(queue, ensure_ascii=False)
                break

            if page.next_start is not None:
                queue[-1] = {
                    "path": directory,
                    "start": page.next_start,
                    "depth": depth,
                    "pending_dirs": pending_directories,
                }
            else:
                queue.pop()
                queue.extend(pending_directories)

            task.cursor = json.dumps(queue, ensure_ascii=False)
            db.commit()

        task.status = RemoteScanStatus.COMPLETED
        task.completed_at = datetime.now(timezone.utc)
        task.cursor = None

        if not limit_reached:
            db.execute(
                update(MemoryFile)
                .where(
                    MemoryFile.source == "baidupan",
                    or_(
                        MemoryFile.last_scan_task_id != task.id,
                        MemoryFile.last_scan_task_id.is_(None),
                    ),
                )
                .values(
                    status=MemoryFileStatus.MISSING,
                    remote_state=RemoteFileState.MISSING,
                    stream_state=RemoteStreamState.UNAVAILABLE,
                    sync_error="网盘目录中未找到该文件",
                    last_synced_at=task.completed_at,
                )
            )

            deleted_count = (
                _delete_missing_remote_entries(db, task)
                if task.delete_missing
                else 0
            )
        else:
            deleted_count = 0

        db.commit()
        db.refresh(task)
        return _summary_from_task(
            task,
            limit_reached=limit_reached,
            deleted=deleted_count,
        )
    except BaiduPanError as exc:
        db.rollback()
        task = db.get(RemoteScanTask, task.id)
        if task is not None:
            task.status = RemoteScanStatus.FAILED
            task.failure_reason = str(exc)
            db.commit()
            db.refresh(task)
        return _summary_from_task(task) if task else summary
    except Exception as exc:
        db.rollback()
        task = db.get(RemoteScanTask, task.id)
        if task is not None:
            task.status = RemoteScanStatus.FAILED
            task.failure_reason = type(exc).__name__
            db.commit()
            db.refresh(task)
        return _summary_from_task(task) if task else summary


def refresh_remote_entry(
    db: Session,
    client: RemoteMediaClient,
    memory_file: MemoryFile,
) -> MemoryFile:
    if memory_file.source != "baidupan":
        raise ValueError("只有网盘条目可以刷新远程状态")

    try:
        item = client.get_file_metadata(memory_file.remote_id or "")
    except BaiduPanError:
        memory_file.remote_state = RemoteFileState.FAILED
        memory_file.stream_state = RemoteStreamState.FAILED
        memory_file.sync_error = "远程元数据刷新失败"
        memory_file.last_synced_at = datetime.now(timezone.utc)
        db.commit()
        raise

    if item.is_dir or item.remote_path != memory_file.remote_path:
        memory_file.remote_state = RemoteFileState.FAILED
        memory_file.stream_state = RemoteStreamState.FAILED
        memory_file.sync_error = "远程路径已变化或条目无效"
        memory_file.last_synced_at = datetime.now(timezone.utc)
        db.commit()
        raise BaiduPanError(memory_file.sync_error)

    _apply_remote_metadata(memory_file, item)
    memory_file.remote_state = RemoteFileState.READY
    memory_file.stream_state = RemoteStreamState.READY
    memory_file.status = MemoryFileStatus.MATCHED
    memory_file.sync_error = None
    memory_file.last_synced_at = datetime.now(timezone.utc)
    memory = memory_file.memory or db.get(Memory, memory_file.memory_id)

    if memory is not None:
        _fill_memory_from_remote(memory, item, allow_update=True)

    db.commit()
    db.refresh(memory_file)
    return memory_file


def _upsert_remote_file(
    db: Session,
    item: BaiduRemoteItem,
    *,
    task: RemoteScanTask,
) -> None:
    kind = infer_memory_kind_or_none(item.filename, None)
    if kind is None:
        task.skipped += 1
        return

    memory_file = db.scalar(
        select(MemoryFile).where(
            MemoryFile.source == "baidupan",
            MemoryFile.remote_id == item.remote_id,
            MemoryFile.remote_path == item.remote_path,
        )
    )
    now = datetime.now(timezone.utc)

    if memory_file is not None:
        task.refreshed += 1
        changed = (
            memory_file.size_bytes != item.size_bytes
            or memory_file.modified_at != item.modified_at
            or memory_file.remote_md5 != item.md5
        )
        _apply_remote_metadata(memory_file, item)
        memory_file.remote_state = RemoteFileState.READY
        memory_file.stream_state = RemoteStreamState.READY
        memory_file.status = MemoryFileStatus.MATCHED
        memory_file.sync_error = None
        memory_file.last_synced_at = now
        memory_file.last_scan_task_id = task.id

        if changed:
            memory = memory_file.memory or db.get(Memory, memory_file.memory_id)
            if memory is not None:
                _fill_memory_from_remote(memory, item, allow_update=True)
        return

    duplicate_by_md5 = None
    if item.md5:
        db.flush()
        duplicate_by_md5 = db.scalar(
            select(MemoryFile)
            .where(
                MemoryFile.source == "baidupan",
                MemoryFile.remote_md5 == item.md5,
            )
            .order_by(MemoryFile.created_at.asc())
        )
    memory_id = duplicate_by_md5.memory_id if duplicate_by_md5 else uuid4()

    if duplicate_by_md5 is None:
        fallback_title, captured_at, location = _derive_remote_metadata(item)
        db.add(
            Memory(
                id=memory_id,
                title=fallback_title,
                kind=kind,
                status=MemoryStatus.PENDING,
                captured_at=captured_at,
                location=location,
            )
        )

    memory_file = MemoryFile(
        memory_id=memory_id,
        source="baidupan",
        remote_id=item.remote_id,
        remote_path=item.remote_path,
        parent_path=item.parent_path,
        filename=item.filename,
        extension=PurePosixPath(item.filename).suffix.lstrip(".").lower() or None,
        mime_type=guess_mime_type(item.filename, None),
        size_bytes=item.size_bytes,
        modified_at=item.modified_at,
        remote_md5=item.md5,
        raw_metadata_summary=item.raw_metadata_summary,
        status=MemoryFileStatus.MATCHED,
        remote_state=RemoteFileState.READY,
        thumbnail_state=(
            RemoteThumbnailState.READY if item.thumbnail_url else RemoteThumbnailState.MISSING
        ),
        stream_state=RemoteStreamState.READY,
        last_synced_at=now,
        last_scan_task_id=task.id,
    )
    db.add(memory_file)
    task.discovered += 1


def _apply_remote_metadata(memory_file: MemoryFile, item: BaiduRemoteItem) -> None:
    memory_file.remote_id = item.remote_id
    memory_file.remote_path = item.remote_path
    memory_file.parent_path = item.parent_path
    memory_file.filename = item.filename
    memory_file.extension = (
        PurePosixPath(item.filename).suffix.lstrip(".").lower() or None
    )
    memory_file.size_bytes = item.size_bytes
    memory_file.modified_at = item.modified_at
    memory_file.remote_md5 = item.md5
    memory_file.raw_metadata_summary = item.raw_metadata_summary
    memory_file.thumbnail_state = (
        RemoteThumbnailState.READY if item.thumbnail_url else RemoteThumbnailState.MISSING
    )


def _fill_memory_from_remote(
    memory: Memory,
    item: BaiduRemoteItem,
    *,
    allow_update: bool,
) -> None:
    title, captured_at, location = _derive_remote_metadata(item)
    fallback_title = title

    if allow_update and (not memory.title or memory.title == fallback_title):
        memory.title = title

    if memory.captured_at is None:
        memory.captured_at = captured_at

    if memory.location is None:
        memory.location = location

    if memory.status not in {MemoryStatus.PUBLISHED, MemoryStatus.HIDDEN}:
        memory.status = MemoryStatus.PENDING


def _derive_remote_metadata(item: BaiduRemoteItem) -> tuple[str, datetime | None, str | None]:
    stem = PurePosixPath(item.filename).stem.replace("_", " ").replace("-", " ").strip()
    captured_at = _parse_datetime(item.filename) or _parse_datetime(item.parent_path)
    location_name = PurePosixPath(item.parent_path).name if item.parent_path else ""
    location = location_name.strip() or None
    return (stem[:255] or "未命名回忆", captured_at, location)


def _parse_datetime(value: str) -> datetime | None:
    if not value:
        return None

    match = re.search(
        r"(?P<year>20\d{2})[-_. ]?(?P<month>\d{2})[-_. ]?(?P<day>\d{2})"
        r"(?:[T_ -]+(?P<hour>\d{2})[:.]?(?P<minute>\d{2})[:.]?(?P<second>\d{2})?)?",
        value,
    )
    if match is None:
        return None

    try:
        parsed = datetime(
            int(match.group("year")),
            int(match.group("month")),
            int(match.group("day")),
            int(match.group("hour") or 0),
            int(match.group("minute") or 0),
            int(match.group("second") or 0),
            tzinfo=timezone.utc,
        )
    except ValueError:
        return None

    return parsed


def _decode_cursor(cursor: str | None, remote_dir: str) -> list[dict[str, object]]:
    if not cursor:
        return [{"path": remote_dir, "start": 0, "depth": 0}]

    try:
        queue = json.loads(cursor)
    except (TypeError, ValueError):
        return [{"path": remote_dir, "start": 0, "depth": 0}]

    return queue if isinstance(queue, list) and queue else []


def create_remote_scan_task(
    db: Session,
    *,
    remote_dir: str,
    max_depth: int,
    max_items: int,
    delete_missing: bool,
) -> RemoteScanTask:
    running_task = db.scalar(
        select(RemoteScanTask).where(
            RemoteScanTask.status == RemoteScanStatus.RUNNING
        )
    )
    if running_task is not None:
        return running_task

    task = RemoteScanTask(
        remote_dir=remote_dir,
        max_depth=max(0, max_depth),
        max_items=max(1, max_items),
        delete_missing=delete_missing,
        cursor=json.dumps(
            [{"path": remote_dir, "start": 0, "depth": 0}],
            ensure_ascii=False,
        ),
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


def run_remote_scan_task(
    session_factory: sessionmaker[Session],
    task_id: UUID,
    client_factory: Callable[[], RemoteMediaClient],
) -> None:
    with session_factory() as db:
        task = db.get(RemoteScanTask, task_id)
        if task is None or task.status == RemoteScanStatus.COMPLETED:
            return

        try:
            summary = scan_remote_directory(
                db,
                client_factory(),
                remote_dir=task.remote_dir,
                max_depth=task.max_depth,
                max_items=task.max_items,
                resume_task_id=task.id,
                delete_missing=task.delete_missing,
            )
        except Exception:
            # scan_remote_directory already records the failure on the task.
            record_admin_operation(
                db,
                action="scan",
                target_type="remote_scan_task",
                detail=f"task={task.id};status=failed;mode={'async-delete' if task.delete_missing else 'async-keep'}",
            )
            db.commit()
            return

        record_admin_operation(
            db,
            action="scan",
            target_type="remote_scan_task",
            detail=(
                f"task={summary.task_id};status={summary.status.value};"
                f"discovered={summary.discovered};refreshed={summary.refreshed};"
                f"skipped={summary.skipped};deleted={summary.deleted};"
                f"mode={'async-delete' if task.delete_missing else 'async-keep'}"
            ),
        )
        db.commit()


def _delete_missing_remote_entries(db: Session, task: RemoteScanTask) -> int:
    missing_files = db.scalars(
        select(MemoryFile).where(
            MemoryFile.source == "baidupan",
            or_(
                MemoryFile.last_scan_task_id != task.id,
                MemoryFile.last_scan_task_id.is_(None),
            ),
        )
    ).all()
    memory_ids = {memory_file.memory_id for memory_file in missing_files}

    for memory_file in missing_files:
        db.delete(memory_file)
    db.flush()

    deleted_memories = 0
    for memory_id in memory_ids:
        if memory_id is None:
            continue

        remote_file_count = db.scalar(
            select(func.count()).select_from(MemoryFile).where(
                MemoryFile.memory_id == memory_id,
                MemoryFile.source == "baidupan",
            )
        )
        if remote_file_count != 0:
            continue

        memory = db.get(Memory, memory_id)
        if memory is not None:
            db.delete(memory)
            deleted_memories += 1

    record_admin_operation(
        db,
        action="remote_index_delete",
        target_type="memory_batch",
        detail=f"task={task.id};files={len(missing_files)};memories={deleted_memories};remote_resource=unchanged",
    )
    return len(missing_files)


def _summary_from_task(
    task: RemoteScanTask,
    *,
    limit_reached: bool = False,
    deleted: int = 0,
) -> BaiduScanSummary:
    return BaiduScanSummary(
        task_id=task.id,
        status=RemoteScanStatus(task.status),
        processed_items=task.processed_items,
        scanned_files=task.scanned_files,
        scanned_directories=task.scanned_directories,
        discovered=task.discovered,
        refreshed=task.refreshed,
        skipped=task.skipped,
        deleted=deleted,
        limit_reached=limit_reached,
        failure_reason=task.failure_reason,
        cursor=task.cursor,
    )
