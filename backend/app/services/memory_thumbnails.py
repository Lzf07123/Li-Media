import subprocess
from pathlib import Path
from uuid import UUID, uuid4

from PIL import Image, ImageOps

from app.core.config import get_settings
from app.models.memory import MemoryKind


def resolve_media_path(media_root: Path, relative_path: str) -> Path | None:
    media_root = media_root.resolve()
    target_path = (media_root / relative_path).resolve()

    if not target_path.is_relative_to(media_root):
        return None

    return target_path


def remove_media_file(media_root: Path, relative_path: str | None) -> None:
    if not relative_path:
        return

    target_path = resolve_media_path(media_root, relative_path)
    if target_path is not None and target_path.is_file():
        target_path.unlink()


def _cleanup_output(output_path: Path, temporary_path: Path) -> None:
    temporary_path.unlink(missing_ok=True)
    output_path.unlink(missing_ok=True)


def _create_photo_thumbnail(
    source_path: Path,
    output_path: Path,
    temporary_path: Path,
    *,
    max_size: int,
    quality: int,
) -> None:
    with Image.open(source_path) as image:
        image = ImageOps.exif_transpose(image)

        if image.mode not in {"RGB", "RGBA"}:
            image = image.convert("RGB")

        image.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
        image.save(temporary_path, format="WEBP", quality=quality, method=4)

    temporary_path.replace(output_path)


def _create_video_poster(
    source_path: Path,
    output_path: Path,
    temporary_path: Path,
    *,
    duration_seconds: int | None,
    max_size: int,
) -> None:
    start_seconds = min(max(duration_seconds or 0, 0) / 10, 5) if duration_seconds else 0
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{start_seconds:.2f}",
        "-i",
        str(source_path),
        "-frames:v",
        "1",
        "-map",
        "v:0",
        "-vf",
        f"scale='min({max_size},iw)':-2",
        str(temporary_path),
    ]

    subprocess.run(command, check=True, capture_output=True, timeout=30)
    temporary_path.replace(output_path)


def create_memory_thumbnail(
    source_path: Path,
    media_root: Path,
    *,
    kind: MemoryKind,
    memory_id: UUID,
    duration_seconds: int | None = None,
) -> str | None:
    settings = get_settings()
    output_dir = media_root / "thumbnails"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{memory_id}.webp"
    temporary_path = output_dir / f".{memory_id}.{uuid4().hex}.tmp.webp"

    try:
        if kind == MemoryKind.PHOTO:
            _create_photo_thumbnail(
                source_path,
                output_path,
                temporary_path,
                max_size=settings.thumbnail_max_size,
                quality=settings.thumbnail_quality,
            )
        else:
            _create_video_poster(
                source_path,
                output_path,
                temporary_path,
                duration_seconds=duration_seconds,
                max_size=settings.thumbnail_max_size,
            )
    except Exception:
        _cleanup_output(output_path, temporary_path)
        return None

    return output_path.relative_to(media_root).as_posix()
