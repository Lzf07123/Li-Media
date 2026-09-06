from pathlib import Path
from uuid import UUID, uuid4

from app.models.memory import MemoryKind
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
) -> str | None:
    """Create a cached aspect-preserving thumbnail without storing source media."""

    temporary_dir = media_root / "tmp"
    temporary_dir.mkdir(parents=True, exist_ok=True)
    temporary_path = temporary_dir / f"{memory_id}.{uuid4().hex}.tmp"
    stream: BaiduStreamResponse | None = None

    try:
        status_code, _, _, _, stream = client.open_stream(
            remote_id,
            range_header=None,
        )
        if status_code is not None and status_code >= 400:
            return None

        with temporary_path.open("wb") as output:
            for chunk in stream.iter_bytes():
                if chunk:
                    output.write(chunk)

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
