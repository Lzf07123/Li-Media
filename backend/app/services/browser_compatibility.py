"""Conservative browser playback compatibility for indexed videos."""

from __future__ import annotations

import json
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.memory import BrowserCompatibilityState, MemoryFile
from app.services.task_limits import (
    register_temporary_path,
    task_limiter,
    task_metrics,
    unregister_temporary_path,
    TaskType,
)


BROWSER_COMPATIBILITY_VERSION = "v1"

_CONTAINER_KEYS = ("container", "format_name", "container_name")
_VIDEO_CODEC_KEYS = ("video_codec", "vcodec", "codec_name")
_AUDIO_CODEC_KEYS = ("audio_codec", "acodec", "audio_codec_name")
_PROFILE_KEYS = ("video_profile", "profile")

_SUPPORTED_CONTAINERS = {"mp4", "m4v"}
_SUPPORTED_VIDEO_CODECS = {"h264", "avc1"}
_SUPPORTED_AUDIO_CODECS = {"aac", "mp4a"}
_UNSUPPORTED_CONTAINERS = {
    "avi",
    "flv",
    "matroska",
    "mkv",
    "mov",
    "mpegts",
    "ts",
    "webm",
    "wmv",
}
_UNSUPPORTED_VIDEO_CODECS = {
    "av1",
    "h265",
    "hevc",
    "hvc1",
    "mpeg2video",
    "mpeg4",
    "prores",
    "vp8",
    "vp9",
}


class BrowserProbeClient(Protocol):
    def open_stream(
        self,
        remote_id: str,
        *,
        range_header: str | None,
    ) -> tuple[int, int | None, str | None, str, object]:
        ...


def _first_text(source: dict[str, object], keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = source.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip().lower()
    return None


def _classify_format(summary: dict[str, object]) -> BrowserCompatibilityState:
    container = _first_text(summary, _CONTAINER_KEYS)
    video_codec = _first_text(summary, _VIDEO_CODEC_KEYS)
    audio_codec = _first_text(summary, _AUDIO_CODEC_KEYS)

    if video_codec and video_codec in _UNSUPPORTED_VIDEO_CODECS:
        return BrowserCompatibilityState.UNSUPPORTED
    if container and container in _UNSUPPORTED_CONTAINERS:
        return BrowserCompatibilityState.UNSUPPORTED
    if not container or not video_codec:
        return BrowserCompatibilityState.UNKNOWN
    if container not in _SUPPORTED_CONTAINERS:
        return BrowserCompatibilityState.UNSUPPORTED
    if video_codec not in _SUPPORTED_VIDEO_CODECS:
        return BrowserCompatibilityState.UNSUPPORTED
    if audio_codec and audio_codec not in _SUPPORTED_AUDIO_CODECS:
        return BrowserCompatibilityState.UNSUPPORTED
    return BrowserCompatibilityState.SUPPORTED


def evaluate_memory_file(memory_file: MemoryFile) -> tuple[
    BrowserCompatibilityState,
    dict[str, object],
    str | None,
]:
    """Classify from persisted evidence only; absent evidence stays unknown."""

    raw_summary = memory_file.raw_metadata_summary or {}
    persisted_summary = memory_file.browser_format_summary or {}
    summary: dict[str, object] = {
        "container": _first_text(raw_summary, _CONTAINER_KEYS)
        or _first_text(persisted_summary, _CONTAINER_KEYS)
        or (memory_file.extension or "").lower() or None,
        "video_codec": _first_text(raw_summary, _VIDEO_CODEC_KEYS)
        or _first_text(persisted_summary, _VIDEO_CODEC_KEYS),
        "audio_codec": _first_text(raw_summary, _AUDIO_CODEC_KEYS)
        or _first_text(persisted_summary, _AUDIO_CODEC_KEYS),
        "video_profile": _first_text(raw_summary, _PROFILE_KEYS)
        or _first_text(persisted_summary, _PROFILE_KEYS),
    }
    summary = {key: value for key, value in summary.items() if value is not None}
    return _classify_format(summary), summary, None


def apply_persisted_compatibility(memory_file: MemoryFile) -> None:
    state, summary, error = evaluate_memory_file(memory_file)
    memory_file.browser_compatibility = state
    memory_file.browser_compatibility_version = BROWSER_COMPATIBILITY_VERSION
    memory_file.browser_format_summary = summary
    memory_file.browser_compatibility_error = error
    memory_file.browser_compatibility_checked_at = datetime.now(timezone.utc)


def _extract_ffprobe_summary(payload: dict[str, object]) -> dict[str, object]:
    streams = payload.get("streams")
    video_stream = next(
        (
            stream
            for stream in streams
            if isinstance(stream, dict) and stream.get("codec_type") == "video"
        ),
        {},
    ) if isinstance(streams, list) else {}
    audio_stream = next(
        (
            stream
            for stream in streams
            if isinstance(stream, dict) and stream.get("codec_type") == "audio"
        ),
        {},
    ) if isinstance(streams, list) else {}
    format_info = payload.get("format") if isinstance(payload.get("format"), dict) else {}

    def text(source: dict[str, object], key: str) -> str | None:
        value = source.get(key)
        return str(value).strip().lower() or None if value is not None else None

    container = text(format_info, "format_name")
    if container and "," in container:
        container = container.split(",", 1)[0]
    summary: dict[str, object] = {
        "container": container,
        "video_codec": text(video_stream, "codec_name"),
        "audio_codec": text(audio_stream, "codec_name"),
        "video_profile": text(video_stream, "profile"),
    }
    return {key: value for key, value in summary.items() if value is not None}


def probe_memory_file_compatibility(
    db: Session,
    client: BrowserProbeClient,
    memory_file: MemoryFile,
    *,
    media_root: Path,
) -> None:
    """Read a bounded remote prefix for ffprobe; never download or transcode fully."""

    settings = get_settings()
    media_root.mkdir(parents=True, exist_ok=True)
    (media_root / "tmp").mkdir(parents=True, exist_ok=True)

    task_slot = task_limiter.acquire(TaskType.DIRECT_PROBE)
    temporary_path: Path | None = None
    active_path: Path | None = None
    try:
        _, _, _, _, response = client.open_stream(
            memory_file.remote_id or "",
            range_header="bytes=0-",
        )
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=".browser-probe-",
            suffix=".media",
            dir=media_root / "tmp",
        )
        temporary_path = Path(temporary_name)
        active_path = temporary_path.resolve()
        register_temporary_path(active_path)
        bytes_read = 0
        with Path(descriptor).open("wb") as output:
            for chunk in response.iter_bytes():
                output.write(chunk)
                bytes_read += len(chunk)
                if bytes_read >= settings.browser_probe_max_bytes:
                    break
        response.close()

        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                str(temporary_path),
            ],
            capture_output=True,
            check=True,
            timeout=settings.browser_probe_timeout_seconds,
        )
        payload = json.loads(result.stdout.decode("utf-8") or "{}")
        summary = _extract_ffprobe_summary(payload)
        state = _classify_format(summary)
        memory_file.browser_compatibility = state
        memory_file.browser_format_summary = summary
        memory_file.browser_compatibility_error = (
            None if state != BrowserCompatibilityState.UNKNOWN else "探测数据不足，保持未知"
        )
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        memory_file.browser_compatibility = BrowserCompatibilityState.UNKNOWN
        memory_file.browser_format_summary = {}
        memory_file.browser_compatibility_error = str(exc) or type(exc).__name__
        task_metrics.record_failed(TaskType.DIRECT_PROBE)
    except Exception:
        memory_file.browser_compatibility = BrowserCompatibilityState.UNKNOWN
        memory_file.browser_format_summary = {}
        memory_file.browser_compatibility_error = "远程兼容探测失败"
        task_metrics.record_failed(TaskType.DIRECT_PROBE)
        raise
    else:
        if memory_file.browser_compatibility != BrowserCompatibilityState.UNKNOWN:
            task_metrics.record_completed(TaskType.DIRECT_PROBE)
        else:
            task_metrics.record_failed(TaskType.DIRECT_PROBE)
    finally:
        try:
            response.close()
        except Exception:
            pass
        if active_path is not None:
            unregister_temporary_path(active_path)
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
        memory_file.browser_compatibility_version = BROWSER_COMPATIBILITY_VERSION
        memory_file.browser_compatibility_checked_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(memory_file)
        task_limiter.release(task_slot)
