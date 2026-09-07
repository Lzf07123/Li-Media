"""Bounded, resumable batch status operations for the admin media list."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.models.admin import AdminBackgroundJob, AdminOperationLog
from app.models.memory import Memory, MemoryFile, MemoryStatus


BATCH_SIZE = 100
_cancel_requested: set[UUID] = set()


def request_cancel(job_id: UUID) -> bool:
    _cancel_requested.add(job_id)
    return True


def clear_cancel(job_id: UUID) -> None:
    _cancel_requested.discard(job_id)


def run_batch_status_job(
    session_factory: sessionmaker[Session],
    job_id: UUID,
    *,
    target_status: MemoryStatus,
    operator_session_id: UUID | None = None,
) -> None:
    clear_cancel(job_id)

    with session_factory() as db:
        job = db.get(AdminBackgroundJob, job_id)
        if job is None:
            return

        job.status = "running"
        job.started_at = datetime.now(timezone.utc)
        db.commit()

        try:
            resource_ids = [UUID(value) for value in (job.resource_ids or [])]
            job.total = len(resource_ids)
            db.commit()

            for offset in range(0, len(resource_ids), BATCH_SIZE):
                if job_id in _cancel_requested:
                    job.status = "cancelled"
                    job.completed_at = datetime.now(timezone.utc)
                    db.commit()
                    clear_cancel(job_id)
                    _record_job_log(db, job, operator_session_id)
                    return

                chunk = resource_ids[offset : offset + BATCH_SIZE]
                memories = db.scalars(
                    select(Memory).where(Memory.id.in_(chunk))
                ).all()
                memory_by_id = {memory.id: memory for memory in memories}

                for memory_id in chunk:
                    job.processed += 1
                    memory = memory_by_id.get(memory_id)
                    has_remote_file = memory is not None and any(
                        memory_file.source == "baidupan"
                        for memory_file in memory.files
                    )
                    if memory is None or not has_remote_file:
                        job.failed += 1
                        continue
                    if memory.status == target_status:
                        job.skipped += 1
                        continue

                    memory.status = target_status
                    job.changed += 1

                db.commit()

            job.status = "completed"
            job.completed_at = datetime.now(timezone.utc)
            db.commit()
            _record_job_log(db, job, operator_session_id)
        except Exception as exc:
            db.rollback()
            job = db.get(AdminBackgroundJob, job_id)
            if job is not None:
                job.status = "failed"
                job.error_message = str(exc) or type(exc).__name__
                job.completed_at = datetime.now(timezone.utc)
                db.commit()
                _record_job_log(db, job, operator_session_id)
        finally:
            clear_cancel(job_id)


def _record_job_log(
    db: Session,
    job: AdminBackgroundJob,
    operator_session_id: UUID | None,
) -> None:
    action = (
        "batch_publish"
        if "publish" in job.action
        else "batch_hide"
        if "hidden" in job.action or "hide" in job.action
        else job.action
    )
    db.add(
        AdminOperationLog(
            action=action[:32],
            target_type="memory_batch_job",
            target_id=job.id,
            detail=(
                f"job={job.id};status={job.status};total={job.total};"
                f"processed={job.processed};changed={job.changed};"
                f"skipped={job.skipped};failed={job.failed};"
                f"filters={json.dumps(job.filter_snapshot, ensure_ascii=False, sort_keys=True)};"
                f"resource_ids={json.dumps(job.resource_ids, separators=(',', ':'))}"
            ),
        )
    )
    db.commit()
