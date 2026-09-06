"""Audit that media is only indexed remotely and no source files remain."""

from __future__ import annotations

from collections import Counter
from pathlib import Path

from sqlalchemy import LargeBinary, func, select
from sqlalchemy.orm import Session

from app.models.memory import Memory, MemoryFile
from app.schemas.memory import MemoryRead, MemorySummaryRead


SOURCE_MEDIA_EXTENSIONS = frozenset(
    {
        ".avi",
        ".gif",
        ".heic",
        ".jpeg",
        ".jpg",
        ".m4a",
        ".mkv",
        ".mov",
        ".mp3",
        ".mp4",
        ".png",
        ".wav",
        ".webm",
    }
)
DERIVATIVE_DIRECTORIES = frozenset({"thumbnails", "tmp"})


def collect_source_zero_status(db: Session, media_root: Path) -> dict[str, object]:
    """Return bounded source-storage counters without exposing file names."""

    source_path_count = db.scalar(
        select(func.count())
        .select_from(MemoryFile)
        .where(MemoryFile.source_path != "")
    )
    binary_columns = [
        (model, column)
        for model in (Memory, MemoryFile)
        for column in model.__table__.columns
        if isinstance(column.type, LargeBinary)
    ]
    database_blob_count = sum(
        db.scalar(
            select(func.count())
            .select_from(model)
            .where(column.is_not(None))
        )
        or 0
        for model, column in binary_columns
    )
    extension_counts: Counter[str] = Counter()
    media_photos_files = 0
    media_videos_files = 0
    unexpected_media_files = 0
    temporary_files = 0
    scan_failed = False

    try:
        if media_root.exists():
            for path in media_root.rglob("*"):
                if not path.is_file():
                    continue

                top_level = path.relative_to(media_root).parts[0]
                suffix = path.suffix.lower()
                if suffix in SOURCE_MEDIA_EXTENSIONS:
                    extension_counts[suffix] += 1
                if top_level == "tmp":
                    temporary_files += 1
                elif top_level == "photos":
                    media_photos_files += 1
                elif top_level == "videos":
                    media_videos_files += 1
                elif top_level not in DERIVATIVE_DIRECTORIES:
                    unexpected_media_files += 1
    except OSError:
        scan_failed = True

    source_path_schema_exposed = "source_path" in (
        MemoryRead.model_fields | MemorySummaryRead.model_fields
    )
    compliant = not any(
            [
                scan_failed,
                source_path_count,
            source_path_schema_exposed,
            database_blob_count,
            extension_counts,
            media_photos_files,
            media_videos_files,
            unexpected_media_files,
        ]
    )

    return {
        "compliant": compliant,
        "source_path_count": int(source_path_count or 0),
        "source_path_schema_exposed": source_path_schema_exposed,
        "database_blob_count": int(database_blob_count),
        "source_media_file_count": sum(extension_counts.values()),
        "source_media_extensions": dict(sorted(extension_counts.items())),
        "media_photos_file_count": media_photos_files,
        "media_videos_file_count": media_videos_files,
        "unexpected_media_file_count": unexpected_media_files,
        "temporary_file_count": temporary_files,
        "filesystem_scan_failed": scan_failed,
    }
