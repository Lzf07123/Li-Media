"""Bounded, manually-triggered thumbnail preheating."""

from __future__ import annotations

import logging
import time
import gc
from concurrent.futures import Future, ThreadPoolExecutor, wait, FIRST_COMPLETED
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Event, Lock, Thread, local
from uuid import UUID, uuid4

from sqlalchemy import and_, distinct, exists, func, or_, select
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.sql.elements import ColumnElement

from app.core.config import Settings, get_settings
from app.models.memory import (
    DerivativeCacheStatus,
    DerivativeFailureKind,
    Memory,
    MemoryDerivativeCache,
    MemoryFile,
    MemoryKind,
    MemoryStatus,
    RemoteThumbnailState,
)
from app.services.baidu_pan import BaiduPanClient, BaiduPanError
from app.services.derivative_tasks import (
    run_local_derivative,
    run_local_derivatives,
)
from app.services.remote_thumbnails import (
    classify_remote_error,
    temporary_directory_has_capacity,
)
from app.services.memory_thumbnails import (
    classify_derivative_exception,
    derivative_cache_path,
    resolve_media_path,
)
from app.services.display_health import (
    PERMANENT_THUMBNAIL_FAILURE_KINDS,
    classify_thumbnail_failure_state,
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
    include_failed: bool = False
    status: str = "queued"
    total: int = 0
    processed: int = 0
    generated: int = 0
    cached: int = 0
    failed: int = 0
    skipped: int = 0
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
            str(size): {"generated": 0, "cached": 0, "failed": 0, "skipped": 0}
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
        include_failed: bool = False,
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
                include_failed=include_failed,
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
                    job.size_results[key] = {
                        "generated": 0,
                        "cached": 0,
                        "failed": 0,
                        "skipped": 0,
                    }
                job.size_results[key][
                    outcome
                    if outcome in {"generated", "cached", "failed", "skipped"}
                    else "failed"
                ] += 1
                if outcome == "generated":
                    job.generated += 1
                elif outcome == "cached":
                    job.cached += 1
                elif outcome == "failed":
                    job.failed += 1
                elif outcome == "skipped":
                    job.skipped += 1

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

NON_RETRYABLE_FAILURE_KINDS = PERMANENT_THUMBNAIL_FAILURE_KINDS


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
    if isinstance(result, str) and result in {
        "generated",
        "cached",
        "failed",
        "cancelled",
        "skipped",
    }:
        return PreheatCandidateResult(outcomes={size: result for size in sizes})
    return PreheatCandidateResult(outcomes={size: "failed" for size in sizes}, failure_kind="unknown")


def _candidate_statement(
    *,
    kind: MemoryKind | None,
    sizes: tuple[int, ...] | list[int] | None = None,
    derivative_version: str | None = None,
    include_failed: bool = False,
):
    """Shared candidate filters for enumeration and start-preview counting.

    口径与公开展示面一致（public_files_condition）：预热只为公开访客会
    看到的资源做远端下载，displayable 与浏览器兼容不达标的视频不预热。
    永久失败类型仍被显式排除（其失败不可自愈，重选无意义）。
    transient 失败冷却：RETRYABLE 且最近失败过的文件在冷却窗口内不再
    入选，防止 auto-preheat 每轮反复重下同一批坏文件；include_failed
    是管理端的逃生通道。
    """

    selected_sizes = tuple(dict.fromkeys(sizes or (HOME_PREHEAT_SIZE,)))
    version = derivative_version or get_settings().media_derivative_version
    missing_conditions = []
    for max_size in selected_sizes:
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
        missing_conditions.append(~(ready_cache | legacy_cache))

    statement = (
        select(Memory.id, MemoryFile.id)
        .join(MemoryFile, Memory.files)
        .where(
            Memory.status == MemoryStatus.PUBLISHED,
            MemoryFile.source == "baidupan",
            MemoryFile.remote_id.is_not(None),
            public_files_condition(),
            MemoryFile.thumbnail_failure_kind.is_(None)
            | MemoryFile.thumbnail_failure_kind.not_in(NON_RETRYABLE_FAILURE_KINDS),
            or_(*missing_conditions),
        )
    )
    if not include_failed:
        cooldown_seconds = get_settings().preheat_retry_cooldown_seconds
        if cooldown_seconds > 0:
            cooldown_cutoff = datetime.now(timezone.utc) - timedelta(
                seconds=cooldown_seconds
            )
            recently_failed = and_(
                MemoryFile.thumbnail_state == RemoteThumbnailState.RETRYABLE,
                MemoryFile.updated_at.is_not(None),
                MemoryFile.updated_at >= cooldown_cutoff,
            )
            statement = statement.where(~recently_failed)
    if kind is not None:
        statement = statement.where(Memory.kind == kind)
    return statement


def count_preheat_candidates(
    db: Session,
    *,
    kind: MemoryKind | None,
    sizes: tuple[int, ...] | list[int] | None = None,
    include_failed: bool = False,
) -> int:
    """Count deduplicated memories a preheat run would touch, for preview UI."""

    statement = _candidate_statement(
        kind=kind,
        sizes=sizes,
        include_failed=include_failed,
    )
    subquery = statement.subquery()
    return int(
        db.scalar(select(func.count(distinct(subquery.columns[0])))) or 0
    )


def _candidate_pairs(
    db: Session,
    *,
    kind: MemoryKind | None,
    limit: int,
    sizes: tuple[int, ...] | list[int] | None = None,
    derivative_version: str | None = None,
    include_failed: bool = False,
) -> list[tuple[UUID, UUID]]:
    statement = _candidate_statement(
        kind=kind,
        sizes=sizes,
        derivative_version=derivative_version,
        include_failed=include_failed,
    )
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


def home_derivative_ready_condition(
    *,
    max_size: int = HOME_PREHEAT_SIZE,
    derivative_version: str | None = None,
) -> ColumnElement[bool]:
    """SQL 判定：某条 memory 的首页尺寸派生图已持久化就绪。

    公开可见性与预热统计共用的唯一口径：存在 ``MemoryDerivativeCache``
    READY 行，或 legacy ``thumbnail_path`` 以 ``/{version}/{max_size}.webp``
    结尾（按需路由只对首页尺寸回填，后缀条件因此天然防 480/1280 污染）。
    在 ``Memory.files.any(...)`` 内使用时按 ``MemoryFile.id`` 关联。
    """

    version = derivative_version or get_settings().media_derivative_version
    return or_(
        exists(
            select(MemoryDerivativeCache.id).where(
                MemoryDerivativeCache.memory_file_id == MemoryFile.id,
                MemoryDerivativeCache.max_size == max_size,
                MemoryDerivativeCache.derivative_version == version,
                MemoryDerivativeCache.status == DerivativeCacheStatus.READY,
            )
        ),
        and_(
            Memory.thumbnail_path.is_not(None),
            Memory.thumbnail_path.endswith(f"/{version}/{max_size}.webp"),
        ),
    )


def count_public_derivative_cache_hits(
    db: Session,
    *,
    max_size: int = HOME_PREHEAT_SIZE,
    derivative_version: str | None = None,
) -> int:
    """Count public files with a persisted derivative, independent of job history."""

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
        .where(
            home_derivative_ready_condition(
                max_size=max_size,
                derivative_version=derivative_version,
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
    try:
        total = count_public_derivative_candidates(db)
        cache_hits = count_public_derivative_cache_hits(db)
    except Exception:
        # 聚合失败时降级为 unavailable，公开端点保持 200 而非 500。
        logger.exception("public preheat status aggregation failed")
        return {"status": "unavailable", "processed": 0, "total": 0}

    if _is_home_preheat_job(latest_job) and latest_job.status in {"queued", "running"}:
        return {
            "status": "running",
            "processed": max(0, latest_job.processed),
            # total 与 processed 同源（job 自身枚举数），避免与公开计数口径错位。
            "total": max(0, latest_job.total),
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
    media_root = Path(settings.media_root).resolve()
    resolved_output_path: Path | None = None
    relative_output_path: str | None = None
    if output_path is not None:
        resolved_output_path = (
            output_path if output_path.is_absolute() else Path.cwd() / output_path
        ).resolve()
        relative_output_path = resolved_output_path.relative_to(media_root).as_posix()

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
    cache.output_path = relative_output_path if status == DerivativeCacheStatus.READY else None
    cache.output_bytes = (
        resolved_output_path.stat().st_size
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
    # 单次下载的整体总时限：connect/read 超时之外兜底慢流，跨续传共享，
    # 避免长期占住预热 worker 与 tmp 配额。
    download_deadline = time.monotonic() + settings.source_download_timeout_seconds
    stream: object | None = None
    temporary_registered = False
    cleanup_path: Path | None = temporary_path
    written_bytes = 0
    # 断点续传：读流中断且已有进度时按 Range 续传，瞬时网络抖动不再
    # 作废整个下载；上限 2 次，重开前失效旧直链换新签名链接。
    resume_attempts = 0
    max_resume_attempts = 2

    try:
        if not temporary_directory_has_capacity(temporary_dir):
            failure_sink.setdefault("kind", DerivativeFailureKind.DISK_QUOTA.value)
            return None, 0

        while True:
            try:
                status_code, content_length, _, _, stream = client.open_stream(
                    remote_id,
                    range_header=(
                        f"bytes={written_bytes}-" if written_bytes else None
                    ),
                )
                if status_code is not None and status_code >= 400:
                    failure_sink.setdefault(
                        "kind",
                        DerivativeFailureKind.REMOTE_UNAVAILABLE.value,
                    )
                    return None, written_bytes
                if written_bytes and status_code != 206:
                    # 续传必须命中 206：服务器忽略 Range 会把整文件重发，
                    # 追加写会产生损坏文件。
                    failure_sink.setdefault(
                        "kind",
                        DerivativeFailureKind.REMOTE_UNAVAILABLE.value,
                    )
                    return None, written_bytes
                remaining_budget = max_source_bytes - written_bytes
                if content_length is not None and content_length > remaining_budget:
                    failure_sink.setdefault(
                        "kind",
                        DerivativeFailureKind.MOV_MOOV.value
                        if memory_file.mime_type == "video/quicktime"
                        else DerivativeFailureKind.SOURCE_TRUNCATED.value,
                    )
                    return None, written_bytes

                if not temporary_registered:
                    register_temporary_path(temporary_path.resolve())
                    temporary_registered = True

                with temporary_path.open("ab" if written_bytes else "wb") as output:
                    for chunk in stream.iter_bytes():
                        if cancel_event is not None and cancel_event.is_set():
                            failure_sink.setdefault(
                                "kind", DerivativeFailureKind.CANCELLED.value
                            )
                            return None, written_bytes
                        if time.monotonic() >= download_deadline:
                            failure_sink.setdefault(
                                "kind", DerivativeFailureKind.TIMEOUT.value
                            )
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
                    failure_sink.setdefault(
                        "kind", DerivativeFailureKind.TEMPORARY_EMPTY.value
                    )
                    return None, written_bytes
                cleanup_path = None
                return temporary_path, written_bytes
            except BaiduPanError as exc:
                if _should_resume_download(
                    cancel_event=cancel_event,
                    download_deadline=download_deadline,
                    resume_attempts=resume_attempts,
                    max_resume_attempts=max_resume_attempts,
                    written_bytes=written_bytes,
                ):
                    resume_attempts += 1
                    client.invalidate_download_url(remote_id)
                    _close_stream(stream)
                    stream = None
                    continue
                failure_sink.setdefault("kind", classify_remote_error(exc))
                return None, written_bytes
            except Exception as exc:
                if _should_resume_download(
                    cancel_event=cancel_event,
                    download_deadline=download_deadline,
                    resume_attempts=resume_attempts,
                    max_resume_attempts=max_resume_attempts,
                    written_bytes=written_bytes,
                ):
                    resume_attempts += 1
                    client.invalidate_download_url(remote_id)
                    _close_stream(stream)
                    stream = None
                    continue
                failure_sink.setdefault("kind", classify_remote_error(exc))
                return None, written_bytes
    finally:
        _close_stream(stream)
        if cleanup_path is not None:
            cleanup_path.unlink(missing_ok=True)
        if temporary_registered:
            unregister_temporary_path(temporary_path.resolve())


def _should_resume_download(
    *,
    cancel_event: Event | None,
    download_deadline: float,
    resume_attempts: int,
    max_resume_attempts: int,
    written_bytes: int,
) -> bool:
    """断点续传条件：已有进度、未取消、未超时、仍有续传额度。"""

    return (
        written_bytes > 0
        and resume_attempts < max_resume_attempts
        and (cancel_event is None or not cancel_event.is_set())
        and time.monotonic() < download_deadline
    )


def _close_stream(stream: object | None) -> None:
    if stream is not None and hasattr(stream, "close"):
        stream.close()


def _thread_local_client(settings: Settings) -> BaiduPanClient:
    """按 worker 线程惰性共享一个远端客户端。

    仅在候选真正需要远端下载时创建：纯本地源的预热不触碰百度凭证。
    线程随 executor 生命周期复用，客户端构造成本被摊薄。
    """

    client = getattr(_client_local, "client", None)
    if client is None:
        client = BaiduPanClient(settings)
        _client_local.client = client
    return client


_client_local = local()


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

    media_root = Path(settings.media_root).resolve()
    outcomes: dict[int, str] = {}
    failure_kind: str | None = None
    source_bytes_downloaded = 0
    derivative_duration_ms = 0
    downloaded_remote_source: Path | None = None

    # 本地源文件先解析一次：对账行回填真实 source_bytes，避免 0 失真。
    source_path: Path | None = resolve_media_path(
        media_root, memory_file.source_path or ""
    )
    if source_path is not None and not source_path.is_file():
        source_path = None
    local_source_bytes = (
        source_path.stat().st_size if source_path is not None else 0
    )

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
            source_bytes=local_source_bytes,
            duration_ms=0,
        )
        outcomes[max_size] = "cached"
        # 首页缩略图只认 240：detail 预热不得回填 thumbnail_path，
        # 避免公开列表拿到 480/1280 超大图。
        if max_size == HOME_PREHEAT_SIZE:
            memory.thumbnail_path = target_path.relative_to(media_root).as_posix()

    if len(outcomes) == len(sizes):
        memory_file.thumbnail_state = RemoteThumbnailState.READY
        memory_file.thumbnail_failure_kind = None
        db.commit()
        return PreheatCandidateResult(outcomes=outcomes)

    if source_path is None:
        remote_failure_sink: dict[str, str] = {}
        remote_client = client or _thread_local_client(settings)
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
            memory_file.thumbnail_state = classify_thumbnail_failure_state(failure_kind)
            memory_file.thumbnail_failure_kind = failure_kind or "unknown"
            db.commit()
            return PreheatCandidateResult(
                outcomes={size: "failed" for size in sizes},
                source_bytes_downloaded=source_bytes_downloaded,
                failure_kind=failure_kind or "unknown",
            )
        downloaded_remote_source = source_path
        register_temporary_path(downloaded_remote_source.resolve())

    try:
        missing_sizes: list[int] = []
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
                    source_bytes=local_source_bytes,
                    duration_ms=0,
                )
                outcomes[max_size] = "cached"
                continue
            missing_sizes.append(max_size)

        # 批量派生：缺失尺寸共用一次 DERIVATIVE 槽位，照片单次解码、
        # WebP/视频单次 ffmpeg 多输出；单尺寸缺失场景仍走原单尺寸路径。
        generated_paths: dict[int, str | None] = {}
        duration_ms = 0
        if missing_sizes:
            if cancel_event is not None and cancel_event.is_set():
                failure_sink = {
                    "kind": DerivativeFailureKind.CANCELLED.value,
                }
                generated_paths = {max_size: None for max_size in missing_sizes}
            else:
                failure_sink = {}
                started_at = time.monotonic()
                try:
                    if len(missing_sizes) == 1:
                        generated_path = run_local_derivative(
                            source_path,
                            media_root,
                            memory=memory,
                            max_size=missing_sizes[0],
                            duration_seconds=memory.duration_seconds,
                            priority=60,
                            failure_sink=failure_sink,
                            cancel_event=cancel_event,
                        )
                        generated_paths = {missing_sizes[0]: generated_path}
                    else:
                        generated_paths = run_local_derivatives(
                            source_path,
                            media_root,
                            memory=memory,
                            max_sizes=missing_sizes,
                            duration_seconds=memory.duration_seconds,
                            priority=60,
                            failure_sink=failure_sink,
                            cancel_event=cancel_event,
                        )
                except TaskRejected:
                    task_metrics.record_failed(TaskType.DERIVATIVE)
                    failure_sink.setdefault(
                        "kind",
                        DerivativeFailureKind.QUEUE_REJECTED.value,
                    )
                    generated_paths = {
                        max_size: None for max_size in missing_sizes
                    }
                duration_ms = int((time.monotonic() - started_at) * 1000)
            derivative_duration_ms += duration_ms

        for max_size in missing_sizes:
            generated_path = generated_paths.get(max_size)
            if not generated_path:
                failure_kind = failure_sink.get("kind", "unknown")
                _set_derivative_cache_state(
                    db,
                    memory_file_id=memory_file_id,
                    settings=settings,
                    max_size=max_size,
                    status=DerivativeCacheStatus.FAILED,
                    failure_kind=failure_kind,
                    source_bytes=local_source_bytes,
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
                source_bytes=local_source_bytes,
                duration_ms=duration_ms,
            )
            outcomes[max_size] = "generated"
            if max_size == HOME_PREHEAT_SIZE:
                memory.thumbnail_path = generated_path

        if any(outcome in {"generated", "cached"} for outcome in outcomes.values()):
            memory_file.thumbnail_state = RemoteThumbnailState.READY
            memory_file.thumbnail_failure_kind = None
        else:
            memory_file.thumbnail_state = classify_thumbnail_failure_state(failure_kind)
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
                memory_file.thumbnail_state = classify_thumbnail_failure_state(failure_kind)
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


def _process_candidate_attempt(
    session_factory: sessionmaker[Session],
    *,
    memory_id: UUID,
    memory_file_id: UUID,
    settings: Settings,
    sizes: tuple[int, ...],
    cancel_event: Event | None = None,
    client: BaiduPanClient | None = None,
) -> PreheatCandidateResult:
    with task_limiter.slot(
        TaskType.PREHEAT,
        priority=60,
        cancel_event=cancel_event,
    ):
        with session_factory() as db:
            return _process_pair_sizes(
                db,
                memory_id=memory_id,
                memory_file_id=memory_file_id,
                settings=settings,
                sizes=sizes,
                cancel_event=cancel_event,
                client=client,
            )


def _process_candidate(
    session_factory: sessionmaker[Session],
    *,
    memory_id: UUID,
    memory_file_id: UUID,
    settings: Settings,
    sizes: tuple[int, ...],
    cancel_event: Event | None = None,
    client: BaiduPanClient | None = None,
) -> PreheatCandidateResult:
    try:
        result = _process_candidate_attempt(
            session_factory,
            memory_id=memory_id,
            memory_file_id=memory_file_id,
            settings=settings,
            sizes=sizes,
            cancel_event=cancel_event,
            client=client,
        )

        # token 失效自愈：线程本地客户端固化了构造时的 access_token 快照，
        # 长预热中途 token 轮换会让该线程后续全部 remote_auth 失败。整候选
        # 认证失败时重置线程本地客户端（新客户端构造即自动 refresh）并重试
        # 一次；磁盘对账保证已写尺寸不重复派生。
        if (
            all(outcome == "failed" for outcome in result.outcomes.values())
            and result.failure_kind == DerivativeFailureKind.REMOTE_AUTH.value
        ):
            _client_local.client = None
            result = _process_candidate_attempt(
                session_factory,
                memory_id=memory_id,
                memory_file_id=memory_file_id,
                settings=settings,
                sizes=sizes,
                cancel_event=cancel_event,
                client=None,
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
    except TaskRejected:
        # 全局 PREHEAT 队列满：本轮跳过，不写失败状态与 FAILED 缓存行，
        # 候选条件基于缓存 NOT-EXISTS，下次预热会自然重选。
        task_metrics.record_rejected(TaskType.PREHEAT)
        return PreheatCandidateResult(
            outcomes={size: "skipped" for size in sizes},
        )
    except Exception as exc:
        logger.exception(
            "thumbnail preheat candidate failed; memory_id=%s file_id=%s",
            memory_id,
            memory_file_id,
        )
        failure_kind = classify_derivative_exception(exc)
        task_metrics.record_failed(TaskType.PREHEAT)
        _mark_failure(
            session_factory,
            memory_file_id=memory_file_id,
            failure_kind=failure_kind,
        )
        _mark_unexpected_cache_failure(
            session_factory,
            memory_file_id=memory_file_id,
            sizes=sizes,
            settings=settings,
            failure_kind=failure_kind,
        )
        return PreheatCandidateResult(
            outcomes={size: "failed" for size in sizes},
            failure_kind=failure_kind,
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
                sizes=job.sizes,
                include_failed=job.include_failed,
            )
        registry.mark_running(job_id, total=len(pairs))
        # 枚举可能耗时（大库 × 多尺寸 NOT-EXISTS），期间用户可能已取消：
        # 进入处理循环前补一次取消检查，避免空跑。
        if job.cancel_event.is_set():
            registry.mark_cancelled(job_id, f"processed=0;total={len(pairs)}")
            return

        # 说明：不做 count 先行回填 total，也不做分页流式枚举——count 查询
        # 与枚举同价，无显示收益；候选集合会随处理实时收缩，OFFSET 分页会
        # 成批跳项，keyset 分页在 nulls_last 排序上复杂度不成比例。候选仅
        # 物化 (memory_id, file_id) 元组，内存开销可忽略。
        # 队列深度单层记账：executor 在途上限与全局 PREHEAT 槽位容量同源
        # （concurrency + queue_limit 读同一组配置），worker 只在取全局槽位
        # 时排队；limiter 同时充当指标观测面（系统状态“预热调度”）。
        # 远端客户端按线程惰性创建：只有真正需要下载的候选才触碰凭证，
        # 纯本地源的预热无需百度凭证即可运行；open_stream 的流式下载本身
        # 并发，0.2s 请求间隔只在发起请求时生效，限流压力有界。
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
                        client=None,
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


def start_auto_preheat_after_scan(
    *,
    session_factory: sessionmaker[Session],
    settings: Settings,
    registry: ThumbnailPreheatRegistry = thumbnail_preheat_registry,
) -> ThumbnailPreheatJob | None:
    """扫描完成后自动预热首页 240 缩略图，消除公开访客首次加载的慢窗口。

    单飞注册表保证与手动预热互斥：已有任务在跑时静默跳过本次自动触发。
    """

    if not settings.preheat_auto_after_scan:
        return None

    job, started = registry.start(
        sizes=(HOME_PREHEAT_SIZE,),
        kind=None,
        limit=0,
        concurrency=settings.preheat_concurrency_limit,
        queue_limit=settings.preheat_queue_limit,
    )
    if not started:
        return None

    thread = Thread(
        target=run_thumbnail_preheat,
        kwargs={
            "job_id": job.id,
            "session_factory": session_factory,
            "settings": settings,
            "registry": registry,
        },
        name="limedia-preheat-auto",
        daemon=True,
    )
    thread.start()
    return job
