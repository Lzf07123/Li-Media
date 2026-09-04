import mimetypes
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, UploadFile, status

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


def infer_memory_kind(filename: str, content_type: str | None) -> MemoryKind:
    suffix = Path(filename).suffix.lower()
    media_type = (content_type or "").split(";", 1)[0].strip().lower()

    if media_type.startswith("image/") or suffix in PHOTO_EXTENSIONS:
        return MemoryKind.PHOTO

    if media_type.startswith("video/") or suffix in VIDEO_EXTENSIONS:
        return MemoryKind.VIDEO

    raise HTTPException(
        status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        detail="只支持照片或视频文件",
    )


def guess_mime_type(filename: str, content_type: str | None) -> str:
    guessed_type = mimetypes.guess_type(filename)[0]
    return (content_type or guessed_type or "application/octet-stream").split(
        ";", 1
    )[0].strip()


def save_upload(
    upload: UploadFile,
    media_root: Path,
    *,
    kind: MemoryKind,
) -> tuple[Path, int, str]:
    original_name = Path(upload.filename or "memory").name
    suffix = Path(original_name).suffix.lower()
    stored_name = f"{uuid4().hex}{suffix}"
    kind_dir = "photos" if kind == MemoryKind.PHOTO else "videos"
    target_dir = media_root / kind_dir
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / stored_name

    size_bytes = 0
    with target_path.open("wb") as output_file:
        while chunk := upload.file.read(1024 * 1024):
            size_bytes += len(chunk)
            output_file.write(chunk)

    relative_path = target_path.relative_to(media_root).as_posix()
    return target_path, size_bytes, relative_path
