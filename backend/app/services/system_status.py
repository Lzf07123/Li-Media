"""Assemble admin-facing backend, remote-storage and resource status."""

from __future__ import annotations

import os
import platform
from datetime import datetime, timezone
from pathlib import Path

import redis
from sqlalchemy import case, func, select, text
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models.memory import (
    MemoryFile,
    RemoteFileState,
    RemoteScanTask,
    RemoteStreamState,
    RemoteThumbnailState,
)
from app.schemas.responses import (
    AdminSystemStatusResponse,
    BackendRuntimeStatus,
    RemoteStorageCounts,
    RemoteStorageStatus,
    ResourceStatus,
    ResourceRuntimeConfiguration,
    ServiceStatus,
    SourceZeroStatus,
    TaskQueueStatus,
)
from app.services.baidu_oauth import load_baidu_credentials
from app.services.baidu_pan import download_url_cache
from app.services.resource_metrics import collect_resource_metrics
from app.services.source_zero import collect_source_zero_status
from app.services.task_limits import task_limiter, task_metrics


def _database_status(db: Session) -> ServiceStatus:
    engine = db.get_bind()
    try:
        db.execute(text("SELECT 1"))
        return ServiceStatus(
            status="ok",
            dialect=engine.dialect.name,
            pool_status=engine.pool.status(),
        )
    except Exception as exc:
        return ServiceStatus(status="unavailable", detail=type(exc).__name__)


def get_redis_status(redis_url: str) -> ServiceStatus:
    client = redis.Redis.from_url(
        redis_url,
        decode_responses=True,
        socket_connect_timeout=1,
        socket_timeout=2,
    )
    try:
        client.ping()
        info = client.info()
        max_memory = int(info.get("maxmemory") or 0)
        return ServiceStatus(
            status="ok",
            detail=str(info.get("redis_version") or ""),
            used_memory_bytes=int(info.get("used_memory") or 0),
            max_memory_bytes=max_memory or None,
            connected_clients=int(info.get("connected_clients") or 0),
        )
    except Exception as exc:
        return ServiceStatus(status="unavailable", detail=type(exc).__name__)
    finally:
        client.close()


def _remote_storage_counts(db: Session) -> RemoteStorageCounts:
    total, remote_ready, remote_missing, remote_failed, thumbnail_ready, thumbnail_missing, thumbnail_failed, stream_ready, stream_failed = db.execute(
        select(
            func.count(MemoryFile.id),
            func.sum(
                case(
                    (MemoryFile.remote_state == RemoteFileState.READY, 1),
                    else_=0,
                )
            ),
            func.sum(
                case(
                    (MemoryFile.remote_state == RemoteFileState.MISSING, 1),
                    else_=0,
                )
            ),
            func.sum(
                case(
                    (MemoryFile.remote_state == RemoteFileState.FAILED, 1),
                    else_=0,
                )
            ),
            func.sum(
                case(
                    (
                        MemoryFile.thumbnail_state == RemoteThumbnailState.READY,
                        1,
                    ),
                    else_=0,
                )
            ),
            func.sum(
                case(
                    (
                        MemoryFile.thumbnail_state == RemoteThumbnailState.MISSING,
                        1,
                    ),
                    else_=0,
                )
            ),
            func.sum(
                case(
                    (
                        MemoryFile.thumbnail_state == RemoteThumbnailState.FAILED,
                        1,
                    ),
                    else_=0,
                )
            ),
            func.sum(
                case(
                    (MemoryFile.stream_state == RemoteStreamState.READY, 1),
                    else_=0,
                )
            ),
            func.sum(
                case(
                    (MemoryFile.stream_state == RemoteStreamState.FAILED, 1),
                    else_=0,
                )
            ),
        ).where(MemoryFile.source == "baidupan")
    ).one()
    failure_kind_rows = db.execute(
        select(
            MemoryFile.thumbnail_failure_kind,
            func.count(),
        )
        .where(
            MemoryFile.source == "baidupan",
            MemoryFile.thumbnail_state == RemoteThumbnailState.FAILED,
        )
        .group_by(MemoryFile.thumbnail_failure_kind)
    ).all()

    return RemoteStorageCounts(
        total=int(total or 0),
        remote_ready=int(remote_ready or 0),
        remote_missing=int(remote_missing or 0),
        remote_failed=int(remote_failed or 0),
        thumbnail_ready=int(thumbnail_ready or 0),
        thumbnail_missing=int(thumbnail_missing or 0),
        thumbnail_failed=int(thumbnail_failed or 0),
        thumbnail_failure_kinds={
            str(kind if kind is not None else "unclassified"): int(count)
            for kind, count in failure_kind_rows
        },
        stream_ready=int(stream_ready or 0),
        stream_failed=int(stream_failed or 0),
    )


def _remote_storage_status(
    db: Session,
    settings: Settings,
) -> RemoteStorageStatus:
    credentials = load_baidu_credentials(settings)
    last_scan = db.scalar(
        select(RemoteScanTask).order_by(RemoteScanTask.started_at.desc())
    )
    return RemoteStorageStatus(
        provider="baidupan",
        configured=bool(credentials or settings.baidu_access_token),
        oauth_configured=bool(
            settings.baidu_oauth_client_id and settings.baidu_oauth_client_secret
        ),
        authorized=credentials is not None,
        scan_dir=settings.baidu_sync_dir,
        token_expires_at=credentials.expires_at if credentials else None,
        direct_link_cache_entries=download_url_cache.size(),
        counts=_remote_storage_counts(db),
        last_scan=last_scan if last_scan is not None else None,
    )


def collect_system_status(
    db: Session,
    *,
    settings: Settings,
    redis_status: ServiceStatus | None = None,
) -> AdminSystemStatusResponse:
    tasks = {
        task_type: TaskQueueStatus(**values)
        for task_type, values in task_limiter.stats().items()
    }
    metrics = {
        key: int(value)
        for key, value in task_metrics.snapshot().items()
        if isinstance(value, int)
    }

    return AdminSystemStatusResponse(
        generated_at=datetime.now(timezone.utc),
        backend=BackendRuntimeStatus(
            app_name=settings.project_name,
            version=settings.version,
            python_version=platform.python_version(),
            platform=platform.system(),
            pid=os.getpid(),
            database=_database_status(db),
            redis=redis_status or get_redis_status(settings.redis_url),
            task_thread_pool_size=settings.task_thread_pool_size,
            stack_guard="task thread pool + cgroup memory + pids limit",
            configuration=ResourceRuntimeConfiguration(
                preheat_concurrency_limit=settings.preheat_concurrency_limit,
                preheat_queue_limit=settings.preheat_queue_limit,
                preheat_wait_timeout_seconds=settings.preheat_wait_timeout_seconds,
                derivative_concurrency_limit=settings.derivative_concurrency_limit,
                derivative_queue_limit=settings.derivative_queue_limit,
                derivative_wait_timeout_seconds=settings.derivative_wait_timeout_seconds,
                direct_probe_concurrency_limit=settings.direct_probe_concurrency_limit,
                direct_probe_queue_limit=settings.direct_probe_queue_limit,
                scan_concurrency_limit=settings.scan_concurrency_limit,
                stream_global_concurrency_limit=settings.stream_global_concurrency_limit,
                stream_user_concurrency_limit=settings.stream_user_concurrency_limit,
                temp_max_files=settings.remote_thumbnail_max_temp_files,
                temp_disk_quota_bytes=settings.remote_thumbnail_disk_quota_bytes,
            ),
        ),
        remote_storage=_remote_storage_status(db, settings),
        source_zero=SourceZeroStatus(
            **collect_source_zero_status(db, Path(settings.media_root))
        ),
        tasks=tasks,
        metrics=metrics,
        resources=ResourceStatus(
            **collect_resource_metrics(
                Path(settings.media_root),
                backend_memory_limit_bytes=settings.backend_memory_limit_bytes,
                temp_disk_quota_bytes=settings.remote_thumbnail_disk_quota_bytes,
                temp_max_files=settings.remote_thumbnail_max_temp_files,
                nginx_cache_root=Path(settings.nginx_cache_root),
            )
        ),
    )
