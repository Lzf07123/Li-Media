"""Bounded background probing for browser playback compatibility."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.models.admin import AdminBackgroundJob, AdminOperationLog
from app.models.memory import (
    BrowserCompatibilityState,
    Memory,
    MemoryFile,
    MemoryKind,
)
from app.services.baidu_pan import BaiduPanClient
from app.services.browser_compatibility import probe_memory_file_compatibility
from app.services.cache_invalidation import invalidate_nginx_proxy_cache
from app.services.task_limits import TaskRejected
from pathlib import Path


_cancel_requested: set[UUID] = set()


def request_cancel(job_id: UUID) -> bool:
    _cancel_requested.add(job_id)
    return True


def clear_cancel(job_id: UUID) -> None:
    _cancel_requested.discard(job_id)


def run_browser_compatibility_probe(
    session_factory: sessionmaker[Session],
    job_id: UUID,
    *,
    operator_session_id: UUID | None = None,
) -> None:
    clear_cancel(job_id)
    invalidated_cache_files = 0
    with session_factory() as db:
        job = db.get(AdminBackgroundJob, job_id)
        if job is None:
            return

        limit = int(job.total or 0)
        job.status = "running"
        job.started_at = datetime.now(timezone.utc)
        candidates = db.scalars(
            select(MemoryFile)
            .join(Memory, MemoryFile.memory_id == Memory.id)
            .where(
                MemoryFile.source == "baidupan",
                Memory.kind == MemoryKind.VIDEO,
                MemoryFile.browser_compatibility
                == BrowserCompatibilityState.UNKNOWN,
            )
            .order_by(Memory.created_at.desc(), Memory.id.desc())
            .limit(limit)
        ).all()
        job.total = len(candidates)
        job.resource_ids = [str(item.id) for item in candidates]
        db.commit()

        try:
            settings = get_settings()
            client = BaiduPanClient(settings)
            for memory_file in candidates:
                if job_id in _cancel_requested:
                    job.status = "cancelled"
                    job.completed_at = datetime.now(timezone.utc)
                    db.commit()
                    invalidated_cache_files = invalidate_nginx_proxy_cache()
                    clear_cancel(job_id)
                    _record_job_log(
                        db,
                        job,
                        operator_session_id,
                        invalidated_cache_files=invalidated_cache_files,
                    )
                    return

                job.processed += 1
                try:
                    probe_memory_file_compatibility(
                        db,
                        client,
                        memory_file,
                        media_root=Path(settings.media_root),
                    )
                except TaskRejected:
                    job.failed += 1
                    db.commit()
                    continue
                except Exception:
                    job.failed += 1
                    db.commit()
                    continue

                if memory_file.browser_compatibility == BrowserCompatibilityState.UNKNOWN:
                    job.skipped += 1
                else:
                    job.changed += 1
                db.commit()
                if memory_file.browser_compatibility != BrowserCompatibilityState.UNKNOWN:
                    invalidated_cache_files += invalidate_nginx_proxy_cache()

            job.status = "completed"
            job.completed_at = datetime.now(timezone.utc)
            db.commit()
            _record_job_log(
                db,
                job,
                operator_session_id,
                invalidated_cache_files=invalidated_cache_files,
            )
        except Exception as exc:
            db.rollback()
            job = db.get(AdminBackgroundJob, job_id)
            if job is not None:
                job.status = "failed"
                job.error_message = str(exc) or type(exc).__name__
                job.completed_at = datetime.now(timezone.utc)
                db.commit()
                _record_job_log(
                    db,
                    job,
                    operator_session_id,
                    invalidated_cache_files=0,
                )
        finally:
            clear_cancel(job_id)


def _record_job_log(
    db: Session,
    job: AdminBackgroundJob,
    operator_session_id: UUID | None,
    *,
    invalidated_cache_files: int,
) -> None:
    db.add(
        AdminOperationLog(
            action="browser_probe",
            target_type="memory_batch_job",
            target_id=job.id,
            detail=(
                f"job={job.id};status={job.status};total={job.total};"
                f"processed={job.processed};changed={job.changed};"
                f"skipped={job.skipped};failed={job.failed};"
                f"nginx_cache_files={invalidated_cache_files};"
                f"filters={json.dumps(job.filter_snapshot, ensure_ascii=False, sort_keys=True)};"
                f"resource_ids={json.dumps(job.resource_ids, separators=(',', ':'))}"
            ),
        )
    )
    db.commit()
