"""Bounded, manually-triggered thumbnail preheating."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.orm import sessionmaker, Session

from app.core.config import Settings
from app.models.memory import (
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
from app.services.task_limits import TaskRejected, task_metrics
from app.services.task_limits import TaskType


@dataclass(slots=True)
class ThumbnailPreheatJob:
    id: UUID
    max_size: int
    kind: MemoryKind | None
    limit: int
    status: str = "queued"
    total: int = 0
    processed: int = 0
    generated: int = 0
    cached: int = 0
    failed: int = 0
    message: str | None = None
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


thumbnail_preheat_registry = ThumbnailPreheatRegistry()


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
        .order_by(Memory.captured_at.desc().nulls_last())
        .order_by(Memory.updated_at.desc())
        .limit(limit)
    )
    if kind is not None:
        statement = statement.where(Memory.kind == kind)

    return [(memory_id, file_id) for memory_id, file_id in db.execute(statement).all()]


def _process_pair(
    db: Session,
    *,
    memory_id: UUID,
    memory_file_id: UUID,
    settings: Settings,
    max_size: int,
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
    db.commit()
    return "generated"


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

    try:
        with session_factory() as db:
            pairs = _candidate_pairs(
                db,
                kind=job.kind,
                limit=job.limit,
            )
        registry.mark_running(job_id, total=len(pairs))

        for memory_id, memory_file_id in pairs:
            with session_factory() as db:
                outcome = _process_pair(
                    db,
                    memory_id=memory_id,
                    memory_file_id=memory_file_id,
                    settings=settings,
                    max_size=job.max_size,
                )
            registry.mark_item_processed(job_id, outcome=outcome)

        registry.mark_completed(job_id)
    except Exception as exc:
        registry.mark_failed(job_id, str(exc) or type(exc).__name__)
