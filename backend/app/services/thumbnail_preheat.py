"""Bounded, manually-triggered thumbnail preheating."""

from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor, wait, FIRST_COMPLETED
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from threading import Event, Lock
from uuid import UUID, uuid4

from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker, Session

from app.core.config import Settings
from app.models.memory import (
    DerivativeFailureKind,
    Memory,
    MemoryFile,
    MemoryKind,
    MemoryStatus,
    RemoteThumbnailState,
)
from app.services.baidu_pan import BaiduPanClient, BaiduPanError
from app.services.derivative_tasks import (
    run_local_derivative,
    run_remote_derivative,
)
from app.services.memory_thumbnails import (
    derivative_cache_path,
    resolve_media_path,
)
from app.services.display_health import public_files_condition
from app.services.task_limits import TaskCancelled, TaskRejected, task_metrics
from app.services.task_limits import TaskType
from app.services.task_limits import task_limiter


@dataclass(slots=True)
class ThumbnailPreheatJob:
    id: UUID
    max_size: int
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
    message: str | None = None
    cancel_event: Event = field(default_factory=Event)
    created_at: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
    started_at: datetime | None = None
    completed_at: datetime | None = None


class ThumbnailPreheatRegistry:
    def __init__(self) -> None:
        self._jobs: dict[UUID, ThumbnailPreheatJob] = {}
        self._latest_id: UUID | None = None
        self._lock = Lock()

    def start(
        self,
        *,
        max_size: int,
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
                max_size=max_size,
                kind=kind,
                limit=limit,
                concurrency=max(1, concurrency),
                queue_limit=max(0, queue_limit),
            )
            self._jobs[job.id] = job
            self._latest_id = job.id
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
        outcome: str,
    ) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job.processed += 1
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


def _candidate_pairs(
    db: Session,
    *,
    kind: MemoryKind | None,
    limit: int,
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
    if kind is not None:
        statement = statement.where(Memory.kind == kind)

    statement = statement.where(
        MemoryFile.thumbnail_failure_kind.is_(None)
        | MemoryFile.thumbnail_failure_kind.not_in(NON_RETRYABLE_FAILURE_KINDS)
    )
    ordered_statement = (
        statement.order_by(Memory.captured_at.desc().nulls_last())
        .order_by(Memory.updated_at.desc())
        .order_by(Memory.id.desc())
    )
    if limit > 0:
        ordered_statement = ordered_statement.limit(limit)

    return [
        (memory_id, file_id)
        for memory_id, file_id in db.execute(ordered_statement).all()
    ]


def count_public_derivative_candidates(db: Session) -> int:
    """Count the same public display surface without leaking per-item data."""

    statement = (
        select(func.count(MemoryFile.id))
        .join(Memory, MemoryFile.memory_id == Memory.id)
        .where(
            Memory.status == MemoryStatus.PUBLISHED,
            MemoryFile.source == "baidupan",
            MemoryFile.remote_id.is_not(None),
            public_files_condition(),
        )
    )
    return int(db.scalar(statement) or 0)


def count_public_derivative_cache_hits(db: Session) -> int:
    """Count public files with a persisted derivative, independent of job history."""

    statement = (
        select(func.count(MemoryFile.id))
        .join(Memory, MemoryFile.memory_id == Memory.id)
        .where(
            Memory.status == MemoryStatus.PUBLISHED,
            MemoryFile.source == "baidupan",
            MemoryFile.remote_id.is_not(None),
            Memory.thumbnail_path.is_not(None),
            public_files_condition(),
        )
    )
    return int(db.scalar(statement) or 0)


def collect_public_preheat_status(
    db: Session,
    *,
    latest_job: ThumbnailPreheatJob | None,
) -> dict[str, int | str]:
    total = count_public_derivative_candidates(db)

    if latest_job is None:
        cache_hits = count_public_derivative_cache_hits(db)
        is_ready = total == 0 or cache_hits >= total
        return {
            "status": "ready" if is_ready else "not_preheated",
            "processed": total if is_ready else 0,
            "total": total,
        }

    processed = max(0, latest_job.processed)
    if latest_job.status in {"queued", "running"}:
        status = "running"
    elif latest_job.status == "completed":
        is_full_result = (
            latest_job.limit == 0 or processed >= max(1, total)
        ) and latest_job.failed == 0
        status = "ready" if is_full_result else "degraded"
    else:
        status = "degraded"

    return {"status": status, "processed": processed, "total": total}


def _process_pair(
    db: Session,
    *,
    memory_id: UUID,
    memory_file_id: UUID,
    settings: Settings,
    max_size: int,
    failure_sink: dict[str, str] | None = None,
    cancel_event: Event | None = None,
) -> str:
    memory = db.get(Memory, memory_id)
    memory_file = db.get(MemoryFile, memory_file_id)
    if (
        memory is None
        or memory_file is None
        or not memory_file.remote_id
    ):
        return "failed"

    media_root = Path(settings.media_root)
    target_path = derivative_cache_path(
        media_root,
        memory.id,
        max_size=max_size,
        version=settings.media_derivative_version,
    )
    if target_path.is_file():
        return "cached"

    local_source_path = resolve_media_path(media_root, memory_file.source_path or "")
    try:
        if local_source_path is not None and local_source_path.is_file():
            generated_path = run_local_derivative(
                local_source_path,
                media_root,
                memory=memory,
                max_size=max_size,
                duration_seconds=memory.duration_seconds,
                priority=60,
                failure_sink=failure_sink,
                cancel_event=cancel_event,
            )
        else:
            client = BaiduPanClient(settings)
            generated_path = run_remote_derivative(
                client,
                memory_file.remote_id,
                media_root,
                memory=memory,
                max_size=max_size,
                duration_seconds=memory.duration_seconds,
                priority=60,
                failure_sink=failure_sink,
                cancel_event=cancel_event,
                source_mime_type=memory_file.mime_type,
            )
    except TaskRejected:
        task_metrics.record_failed(TaskType.DERIVATIVE)
        return "failed"
    except BaiduPanError:
        task_metrics.record_failed(TaskType.DERIVATIVE)
        return "failed"

    if not generated_path:
        return "failed"

    memory.thumbnail_path = generated_path
    memory_file.thumbnail_state = RemoteThumbnailState.READY
    memory_file.thumbnail_failure_kind = None
    db.commit()
    return "generated"


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


def _process_candidate(
    session_factory: sessionmaker[Session],
    *,
    memory_id: UUID,
    memory_file_id: UUID,
    settings: Settings,
    max_size: int,
    cancel_event: Event,
) -> str:
    failure_sink: dict[str, str] = {}
    try:
        with task_limiter.slot(
            TaskType.PREHEAT,
            priority=60,
            cancel_event=cancel_event,
        ):
            with session_factory() as db:
                outcome = _process_pair(
                    db,
                    memory_id=memory_id,
                    memory_file_id=memory_file_id,
                    settings=settings,
                    max_size=max_size,
                    failure_sink=failure_sink,
                    cancel_event=cancel_event,
                )

        if outcome == "failed":
            task_metrics.record_failed(TaskType.PREHEAT)
            _mark_failure(
                session_factory,
                memory_file_id=memory_file_id,
                failure_kind=failure_sink.get("kind", "unknown"),
            )
        elif outcome == "cancelled":
            task_metrics.record_cancelled(TaskType.PREHEAT)
        else:
            task_metrics.record_completed(TaskType.PREHEAT)
        return outcome
    except TaskCancelled:
        task_metrics.record_cancelled(TaskType.PREHEAT)
        return "cancelled"
    except Exception:
        task_metrics.record_failed(TaskType.PREHEAT)
        _mark_failure(
            session_factory,
            memory_file_id=memory_file_id,
            failure_kind=failure_sink.get("kind", "unknown"),
        )
        return "failed"


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

        candidate_iterator = iter(pairs)
        futures: dict[Future[str], tuple[UUID, UUID]] = {}
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
                        max_size=job.max_size,
                        cancel_event=job.cancel_event,
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
                        outcome = future.result()
                    except Exception:
                        outcome = "failed"
                    registry.mark_item_processed(job_id, outcome=outcome)
                    if outcome == "cancelled":
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
                        outcome = future.result()
                    except Exception:
                        outcome = "failed"
                    registry.mark_item_processed(job_id, outcome=outcome)
                registry.mark_cancelled(
                    job_id,
                    f"processed={job.processed};total={job.total}",
                )
                return

        registry.mark_completed(job_id)
    except Exception as exc:
        registry.mark_failed(job_id, str(exc) or type(exc).__name__)
