from pathlib import Path
from uuid import UUID, uuid4

from app.core.config import get_settings
from app.models.memory import DerivativeFailureKind, MemoryKind
from app.services.task_limits import (
    is_temporary_path_active,
    register_temporary_path,
    unregister_temporary_path,
)
from app.services.baidu_pan import BaiduPanError, BaiduStreamResponse
from app.services.memory_thumbnails import create_memory_derivative


def create_remote_thumbnail(
    client: object,
    remote_id: str,
    media_root: Path,
    *,
    kind: MemoryKind,
    memory_id: UUID,
    max_size: int,
    duration_seconds: int | None = None,
    cancel_event: object | None = None,
    failure_sink: dict[str, str] | None = None,
    source_mime_type: str | None = None,
) -> str | None:
    """Create a cached aspect-preserving thumbnail without storing source media."""

    temporary_dir = media_root / "tmp"
    temporary_dir.mkdir(parents=True, exist_ok=True)
    temporary_path = temporary_dir / f"{memory_id}.{uuid4().hex}.tmp"
    settings = get_settings()
    max_source_bytes = (
        settings.remote_thumbnail_video_source_max_bytes
        if kind == MemoryKind.VIDEO
        else settings.remote_thumbnail_source_max_bytes
    )
    stream: BaiduStreamResponse | None = None

    def record_failure(kind: str) -> None:
        if failure_sink is not None:
            failure_sink.setdefault("kind", kind)

    try:
        if not _temporary_directory_has_capacity(temporary_dir):
            record_failure(DerivativeFailureKind.DISK_QUOTA.value)
            return None

        try:
            status_code, content_length, _, _, stream = client.open_stream(
                remote_id,
                range_header=None,
            )
        except BaiduPanError as exc:
            record_failure(classify_remote_error(exc))
            return None

        if status_code is not None and status_code >= 400:
            record_failure(DerivativeFailureKind.REMOTE_UNAVAILABLE.value)
            return None

        if content_length is not None and content_length > max_source_bytes:
            record_failure(
                DerivativeFailureKind.MOV_MOOV.value
                if source_mime_type == "video/quicktime"
                else DerivativeFailureKind.SOURCE_TRUNCATED.value
            )
            return None

        register_temporary_path(temporary_path.resolve())
        written_bytes = 0
        with temporary_path.open("wb") as output:
            for chunk in stream.iter_bytes():
                if cancel_event is not None and getattr(
                    cancel_event, "is_set", lambda: False
                )():
                    record_failure(DerivativeFailureKind.CANCELLED.value)
                    return None

                if not chunk:
                    continue

                output.write(chunk)
                written_bytes += len(chunk)
                if written_bytes >= max_source_bytes:
                    record_failure(
                        DerivativeFailureKind.MOV_MOOV.value
                        if source_mime_type == "video/quicktime"
                        else DerivativeFailureKind.SOURCE_TRUNCATED.value
                    )
                    return None

        if not temporary_path.is_file() or temporary_path.stat().st_size == 0:
            record_failure(DerivativeFailureKind.TEMPORARY_EMPTY.value)
            return None

        return create_memory_derivative(
            temporary_path,
            media_root,
            kind=kind,
            memory_id=memory_id,
            max_size=max_size,
            duration_seconds=duration_seconds,
            failure_sink=failure_sink,
        )
    except Exception as exc:
        record_failure(classify_remote_error(exc))
        return None
    finally:
        if stream is not None:
            stream.close()
        temporary_path.unlink(missing_ok=True)
        unregister_temporary_path(temporary_path.resolve())


def classify_remote_error(exc: Exception) -> str:
    message = str(exc)
    if "凭证无效" in message or "凭证已过期" in message:
        return DerivativeFailureKind.REMOTE_AUTH.value
    if "凭证" in message:
        return DerivativeFailureKind.REMOTE_AUTH.value
    if "限流" in message:
        return DerivativeFailureKind.BAIDU_RATE_LIMITED.value
    if "不存在" in message or "路径已变化" in message:
        return DerivativeFailureKind.REMOTE_NOT_FOUND.value
    if "不可用" in message or "暂时无法读取" in message:
        return DerivativeFailureKind.REMOTE_UNAVAILABLE.value
    if "403" in message or "直链被拒绝" in message:
        return DerivativeFailureKind.REMOTE_FORBIDDEN.value
    if isinstance(exc, TimeoutError):
        return DerivativeFailureKind.TIMEOUT.value
    if isinstance(exc, OSError):
        return DerivativeFailureKind.TEMPORARY_IO.value
    return DerivativeFailureKind.UNKNOWN.value


def _temporary_directory_has_capacity(temporary_dir: Path) -> bool:
    settings = get_settings()
    files = [path for path in temporary_dir.rglob("*") if path.is_file()]
    if len(files) >= settings.remote_thumbnail_max_temp_files:
        return False

    used_bytes = 0
    for path in files:
        try:
            used_bytes += path.stat().st_size
        except OSError:
            return False

    return used_bytes < settings.remote_thumbnail_disk_quota_bytes


def cleanup_stale_remote_temporary_files(media_root: Path) -> int:
    """Remove orphaned temp files left by a killed worker before startup."""

    temporary_dir = media_root / "tmp"
    if not temporary_dir.exists():
        return 0

    removed = 0
    for path in temporary_dir.glob("*.tmp"):
        if path.is_file() and not is_temporary_path_active(path):
            path.unlink(missing_ok=True)
            removed += 1
    return removed
