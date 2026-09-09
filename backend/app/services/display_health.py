"""Shared rules for whether a remote memory is safe to show publicly."""

from __future__ import annotations

from sqlalchemy import and_, or_

from app.models.memory import (
    Memory,
    MemoryFile,
    MemoryKind,
    BrowserCompatibilityState,
    RemoteFileState,
    RemoteStreamState,
    RemoteThumbnailState,
)

MediaDisplayState = str

PERMANENT_THUMBNAIL_FAILURE_KINDS = frozenset(
    {
        "source_truncated",
        "mov_moov",
        "codec_unsupported",
        "format_unsupported",
    }
)


def classify_thumbnail_failure_state(
    failure_kind: str | None,
) -> RemoteThumbnailState:
    """Keep transient preview errors visible and retryable."""

    if failure_kind in PERMANENT_THUMBNAIL_FAILURE_KINDS:
        return RemoteThumbnailState.FAILED
    return RemoteThumbnailState.RETRYABLE


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


def browser_playable_files_condition() -> object:
    """Public condition excludes unsupported and unknown videos only."""

    return and_(
        MemoryFile.source == "baidupan",
        or_(
            Memory.kind == MemoryKind.PHOTO,
            and_(
                Memory.kind == MemoryKind.VIDEO,
                MemoryFile.browser_compatibility
                == BrowserCompatibilityState.SUPPORTED,
            ),
        ),
    )


def public_files_condition() -> object:
    """Display health and browser compatibility must both pass for public media."""

    return and_(
        displayable_files_condition(),
        browser_playable_files_condition(),
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


def get_public_visibility_state(memory: Memory) -> str:
    """Classify the final public surface; excluded is intentionally opaque."""

    if get_media_display_state(memory) != "displayable":
        return "excluded"
    if memory.kind != MemoryKind.VIDEO:
        return "displayable"
    primary_file = memory.files[0] if memory.files else None
    if (
        primary_file is None
        or primary_file.browser_compatibility
        != BrowserCompatibilityState.SUPPORTED
    ):
        return "excluded"
    return "displayable"
