"""Shared rules for whether a remote memory is safe to show publicly."""

from __future__ import annotations

from sqlalchemy import and_, or_

from app.models.memory import (
    Memory,
    MemoryFile,
    MemoryKind,
    RemoteFileState,
    RemoteStreamState,
    RemoteThumbnailState,
)

MediaDisplayState = str


def displayable_files_condition() -> object:
    """Return a SQLAlchemy condition for memories with a usable public surface."""

    return and_(
        MemoryFile.source == "baidupan",
        MemoryFile.remote_state == RemoteFileState.READY,
        or_(
            and_(
                Memory.kind == MemoryKind.PHOTO,
                or_(
                    MemoryFile.thumbnail_state != RemoteThumbnailState.FAILED,
                    Memory.thumbnail_path.is_not(None),
                ),
            ),
            and_(
                Memory.kind == MemoryKind.VIDEO,
                MemoryFile.stream_state != RemoteStreamState.FAILED,
            ),
        ),
    )


def get_media_display_state(memory: Memory) -> MediaDisplayState:
    """Classify one memory for public rendering and admin diagnostics."""

    primary_file = memory.files[0] if memory.files else None
    if (
        primary_file is None
        or primary_file.source != "baidupan"
        or primary_file.remote_state != RemoteFileState.READY
    ):
        return "excluded"

    if memory.kind == MemoryKind.PHOTO:
        has_cached_derivative = memory.thumbnail_path is not None
        if (
            primary_file.thumbnail_state == RemoteThumbnailState.FAILED
            and not has_cached_derivative
        ):
            return "excluded"
        return "displayable"

    if memory.kind == MemoryKind.VIDEO:
        if primary_file.stream_state == RemoteStreamState.FAILED:
            return "excluded"
        return "displayable"

    return "excluded"
