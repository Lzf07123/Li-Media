"""Bounded, manually-triggered thumbnail preheating."""

from __future__ import annotations

import logging
import time
import gc
from concurrent.futures import Future, ThreadPoolExecutor, wait, FIRST_COMPLETED
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from threading import Event, Lock
from uuid import UUID, uuid4

from sqlalchemy import and_, distinct, exists, func, or_, select
from sqlalchemy.orm import sessionmaker, Session

from app.core.config import Settings, get_settings
from app.models.memory import (
    DerivativeCacheStatus,
    DerivativeFailureKind,
    Memory,
    MemoryDerivativeCache,
    MemoryFile,
    MemoryKind,
    MemoryStatus,
    RemoteFileState,
    RemoteStreamState,
    RemoteThumbnailState,
)
from app.services.baidu_pan import BaiduPanClient, BaiduPanError
from app.services.derivative_tasks import (
    run_local_derivative,
)
from app.services.remote_thumbnails import (
    classify_remote_error,
    temporary_directory_has_capacity,
)
from app.services.memory_thumbnails import (
    derivative_cache_path,
    resolve_media_path,
)
from app.services.display_health import (
    browser_playable_files_condition,
    public_files_condition,
)
from app.services.task_limits import TaskCancelled, TaskRejected, task_metrics
from app.services.task_limits import TaskType
from app.services.task_limits import task_limiter
from app.services.task_limits import register_temporary_path, unregister_temporary_path


logger = logging.getLogger(__name__)

HOME_PREHEAT_SIZE = 240
DETAIL_PREHEAT_SIZES = (480, 768, 1280)
MAX_PREHEAT_JOB_HISTORY = 20


@dataclass(slots=True)
class ThumbnailPreheatJob:
    id: UUID
    sizes: tuple[int, ...]
    kind: MemoryKind | None
    limit: int
    concurrency: int
    queue_limit: int
    status: str = "queued"
    total: int = 0
    processed: int = 0
    generated: int = 0
    cached: int = 0
    failed: int = 0
    source_bytes_downloaded: int = 0
    derivative_duration_ms: int = 0
    size_results: dict[str, dict[str, int]] = field(default_factory=dict)
    message: str | None = None
    cancel_event: Event = field(default_factory=Event)
    created_at: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
    started_at: datetime | None = None
    completed_at: datetime | None = None

    def __post_init__(self) -> None:
        self.sizes = tuple(dict.fromkeys(self.sizes)) or (HOME_PREHEAT_SIZE,)
        self.size_results = {
            str(size): {"generated": 0, "cached": 0, "failed": 0}
            for size in self.sizes
        }


class ThumbnailPreheatRegistry:
    def __init__(self) -> None:
        self._jobs: dict[UUID, ThumbnailPreheatJob] = {}
        self._latest_id: UUID | None = None
        self._lock = Lock()

    def start(
        self,
        *,
        sizes: tuple[int, ...] | list[int] | None = None,
        kind: MemoryKind | None,
        limit: int,
        concurrency: int = 1,
        queue_limit: int = 0,
    ) -> tuple[ThumbnailPreheatJob, bool]:
        with self._lock:
            running = next(
                (
                    job
                    for job in self._jobs.values()
                    if job.status in {"queued", "running"}
                ),
                None,
            )
            if running is not None:
                return running, False

            job = ThumbnailPreheatJob(
                id=uuid4(),
                sizes=tuple(sizes or (HOME_PREHEAT_SIZE,)),
                kind=kind,
                limit=limit,
                concurrency=max(1, concurrency),
                queue_limit=max(0, queue_limit),
            )
            self._jobs[job.id] = job
            self._latest_id = job.id
            while len(self._jobs) > MAX_PREHEAT_JOB_HISTORY:
                oldest_id = next(iter(self._jobs))
                if oldest_id != job.id:
                    self._jobs.pop(oldest_id, None)
                else:
                    break
            return job, True

    def get(self, job_id: UUID) -> ThumbnailPreheatJob | None:
        with self._lock:
            return self._jobs.get(job_id)

    def get_latest(self) -> ThumbnailPreheatJob | None:
        with self._lock:
            return self._jobs.get(self._latest_id) if self._latest_id else None

    def _update(self, job_id: UUID, **values: object) -> ThumbnailPreheatJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            for key, value in values.items():
                setattr(job, key, value)
            return job

    def mark_running(self, job_id: UUID, total: int) -> None:
        self._update(
            job_id,
            status="running",
            total=total,
            started_at=datetime.now(timezone.utc),
        )

    def mark_item_processed(
        self,
        job_id: UUID,
        *,
        outcomes: dict[int, str],
        source_bytes: int = 0,
        derivative_duration_ms: int = 0,
    ) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job.processed += 1
            job.source_bytes_downloaded += max(0, source_bytes)
            job.derivative_duration_ms += max(0, derivative_duration_ms)
            for size, outcome in outcomes.items():
                key = str(size)
                if key not in job.size_results:
                    job.size_results[key] = {"generated": 0, "cached": 0, "failed": 0}
                job.size_results[key][outcome if outcome in {"generated", "cached", "failed"} else "failed"] += 1
                if outcome == "generated":
                    job.generated += 1
                elif outcome == "cached":
                    job.cached += 1
                elif outcome == "failed":
                    job.failed += 1

    def mark_completed(self, job_id: UUID, message: str | None = None) -> None:
        self._update(
            job_id,
            status="completed",
            message=message,
            completed_at=datetime.now(timezone.utc),
        )

    def mark_failed(self, job_id: UUID, message: str) -> None:
        self._update(
            job_id,
            status="failed",
            message=message[:255],
            completed_at=datetime.now(timezone.utc),
        )

    def mark_cancelled(self, job_id: UUID, message: str | None = None) -> None:
        self._update(
            job_id,
            status="cancelled",
            message=message,
            completed_at=datetime.now(timezone.utc),
        )

    def request_cancel(self, job_id: UUID) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or job.status not in {"queued", "running"}:
                return False
            job.cancel_event.set()
            return True


thumbnail_preheat_registry = ThumbnailPreheatRegistry()

NON_RETRYABLE_FAILURE_KINDS = frozenset(
    {
        DerivativeFailureKind.SOURCE_TRUNCATED.value,
        DerivativeFailureKind.MOV_MOOV.value,
        DerivativeFailureKind.CODEC_UNSUPPORTED.value,
        DerivativeFailureKind.FORMAT_UNSUPPORTED.value,
    }
)


def _public_file_statement():
    return (
        select(Memory.id, MemoryFile.id)
        .join(MemoryFile, Memory.files)
        .where(
            Memory.status == MemoryStatus.PUBLISHED,
            MemoryFile.source == "baidupan",
            MemoryFile.remote_id.is_not(None),
            public_files_condition(),
        )
    )


def _as_candidate_result(result: object, sizes: tuple[int, ...]) -> PreheatCandidateResult:
    if isinstance(result, PreheatCandidateResult):
        return result
    if isinstance(result, str) and result in {"generated", "cached", "failed", "cancelled"}:
        return PreheatCandidateResult(outcomes={size: result for size in sizes})
    return PreheatCandidateResult(outcomes={size: "failed" for size in sizes}, failure_kind="unknown")


def _candidate_pairs(
    db: Session,
    *,
    kind: MemoryKind | None,
    limit: int,
    max_size: int = HOME_PREHEAT_SIZE,
    derivative_version: str | None = None,
) -> list[tuple[UUID, UUID]]:
    statement = (
        select(Memory.id, MemoryFile.id)
        .join(MemoryFile, Memory.files)
        .where(
            Memory.status == MemoryStatus.PUBLISHED,
            MemoryFile.source == "baidupan",
            MemoryFile.remote_id.is_not(None),
        )
    )
    statement = statement.where(
        MemoryFile.remote_state == RemoteFileState.READY,
        browser_playable_files_condition(),
        or_(
            Memory.kind == MemoryKind.PHOTO,
            MemoryFile.stream_state != RemoteStreamState.FAILED,
        ),
    )
    if kind is not None:
        statement = statement.where(Memory.kind == kind)

    statement = statement.where(
        MemoryFile.thumbnail_failure_kind.is_(None)
        | MemoryFile.thumbnail_failure_kind.not_in(NON_RETRYABLE_FAILURE_KINDS)
    )
    version = derivative_version or get_settings().media_derivative_version
    ready_cache = exists(
        select(MemoryDerivativeCache.id).where(
            MemoryDerivativeCache.memory_file_id == MemoryFile.id,
            MemoryDerivativeCache.max_size == max_size,
            MemoryDerivativeCache.derivative_version == version,
            MemoryDerivativeCache.status == DerivativeCacheStatus.READY,
        )
    )
    legacy_cache = and_(
        Memory.thumbnail_path.is_not(None),
        Memory.thumbnail_path.endswith(f"/{version}/{max_size}.webp"),
    )
    statement = statement.where(~(ready_cache | legacy_cache))
    ordered_statement = (
        statement.order_by(Memory.captured_at.desc().nulls_last())
        .order_by(Memory.updated_at.desc())
        .order_by(Memory.id.desc())
        .order_by(MemoryFile.id)
    )
    rows = db.execute(ordered_statement).all()
    pairs: list[tuple[UUID, UUID]] = []
    seen_memories: set[UUID] = set()
    for memory_id, file_id in rows:
        if memory_id in seen_memories:
            continue
        seen_memories.add(memory_id)
        pairs.append((memory_id, file_id))
    return pairs[:limit] if limit > 0 else pairs


def count_public_derivative_candidates(db: Session) -> int:
    """Count the same public display surface without leaking per-item data."""

    statement = (
        select(func.count(distinct(Memory.id)))
        .select_from(MemoryFile)
        .join(Memory, MemoryFile.memory_id == Memory.id)
        .where(
            Memory.status == MemoryStatus.PUBLISHED,
            MemoryFile.source == "baidupan",
            MemoryFile.remote_id.is_not(None),
            public_files_condition(),
        )
    )
    return int(db.scalar(statement) or 0)


def count_public_derivative_cache_hits(
    db: Session,
    *,
    max_size: int = HOME_PREHEAT_SIZE,
    derivative_version: str | None = None,
) -> int:
    """Count public files with a persisted derivative, independent of job history."""

    version = derivative_version or get_settings().media_derivative_version
    statement = (
        select(func.count(distinct(Memory.id)))
        .select_from(MemoryFile)
        .join(Memory, MemoryFile.memory_id == Memory.id)
        .outerjoin(
            MemoryDerivativeCache,
            and_(
                MemoryDerivativeCache.memory_file_id == MemoryFile.id,
                MemoryDerivativeCache.max_size == max_size,
                MemoryDerivativeCache.derivative_version == version,
                MemoryDerivativeCache.status == DerivativeCacheStatus.READY,
            ),
        )
        .where(
            Memory.status == MemoryStatus.PUBLISHED,
            MemoryFile.source == "baidupan",
            MemoryFile.remote_id.is_not(None),
            public_files_condition(),
        )
        .where(
            or_(
                MemoryDerivativeCache.id.is_not(None),
                and_(
                    Memory.thumbnail_path.is_not(None),
                    Memory.thumbnail_path.endswith(f"/{version}/{max_size}.webp"),
                ),
            )
        )
    )
    return int(db.scalar(statement) or 0)


def count_public_detail_derivative_cache_hits(db: Session) -> int:
    """Count public files with at least one persisted detail derivative."""

    version = get_settings().media_derivative_version
    statement = (
        select(func.count(distinct(Memory.id)))
        .select_from(MemoryFile)
        .join(Memory, MemoryFile.memory_id == Memory.id)
        .outerjoin(
            MemoryDerivativeCache,
            and_(
                MemoryDerivativeCache.memory_file_id == MemoryFile.id,
                MemoryDerivativeCache.max_size.in_(DETAIL_PREHEAT_SIZES),
                MemoryDerivativeCache.derivative_version == version,
                MemoryDerivativeCache.status == DerivativeCacheStatus.READY,
            ),
        )
        .where(
            Memory.status == MemoryStatus.PUBLISHED,
            MemoryFile.source == "baidupan",
            MemoryFile.remote_id.is_not(None),
            public_files_condition(),
            MemoryDerivativeCache.id.is_not(None),
        )
    )
    return int(db.scalar(statement) or 0)


def _is_home_preheat_job(job: ThumbnailPreheatJob | None) -> bool:
    return job is not None and job.sizes == (HOME_PREHEAT_SIZE,)


def collect_public_preheat_status(
    db: Session,
    *,
    latest_job: ThumbnailPreheatJob | None,
) -> dict[str, int | str]:
    total = count_public_derivative_candidates(db)
    cache_hits = count_public_derivative_cache_hits(db)

    if _is_home_preheat_job(latest_job) and latest_job.status in {"queued", "running"}:
        return {
            "status": "running",
            "processed": max(0, latest_job.processed),
            "total": total,
        }

    is_ready = total == 0 or cache_hits >= total
    is_degraded = bool(
        _is_home_preheat_job(latest_job)
        and latest_job is not None
        and (
            latest_job.status in {"cancelled", "failed"}
            or (latest_job.status == "completed" and latest_job.failed > 0)
        )
    )
    status = "ready" if is_ready else "degraded" if is_degraded else "not_preheated"
    return {
        "status": status,
        "processed": total if is_ready else cache_hits,
        "total": total,
    }


@dataclass(slots=True)
class PreheatCandidateResult:
    outcomes: dict[int, str]
    source_bytes_downloaded: int = 0
    derivative_duration_ms: int = 0
    failure_kind: str | None = None


def _set_derivative_cache_state(
    db: Session,
    *,
    memory_file_id: UUID,
    settings: Settings,
    max_size: int,
    status: DerivativeCacheStatus,
    output_path: Path | None = None,
    failure_kind: str | None = None,
    source_bytes: int | None = None,
    duration_ms: int | None = None,
) -> None:
    cache = db.scalar(
        select(MemoryDerivativeCache).where(
            MemoryDerivativeCache.memory_file_id == memory_file_id,
            MemoryDerivativeCache.max_size == max_size,
            MemoryDerivativeCache.derivative_version
            == settings.media_derivative_version,
        )
    )
    if cache is None:
        cache = MemoryDerivativeCache(
            id=uuid4(),
            memory_file_id=memory_file_id,
            max_size=max_size,
            derivative_version=settings.media_derivative_version,
        )
        db.add(cache)

    cache.status = status
    cache.failure_kind = None if status == DerivativeCacheStatus.READY else failure_kind
    cache.output_path = (
        output_path.relative_to(Path(settings.media_root).resolve()).as_posix()
        if status == DerivativeCacheStatus.READY and output_path is not None
        else None
    )
    cache.output_bytes = (
        output_path.stat().st_size
        if status == DerivativeCacheStatus.READY and output_path is not None
        else None if status == DerivativeCacheStatus.READY else cache.output_bytes
    )
    cache.source_bytes = source_bytes
    cache.duration_ms = duration_ms
    db.flush()


def _download_remote_source(
    *,
    client: BaiduPanClient,
    remote_id: str,
    media_root: Path,
    memory: Memory,
    memory_file: MemoryFile,
    settings: Settings,
    failure_sink: dict[str, str],
    cancel_event: Event | None,
) -> tuple[Path | None, int]:
    temporary_dir = media_root / "tmp"
    temporary_dir.mkdir(parents=True, exist_ok=True)
    temporary_path = temporary_dir / f"{memory.id}.{uuid4().hex}.source.tmp"
    max_source_bytes = (
        settings.remote_thumbnail_video_source_max_bytes
        if memory.kind == MemoryKind.VIDEO
        else settings.remote_thumbnail_source_max_bytes
    )
    stream: object | None = None
    temporary_registered = False
    cleanup_path: Path | None = temporary_path

    try:
        if not temporary_directory_has_capacity(temporary_dir):
            failure_sink.setdefault("kind", DerivativeFailureKind.DISK_QUOTA.value)
            return None, 0

        status_code, content_length, _, _, stream = client.open_stream(
            remote_id,
            range_header=None,
        )
        if status_code is not None and status_code >= 400:
            failure_sink.setdefault("kind", DerivativeFailureKind.REMOTE_UNAVAILABLE.value)
            return None, 0
        if content_length is not None and content_length > max_source_bytes:
            failure_sink.setdefault(
                "kind",
                DerivativeFailureKind.MOV_MOOV.value
                if memory_file.mime_type == "video/quicktime"
                else DerivativeFailureKind.SOURCE_TRUNCATED.value,
            )
            return None, 0

        register_temporary_path(temporary_path.resolve())
        temporary_registered = True
        written_bytes = 0
        with temporary_path.open("wb") as output:
            for chunk in stream.iter_bytes():
                if cancel_event is not None and cancel_event.is_set():
                    failure_sink.setdefault("kind", DerivativeFailureKind.CANCELLED.value)
                    return None, written_bytes
                if not chunk:
                    continue
                output.write(chunk)
                written_bytes += len(chunk)
                if written_bytes >= max_source_bytes:
                    failure_sink.setdefault(
                        "kind",
                        DerivativeFailureKind.MOV_MOOV.value
                        if memory_file.mime_type == "video/quicktime"
                        else DerivativeFailureKind.SOURCE_TRUNCATED.value,
                    )
                    return None, written_bytes

        if not temporary_path.is_file() or temporary_path.stat().st_size == 0:
            failure_sink.setdefault("kind", DerivativeFailureKind.TEMPORARY_EMPTY.value)
            return None, written_bytes
        cleanup_path = None
        return temporary_path, written_bytes
    except BaiduPanError as exc:
        failure_sink.setdefault("kind", classify_remote_error(exc))
        return None, 0
    except Exception as exc:
        failure_sink.setdefault("kind", classify_remote_error(exc))
        return None, 0
    finally:
        if stream is not None and hasattr(stream, "close"):
            stream.close()
        if cleanup_path is not None:
            cleanup_path.unlink(missing_ok=True)
        if temporary_registered:
            unregister_temporary_path(temporary_path.resolve())


def _process_pair_sizes(
    db: Session,
    *,
    memory_id: UUID,
    memory_file_id: UUID,
    settings: Settings,
    sizes: tuple[int, ...],
    cancel_event: Event | None = None,
    client: BaiduPanClient | None = None,
) -> PreheatCandidateResult:
    memory = db.get(Memory, memory_id)
    memory_file = db.get(MemoryFile, memory_file_id)
    if memory is None or memory_file is None or not memory_file.remote_id:
        return PreheatCandidateResult(
            outcomes={size: "failed" for size in sizes},
            failure_kind="unknown",
        )

    if cancel_event is not None and cancel_event.is_set():
        return PreheatCandidateResult(
            outcomes={size: "cancelled" for size in sizes},
            failure_kind=DerivativeFailureKind.CANCELLED.value,
        )

    media_root = Path(settings.media_root)
    outcomes: dict[int, str] = {}
    failure_kind: str | None = None
    source_bytes_downloaded = 0
    derivative_duration_ms = 0
    downloaded_remote_source: Path | None = None

    # Reconcile files already produced by an earlier run before touching Baidu.
    # Older workers could persist the file but be killed before recording state.
    for max_size in sizes:
        target_path = derivative_cache_path(
            media_root,
            memory.id,
            max_size=max_size,
            version=settings.media_derivative_version,
        )
        if not target_path.is_file():
            continue
        _set_derivative_cache_state(
            db,
            memory_file_id=memory_file_id,
            settings=settings,
            max_size=max_size,
            status=DerivativeCacheStatus.READY,
            output_path=target_path,
            source_bytes=0,
            duration_ms=0,
        )
        outcomes[max_size] = "cached"
        if max_size == HOME_PREHEAT_SIZE or memory.thumbnail_path is None:
            memory.thumbnail_path = target_path.relative_to(media_root).as_posix()

    if len(outcomes) == len(sizes):
        memory_file.thumbnail_state = RemoteThumbnailState.READY
        memory_file.thumbnail_failure_kind = None
        db.commit()
        return PreheatCandidateResult(outcomes=outcomes)

    source_path: Path | None = resolve_media_path(
        media_root, memory_file.source_path or ""
    )
    if source_path is not None and not source_path.is_file():
        source_path = None

    if source_path is None:
        remote_failure_sink: dict[str, str] = {}
        remote_client = client or BaiduPanClient(settings)
        source_path, source_bytes_downloaded = _download_remote_source(
            client=remote_client,
            remote_id=memory_file.remote_id,
            media_root=media_root,
            memory=memory,
            memory_file=memory_file,
            settings=settings,
            failure_sink=remote_failure_sink,
            cancel_event=cancel_event,
        )
        failure_kind = remote_failure_sink.get("kind")
        if source_path is None:
            return PreheatCandidateResult(
                outcomes={size: "failed" for size in sizes},
                source_bytes_downloaded=source_bytes_downloaded,
                failure_kind=failure_kind or "unknown",
            )
        downloaded_remote_source = source_path
        register_temporary_path(downloaded_remote_source.resolve())

    try:
        for max_size in sizes:
            if max_size in outcomes:
                continue
            target_path = derivative_cache_path(
                media_root,
                memory.id,
                max_size=max_size,
                version=settings.media_derivative_version,
            )
            if target_path.is_file():
                _set_derivative_cache_state(
                    db,
                    memory_file_id=memory_file_id,
                    settings=settings,
                    max_size=max_size,
                    status=DerivativeCacheStatus.READY,
                    output_path=target_path,
                    source_bytes=source_path.stat().st_size,
                    duration_ms=0,
                )
                outcomes[max_size] = "cached"
                continue

            if cancel_event is not None and cancel_event.is_set():
                failure_sink: dict[str, str] = {"kind": DerivativeFailureKind.CANCELLED.value}
                duration_ms = 0
                generated_path = None
            else:
                failure_sink = {}
                started_at = time.monotonic()
                try:
                    generated_path = run_local_derivative(
                        source_path,
                        media_root,
                        memory=memory,
                        max_size=max_size,
                        duration_seconds=memory.duration_seconds,
                        priority=60,
                        failure_sink=failure_sink,
                        cancel_event=cancel_event,
                    )
                except TaskRejected:
                    task_metrics.record_failed(TaskType.DERIVATIVE)
                    failure_sink.setdefault("kind", "queue_rejected")
                    generated_path = None
                duration_ms = int((time.monotonic() - started_at) * 1000)

            derivative_duration_ms += duration_ms
            if not generated_path:
                failure_kind = failure_sink.get("kind", "unknown")
                _set_derivative_cache_state(
                    db,
                    memory_file_id=memory_file_id,
                    settings=settings,
                    max_size=max_size,
                    status=DerivativeCacheStatus.FAILED,
                    failure_kind=failure_kind,
                    source_bytes=source_path.stat().st_size,
                    duration_ms=duration_ms,
                )
                outcomes[max_size] = "failed"
                continue

            generated_output_path = Path(generated_path)
            if not generated_output_path.is_absolute():
                generated_output_path = media_root / generated_output_path
            _set_derivative_cache_state(
                db,
                memory_file_id=memory_file_id,
                settings=settings,
                max_size=max_size,
                status=DerivativeCacheStatus.READY,
                output_path=generated_output_path,
                source_bytes=source_path.stat().st_size,
                duration_ms=duration_ms,
            )
            outcomes[max_size] = "generated"
            if (
                max_size == HOME_PREHEAT_SIZE
                or memory.thumbnail_path is None
            ):
                memory.thumbnail_path = generated_path

        if any(outcome in {"generated", "cached"} for outcome in outcomes.values()):
            memory_file.thumbnail_state = RemoteThumbnailState.READY
            memory_file.thumbnail_failure_kind = None
        else:
            memory_file.thumbnail_state = RemoteThumbnailState.FAILED
            memory_file.thumbnail_failure_kind = failure_kind or "unknown"
        db.commit()
        return PreheatCandidateResult(
            outcomes=outcomes,
            source_bytes_downloaded=source_bytes_downloaded,
            derivative_duration_ms=derivative_duration_ms,
            failure_kind=failure_kind if all(value == "failed" for value in outcomes.values()) else None,
        )
    except Exception:
        db.rollback()
        raise
    finally:
        if downloaded_remote_source is not None:
            downloaded_remote_source.unlink(missing_ok=True)
            unregister_temporary_path(downloaded_remote_source.resolve())


def _mark_failure(
    session_factory: sessionmaker[Session],
    *,
    memory_file_id: UUID,
    failure_kind: str,
) -> None:
    try:
        with session_factory.begin() as db:
            memory_file = db.get(MemoryFile, memory_file_id)
            if memory_file is not None:
                memory_file.thumbnail_state = RemoteThumbnailState.FAILED
                memory_file.thumbnail_failure_kind = failure_kind
    except Exception:
        # 预热失败状态不应让单个坏资源中断整批任务。
        return


def _mark_unexpected_cache_failure(
    session_factory: sessionmaker[Session],
    *,
    memory_file_id: UUID,
    sizes: tuple[int, ...],
    settings: Settings,
    failure_kind: str,
) -> None:
    try:
        with session_factory.begin() as db:
            for max_size in sizes:
                _set_derivative_cache_state(
                    db,
                    memory_file_id=memory_file_id,
                    settings=settings,
                    max_size=max_size,
                    status=DerivativeCacheStatus.FAILED,
                    failure_kind=failure_kind,
                )
    except Exception:
        return


def _process_candidate(
    session_factory: sessionmaker[Session],
    *,
    memory_id: UUID,
    memory_file_id: UUID,
    settings: Settings,
    sizes: tuple[int, ...],
    cancel_event: Event,
    client: BaiduPanClient | None = None,
) -> PreheatCandidateResult:
    try:
        with task_limiter.slot(
            TaskType.PREHEAT,
            priority=60,
            cancel_event=cancel_event,
        ):
            with session_factory() as db:
                result = _process_pair_sizes(
                    db,
                    memory_id=memory_id,
                    memory_file_id=memory_file_id,
                    settings=settings,
                    sizes=sizes,
                    cancel_event=cancel_event,
                    client=client,
                )

        if all(outcome == "failed" for outcome in result.outcomes.values()):
            task_metrics.record_failed(TaskType.PREHEAT)
            _mark_failure(
                session_factory,
                memory_file_id=memory_file_id,
                failure_kind=result.failure_kind or "unknown",
            )
        elif any(outcome == "cancelled" for outcome in result.outcomes.values()):
            task_metrics.record_cancelled(TaskType.PREHEAT)
        else:
            task_metrics.record_completed(TaskType.PREHEAT)
        return result
    except TaskCancelled:
        task_metrics.record_cancelled(TaskType.PREHEAT)
        return PreheatCandidateResult(
            outcomes={size: "cancelled" for size in sizes},
            failure_kind=DerivativeFailureKind.CANCELLED.value,
        )
    except Exception:
        logger.exception(
            "thumbnail preheat candidate failed; memory_id=%s file_id=%s",
            memory_id,
            memory_file_id,
        )
        task_metrics.record_failed(TaskType.PREHEAT)
        _mark_failure(
            session_factory,
            memory_file_id=memory_file_id,
            failure_kind=failure_sink.get("kind", "unknown"),
        )
        _mark_unexpected_cache_failure(
            session_factory,
            memory_file_id=memory_file_id,
            sizes=sizes,
            settings=settings,
            failure_kind=failure_sink.get("kind", "unknown"),
        )
        return PreheatCandidateResult(
            outcomes={size: "failed" for size in sizes},
            failure_kind=failure_sink.get("kind", "unknown"),
        )


def _process_pair(
    db: Session,
    *,
    memory_id: UUID,
    memory_file_id: UUID,
    settings: Settings,
    max_size: int,
    failure_sink: dict[str, str] | None = None,
    cancel_event: Event | None = None,
    client: BaiduPanClient | None = None,
) -> str:
    result = _process_pair_sizes(
        db,
        memory_id=memory_id,
        memory_file_id=memory_file_id,
        settings=settings,
        sizes=(max_size,),
        cancel_event=cancel_event,
        client=client,
    )
    if failure_sink is not None and result.failure_kind:
        failure_sink.setdefault("kind", result.failure_kind)
    if any(outcome == "cancelled" for outcome in result.outcomes.values()):
        return "cancelled"
    if all(outcome == "failed" for outcome in result.outcomes.values()):
        return "failed"
    if any(outcome == "generated" for outcome in result.outcomes.values()):
        return "generated"
    return "cached"


def run_thumbnail_preheat(
    job_id: UUID,
    *,
    session_factory: sessionmaker[Session],
    settings: Settings,
    registry: ThumbnailPreheatRegistry = thumbnail_preheat_registry,
) -> None:
    job = registry.get(job_id)
    if job is None:
        return
    if job.cancel_event.is_set():
        registry.mark_cancelled(job_id)
        return

    try:
        with session_factory() as db:
            pairs = _candidate_pairs(
                db,
                kind=job.kind,
                limit=job.limit,
            )
        registry.mark_running(job_id, total=len(pairs))

        shared_client: BaiduPanClient | None = None
        if settings is not None:
            try:
                shared_client = BaiduPanClient(settings)
            except BaiduPanError as exc:
                registry.mark_failed(job_id, str(exc)[:255])
                return

        candidate_iterator = iter(pairs)
        futures: dict[Future[PreheatCandidateResult], tuple[UUID, UUID]] = {}
        max_pending = job.concurrency + job.queue_limit
        cancelled = False

        with ThreadPoolExecutor(
            max_workers=job.concurrency,
            thread_name_prefix="limedia-preheat",
        ) as executor:

            def submit_ready() -> None:
                while len(futures) < max_pending:
                    if job.cancel_event.is_set():
                        return
                    try:
                        pair = next(candidate_iterator)
                    except StopIteration:
                        return
                    future = executor.submit(
                        _process_candidate,
                        session_factory,
                        memory_id=pair[0],
                        memory_file_id=pair[1],
                        settings=settings,
                        sizes=job.sizes,
                        cancel_event=job.cancel_event,
                        client=shared_client,
                    )
                    futures[future] = pair

            submit_ready()
            while futures:
                if job.cancel_event.is_set():
                    cancelled = True
                    break

                completed, _ = wait(
                    futures,
                    timeout=0.2,
                    return_when=FIRST_COMPLETED,
                )
                for future in completed:
                    futures.pop(future, None)
                    try:
                        result = future.result()
                        result = _as_candidate_result(result, job.sizes)
                    except Exception:
                        result = PreheatCandidateResult(
                            outcomes={size: "failed" for size in job.sizes},
                            failure_kind="unknown",
                        )
                    registry.mark_item_processed(
                        job_id,
                        outcomes=result.outcomes,
                        source_bytes=result.source_bytes_downloaded,
                        derivative_duration_ms=result.derivative_duration_ms,
                    )
                    if any(outcome == "cancelled" for outcome in result.outcomes.values()):
                        cancelled = True

                if cancelled:
                    break
                submit_ready()

            if cancelled:
                executor.shutdown(wait=True, cancel_futures=True)
                for future in futures:
                    if future.cancelled():
                        continue
                    try:
                        result = future.result()
                        result = _as_candidate_result(result, job.sizes)
                    except Exception:
                        result = PreheatCandidateResult(
                            outcomes={size: "failed" for size in job.sizes},
                            failure_kind="unknown",
                        )
                    registry.mark_item_processed(
                        job_id,
                        outcomes=result.outcomes,
                        source_bytes=result.source_bytes_downloaded,
                        derivative_duration_ms=result.derivative_duration_ms,
                    )
                registry.mark_cancelled(
                    job_id,
                    f"processed={job.processed};total={job.total}",
                )
                return

        registry.mark_completed(job_id)
        task_metrics.record_gc(gc.collect())
    except Exception as exc:
        registry.mark_failed(job_id, str(exc) or type(exc).__name__)
