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


def _file_display_ok(memory: Memory, memory_file: MemoryFile) -> bool:
    """Per-file mirror of displayable_files_condition() for in-memory rows."""

    if memory_file.source != "baidupan":
        return False
    if memory_file.remote_state != RemoteFileState.READY:
        return False

    if memory.kind == MemoryKind.PHOTO:
        return (
            memory_file.thumbnail_state != RemoteThumbnailState.FAILED
            or memory.thumbnail_path is not None
        )
    if memory.kind == MemoryKind.VIDEO:
        return memory_file.stream_state != RemoteStreamState.FAILED
    return False


def _file_browser_ok(memory: Memory, memory_file: MemoryFile) -> bool:
    """Per-file mirror of browser_playable_files_condition()."""

    if memory.kind != MemoryKind.VIDEO:
        return True
    return memory_file.browser_compatibility == BrowserCompatibilityState.SUPPORTED


def _iter_public_files(memory: Memory):
    """Yield files that pass both display and browser gates, in stable id order.

    md5 dedup can attach several files to one memory; the SQL predicates above
    use any-file semantics, so the Python-side classification and the file
    that actually gets served must use the same semantics.
    """

    for memory_file in sorted(memory.files, key=lambda item: item.id):
        if _file_display_ok(memory, memory_file) and _file_browser_ok(
            memory, memory_file
        ):
            yield memory_file


def get_primary_public_file(memory: Memory) -> MemoryFile | None:
    """First file that satisfies the public surface; the served representative."""

    return next(iter(_iter_public_files(memory)), None)


def get_media_display_state(memory: Memory) -> MediaDisplayState:
    """Classify one memory for public rendering and admin diagnostics."""

    if memory.kind not in {MemoryKind.PHOTO, MemoryKind.VIDEO}:
        return "excluded"
    if any(_file_display_ok(memory, item) for item in memory.files):
        return "displayable"
    return "excluded"


def get_public_visibility_state(memory: Memory) -> str:
    """Classify the final public surface; excluded is intentionally opaque."""

    return "displayable" if any(_iter_public_files(memory)) else "excluded"
