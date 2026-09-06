from pathlib import Path
from uuid import UUID, uuid4

from app.core.config import get_settings
from app.models.memory import MemoryKind
from app.services.task_limits import (
    register_temporary_path,
    unregister_temporary_path,
)
from app.services.baidu_pan import BaiduStreamResponse
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
) -> str | None:
    """Create a cached aspect-preserving thumbnail without storing source media."""

    temporary_dir = media_root / "tmp"
    temporary_dir.mkdir(parents=True, exist_ok=True)
    temporary_path = temporary_dir / f"{memory_id}.{uuid4().hex}.tmp"
    max_source_bytes = get_settings().remote_thumbnail_source_max_bytes
    stream: BaiduStreamResponse | None = None

    try:
        if not _temporary_directory_has_capacity(temporary_dir):
            return None

        status_code, _, _, _, stream = client.open_stream(
            remote_id,
            range_header=None,
        )
        if status_code is not None and status_code >= 400:
            return None

        register_temporary_path(temporary_path.resolve())
        written_bytes = 0
        with temporary_path.open("wb") as output:
            for chunk in stream.iter_bytes():
                if cancel_event is not None and getattr(
                    cancel_event, "is_set", lambda: False
                )():
                    return None

                if not chunk:
                    continue

                output.write(chunk)
                written_bytes += len(chunk)
                if written_bytes >= max_source_bytes:
                    break

        if not temporary_path.is_file() or temporary_path.stat().st_size == 0:
            return None

        return create_memory_derivative(
            temporary_path,
            media_root,
            kind=kind,
            memory_id=memory_id,
            max_size=max_size,
            duration_seconds=duration_seconds,
        )
    except Exception:
        return None
    finally:
        if stream is not None:
            stream.close()
        temporary_path.unlink(missing_ok=True)
        unregister_temporary_path(temporary_path.resolve())


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
