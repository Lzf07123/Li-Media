from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageOps

from app.models.memory import MemoryKind


@dataclass(slots=True)
class MemoryMetadata:
    title: str | None = None
    description: str | None = None
    location: str | None = None
    captured_at: datetime | None = None
    duration_seconds: int | None = None
    width: int | None = None
    height: int | None = None


def _decode_text(value: object) -> str | None:
    if value is None:
        return None

    if isinstance(value, bytes):
        for encoding in ("utf-8", "latin-1"):
            try:
                value = value.decode(encoding)
                break
            except UnicodeDecodeError:
                continue

    if isinstance(value, tuple):
        value = " ".join(str(item) for item in value)

    text = str(value).strip().rstrip("\x00").strip()
    try:
        text = text.encode("latin-1").decode("utf-8")
    except UnicodeError:
        pass
    text = text.strip()
    return text or None


def _decode_xp_text(value: object) -> str | None:
    if isinstance(value, bytes):
        return _decode_text(value.decode("utf-16le", errors="ignore"))
    return _decode_text(value)


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None

    for pattern in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(value[:19], pattern)
        except ValueError:
            continue

    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.astimezone()
    except ValueError:
        return None


def _degrees(value: object) -> float | None:
    if not isinstance(value, tuple) or len(value) != 3:
        return None

    try:
        degrees, minutes, seconds = (float(item) for item in value)
        return degrees + minutes / 60 + seconds / 3600
    except (TypeError, ValueError):
        return None


def _gps_location(gps: dict[object, object]) -> str | None:
    latitude = _degrees(gps.get(2))
    longitude = _degrees(gps.get(4))

    if latitude is None or longitude is None:
        return None

    latitude_ref = _decode_text(gps.get(1))
    longitude_ref = _decode_text(gps.get(3))
    if latitude_ref in {"S", "s"}:
        latitude = -latitude
    if longitude_ref in {"W", "w"}:
        longitude = -longitude

    return f"{latitude:.6f}, {longitude:.6f}"


def read_image_metadata(path: Path) -> MemoryMetadata:
    try:
        with Image.open(path) as image:
            image = ImageOps.exif_transpose(image)
            width, height = image.size
            exif = image.getexif()
            exif_ifd = exif.get_ifd(0x8769)
            gps_ifd = exif.get_ifd(0x8825)

            captured_at = _parse_datetime(
                _decode_text(exif_ifd.get(36867))
                or _decode_text(exif_ifd.get(36868))
                or _decode_text(exif.get(306))
            )

            return MemoryMetadata(
                title=_decode_xp_text(exif.get(40091)),
                description=_decode_text(exif.get(270))
                or _decode_xp_text(exif_ifd.get(40092)),
                location=_gps_location(gps_ifd),
                captured_at=captured_at,
                width=width,
                height=height,
            )
    except Exception:
        return MemoryMetadata()


def read_video_metadata(path: Path) -> MemoryMetadata:
    try:
        completed = subprocess.run(
            [
                "ffprobe",
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                str(path),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        payload = json.loads(completed.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        try:
            captured_at = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        except OSError:
            captured_at = None
        return MemoryMetadata(captured_at=captured_at)

    format_data = payload.get("format", {})
    tags = format_data.get("tags", {})
    video_stream = next(
        (stream for stream in payload.get("streams", []) if stream.get("codec_type") == "video"),
        {},
    )
    stream_tags = video_stream.get("tags", {})
    duration = format_data.get("duration") or video_stream.get("duration")

    try:
        duration_seconds = int(float(duration)) if duration is not None else None
    except (TypeError, ValueError):
        duration_seconds = None

    captured_at = _parse_datetime(
        _decode_text(tags.get("creation_time"))
        or _decode_text(stream_tags.get("creation_time"))
    )
    if captured_at is None:
        try:
            captured_at = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        except OSError:
            captured_at = None

    return MemoryMetadata(
        title=_decode_text(tags.get("title")) or _decode_text(stream_tags.get("title")),
        description=_decode_text(tags.get("description"))
        or _decode_text(tags.get("comment"))
        or _decode_text(stream_tags.get("description")),
        location=_decode_text(tags.get("location"))
        or _decode_text(tags.get("com.apple.quicktime.location.ISO6709")),
        captured_at=captured_at,
        duration_seconds=duration_seconds,
        width=int(video_stream["width"]) if video_stream.get("width") is not None else None,
        height=int(video_stream["height"]) if video_stream.get("height") is not None else None,
    )


def extract_memory_metadata(path: Path, kind: MemoryKind) -> MemoryMetadata:
    if kind == MemoryKind.PHOTO:
        return read_image_metadata(path)
    return read_video_metadata(path)
