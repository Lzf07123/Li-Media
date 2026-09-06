import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import uuid

from app.core.config import Settings
from app.api.v1.memories import _run_remote_derivative
from app.models.memory import Memory, MemoryFile, MemoryKind
from app.services.remote_thumbnails import create_remote_thumbnail


class FakeStream:
    def __init__(self, chunks, on_close=None):
        self.chunks = list(chunks)
        self.closed = False
        self._on_close = on_close

    def iter_bytes(self):
        yield from self.chunks

    def close(self):
        self.closed = True
        if self._on_close:
            self._on_close()


class FakeClient:
    def __init__(self, chunks, error=None, on_open=None):
        self.chunks = chunks
        self.error = error
        self.opened = 0
        self._on_open = on_open

    def open_stream(self, remote_id, *, range_header):
        self.opened += 1
        if self._on_open:
            self._on_open()
        if self.error:
            raise self.error
        return 200, None, None, "video/mp4", FakeStream(self.chunks)


def configure_remote_settings(monkeypatch, tmp_path, **overrides) -> Settings:
    settings = Settings(
        media_root=str(tmp_path / "media"),
        **overrides,
    )
    monkeypatch.setattr(
        "app.services.remote_thumbnails.get_settings",
        lambda: settings,
    )
    monkeypatch.setattr("app.api.v1.memories.get_settings", lambda: settings)
    monkeypatch.setattr("app.services.task_limits.get_settings", lambda: settings)
    return settings


def test_remote_thumbnail_cleans_up_on_success_failure_timeout_and_cancel(
    tmp_path, monkeypatch
) -> None:
    configure_remote_settings(monkeypatch, tmp_path)
    temporary_dir = Path(Settings(media_root=str(tmp_path / "media")).media_root) / "tmp"
    derivative_results = [None, "generated", None]

    def fake_derivative(source_path, media_root, **kwargs):
        assert source_path.is_file()
        return derivative_results.pop(0)

    monkeypatch.setattr(
        "app.services.remote_thumbnails.create_memory_derivative",
        fake_derivative,
    )

    client = FakeClient([b"frame"])
    assert create_remote_thumbnail(
        client,
        "remote-1",
        tmp_path / "media",
        kind=MemoryKind.VIDEO,
        memory_id=uuid.uuid4(),
        max_size=240,
    ) is None
    assert client.chunks
    assert not list(temporary_dir.rglob("*.tmp"))

    client = FakeClient([b"frame"])
    assert create_remote_thumbnail(
        client,
        "remote-1",
        tmp_path / "media",
        kind=MemoryKind.VIDEO,
        memory_id=uuid.uuid4(),
        max_size=240,
    ) == "generated"
    assert not list(temporary_dir.rglob("*.tmp"))

    class TimeoutError(Exception):
        pass

    client = FakeClient([b"frame"], error=TimeoutError("timeout"))
    assert create_remote_thumbnail(
        client,
        "remote-1",
        tmp_path / "media",
        kind=MemoryKind.VIDEO,
        memory_id=uuid.uuid4(),
        max_size=240,
    ) is None
    assert not list(temporary_dir.rglob("*.tmp"))

    cancel = threading.Event()
    def on_open():
        cancel.set()

    client = FakeClient([b"frame"], on_open=on_open)
    assert create_remote_thumbnail(
        client,
        "remote-1",
        tmp_path / "media",
        kind=MemoryKind.VIDEO,
        memory_id=uuid.uuid4(),
        max_size=240,
        cancel_event=cancel,
    ) is None
    assert client.opened == 1
    assert not list(temporary_dir.rglob("*.tmp"))


def test_remote_thumbnail_enforces_source_and_temporary_file_limits(
    tmp_path, monkeypatch
) -> None:
    configure_remote_settings(
        monkeypatch,
        tmp_path,
        remote_thumbnail_source_max_bytes=250,
        remote_thumbnail_max_temp_files=0,
    )
    seen_sizes: list[int] = []

    def fake_derivative(source_path, media_root, **kwargs):
        seen_sizes.append(source_path.stat().st_size)
        return "generated"

    monkeypatch.setattr(
        "app.services.remote_thumbnails.create_memory_derivative",
        fake_derivative,
    )

    client = FakeClient([b"x" * 100, b"x" * 100, b"x" * 100, b"x" * 100])
    assert create_remote_thumbnail(
        client,
        "remote-1",
        tmp_path / "media",
        kind=MemoryKind.VIDEO,
        memory_id=uuid.uuid4(),
        max_size=240,
    ) is None
    assert client.opened == 0

    monkeypatch.setattr(
        "app.services.remote_thumbnails.get_settings",
        lambda: Settings(
            media_root=str(tmp_path / "media"),
            remote_thumbnail_source_max_bytes=250,
        ),
    )
    client = FakeClient([b"x" * 100, b"x" * 100, b"x" * 100, b"x" * 100])
    assert create_remote_thumbnail(
        client,
        "remote-1",
        tmp_path / "media",
        kind=MemoryKind.VIDEO,
        memory_id=uuid.uuid4(),
        max_size=240,
    ) == "generated"
    assert seen_sizes == [300]


def test_same_derivative_id_merges_concurrent_ffmpeg_work(
    tmp_path, monkeypatch
) -> None:
    configure_remote_settings(monkeypatch, tmp_path, derivative_wait_timeout_seconds=1)
    calls = []
    release = threading.Event()
    started = threading.Event()

    def fake_remote_derivative(*args, **kwargs):
        calls.append("ffmpeg")
        started.set()
        release.wait(1)
        return "generated"

    monkeypatch.setattr(
        "app.api.v1.memories.create_remote_thumbnail",
        fake_remote_derivative,
    )
    memory_id = uuid.uuid4()
    memory = Memory(id=memory_id, title="video", kind=MemoryKind.VIDEO)
    memory_file = MemoryFile(
        memory_id=memory_id,
        source="baidupan",
        remote_id="remote-1",
        remote_path="/remote/video.mp4",
        parent_path="/remote",
        filename="video.mp4",
        mime_type="video/mp4",
    )

    with ThreadPoolExecutor(max_workers=2) as executor:
        owner = executor.submit(
            _run_remote_derivative,
            object(),
            memory_file,
            memory,
            tmp_path / "media",
            max_size=240,
        )
        started.wait(1)
        follower = executor.submit(
            _run_remote_derivative,
            object(),
            memory_file,
            memory,
            tmp_path / "media",
            max_size=240,
        )
        release.set()
        assert owner.result(1) == "generated"
        assert follower.result(1) == "generated"

    assert calls == ["ffmpeg"]
