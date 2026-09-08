import subprocess
import uuid
from pathlib import Path

from app.core.config import Settings

from app.models.memory import MemoryKind

from app.services.memory_thumbnails import classify_derivative_exception
from app.services.remote_thumbnails import create_remote_thumbnail
from app.models.memory import MemoryKind


class RaisingClient:
    def __init__(self, error: Exception) -> None:
        self.error = error

    def open_stream(self, remote_id: str, *, range_header: str | None):
        raise self.error


class LargeRemoteClient:
    def open_stream(self, remote_id: str, *, range_header: str | None):
        return 200, 100_000_000, None, "video/quicktime", None


def test_derivative_exception_classifies_ffmpeg_container_errors() -> None:
    error = subprocess.CalledProcessError(
        1,
        "ffmpeg",
        stderr=b"moov atom not found\n",
    )
    assert classify_derivative_exception(error) == "mov_moov"


def test_remote_thumbnail_records_rate_limit_failure(tmp_path) -> None:
    failure_sink: dict[str, str] = {}
    result = create_remote_thumbnail(
        RaisingClient(RuntimeError("百度网盘接口限流，请稍后重试")),
        "remote-1",
        tmp_path / "media",
        kind=MemoryKind.VIDEO,
        memory_id=uuid.uuid4(),
        max_size=240,
        failure_sink=failure_sink,
    )

    assert result is None
    assert failure_sink == {"kind": "baidu_rate_limited"}


def test_large_quicktime_source_is_classified_as_mov_moov(tmp_path, monkeypatch) -> None:
    # Container images and deployment .env files may raise the video source cap;
    # this test targets the 64MB classification boundary, not deployment limits.
    monkeypatch.setattr(
        "app.services.remote_thumbnails.get_settings",
        lambda: Settings(remote_thumbnail_video_source_max_bytes=64 * 1024 * 1024),
    )
    failure_sink: dict[str, str] = {}
    result = create_remote_thumbnail(
        LargeRemoteClient(),
        "remote-1",
        tmp_path / "media",
        kind=MemoryKind.VIDEO,
        memory_id=uuid.uuid4(),
        max_size=240,
        failure_sink=failure_sink,
        source_mime_type="video/quicktime",
    )

    assert result is None
    assert failure_sink == {"kind": "mov_moov"}
