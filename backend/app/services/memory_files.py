import mimetypes
from pathlib import Path

from app.models.memory import MemoryKind


PHOTO_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".avif",
    ".gif",
    ".heic",
    ".heif",
}

VIDEO_EXTENSIONS = {
    ".mp4",
    ".m4v",
    ".mov",
    ".webm",
    ".mkv",
    ".avi",
}


def infer_memory_kind_or_none(
    filename: str,
    content_type: str | None,
) -> MemoryKind | None:
    suffix = Path(filename).suffix.lower()
    media_type = (content_type or "").split(";", 1)[0].strip().lower()

    if media_type.startswith("image/") or suffix in PHOTO_EXTENSIONS:
        return MemoryKind.PHOTO

    if media_type.startswith("video/") or suffix in VIDEO_EXTENSIONS:
        return MemoryKind.VIDEO

    return None


def guess_mime_type(filename: str, content_type: str | None) -> str:
    media_type = (content_type or "").split(";", 1)[0].strip()
    guessed_type = mimetypes.guess_type(filename)[0]
    if media_type == "application/octet-stream" and guessed_type:
        return guessed_type
    return media_type or guessed_type or "application/octet-stream"
