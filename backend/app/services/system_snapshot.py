"""Bounded operational snapshot used before and after iteration experiments."""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.memory import Memory, MemoryFile, RemoteScanTask
from app.services.resource_metrics import collect_resource_metrics
from app.services.source_zero import collect_source_zero_status


PERCENTILES = (50, 90, 95, 99)


def _percentile(db: Session, percentile: int, total: int) -> int | None:
    if total == 0:
        return None
    offset = max(0, (total * percentile + 99) // 100 - 1)
    return db.scalar(
        select(MemoryFile.size_bytes)
        .where(MemoryFile.size_bytes.is_not(None))
        .order_by(MemoryFile.size_bytes.asc())
        .offset(offset)
        .limit(1)
    )


def collect_system_snapshot(
    db: Session,
    media_root: Path,
    *,
    preheat_latest: dict[str, object] | None = None,
) -> dict[str, object]:
    kind_rows = db.execute(
        select(Memory.kind, func.count())
        .group_by(Memory.kind)
    ).all()
    kind_counts = {str(kind): int(count) for kind, count in kind_rows}
    total = sum(kind_counts.values())

    published = db.scalar(
        select(func.count())
        .select_from(Memory)
        .where(Memory.status == "published")
    ) or 0

    indexed_files = db.scalar(select(func.count(MemoryFile.id))) or 0
    indexed_bytes = db.scalar(
        select(func.coalesce(func.sum(MemoryFile.size_bytes), 0))
    ) or 0
    size_percentiles = {
        f"p{percentile}": _percentile(db, percentile, indexed_files)
        for percentile in PERCENTILES
    }

    thumbnail_rows = db.execute(
        select(MemoryFile.thumbnail_state, func.count())
        .group_by(MemoryFile.thumbnail_state)
    ).all()
    thumbnail_states = {
        str(state): int(count)
        for state, count in thumbnail_rows
    }
    failure_rows = db.execute(
        select(MemoryFile.thumbnail_failure_kind, func.count())
        .where(MemoryFile.thumbnail_state == "failed")
        .group_by(MemoryFile.thumbnail_failure_kind)
    ).all()
    thumbnail_failures = {
        str(kind if kind is not None else "unclassified"): int(count)
        for kind, count in failure_rows
    }

    latest_scan = db.scalar(
        select(RemoteScanTask)
        .order_by(RemoteScanTask.started_at.desc())
        .limit(1)
    )

    return {
        "memories": {
            "total": total,
            "published": int(published),
            **{"kinds": kind_counts},
        },
        "index": {
            "files": int(indexed_files),
            "bytes": int(indexed_bytes),
            "size_percentiles": size_percentiles,
        },
        "thumbnails": {
            "states": thumbnail_states,
            "failure_kinds": thumbnail_failures,
        },
        "latest_scan": (
            {
                "status": str(latest_scan.status),
                "has_cursor": latest_scan.cursor is not None,
                "failure_reason": latest_scan.failure_reason,
                "scanned_files": latest_scan.scanned_files,
                "started_at": latest_scan.started_at.isoformat(),
                "completed_at": (
                    latest_scan.completed_at.isoformat()
                    if latest_scan.completed_at
                    else None
                ),
            }
            if latest_scan
            else None
        ),
        "preheat_latest": preheat_latest,
        "source_zero": collect_source_zero_status(db, media_root),
        "resources": collect_resource_metrics(media_root),
    }
