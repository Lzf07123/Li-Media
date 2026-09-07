import uuid
from collections.abc import Generator
from pathlib import Path
from subprocess import CompletedProcess

from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.db.session import Base, get_db
from app.main import app
from app.models.memory import (
    Memory,
    MemoryFile,
    MemoryFileStatus,
    MemoryKind,
    MemoryStatus,
    RemoteFileState,
    RemoteStreamState,
    RemoteThumbnailState,
)
from app.schemas.memory import MemoryRead
from app.services.memory_thumbnails import create_memory_derivative
from app.services.memory_thumbnails import create_memory_thumbnail


def configure_test_settings(monkeypatch, media_root: Path) -> Settings:
    settings = Settings(admin_token="test-token", media_root=str(media_root))
    monkeypatch.setattr("app.api.v1.admin.get_settings", lambda: settings)
    monkeypatch.setattr("app.api.v1.memories.get_settings", lambda: settings)
    return settings


def create_database(tmp_path: Path) -> sessionmaker[Session]:
    engine = create_engine(f"sqlite:///{tmp_path / 'memories.db'}")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def override_database(session_factory: sessionmaker[Session]) -> Generator[Session, None, None]:
    session = session_factory()
    try:
        yield session
    finally:
        session.close()


def test_photo_thumbnail_is_downscaled_and_served(tmp_path: Path, monkeypatch) -> None:
    settings = configure_test_settings(monkeypatch, tmp_path)
    media_root = Path(settings.media_root)
    source_dir = media_root / "photos"
    source_dir.mkdir(parents=True)
    source_path = source_dir / "photo.png"
    Image.new("RGB", (2400, 1200), "white").save(source_path)

    thumbnail_path = create_memory_derivative(
        source_path,
        media_root,
        kind=MemoryKind.PHOTO,
        memory_id=uuid.uuid4(),
        max_size=480,
    )

    assert thumbnail_path is not None
    thumbnail_file = media_root / thumbnail_path
    with Image.open(thumbnail_file) as thumbnail:
        assert thumbnail.format == "WEBP"
        assert thumbnail.size == (480, 240)

    session_factory = create_database(tmp_path)
    with session_factory.begin() as session:
        memory = Memory(
            title="thumbnail memory",
            kind=MemoryKind.PHOTO,
            status=MemoryStatus.PUBLISHED,
            thumbnail_path=thumbnail_path,
        )
        session.add(memory)
        session.flush()
        session.add(
            MemoryFile(
                memory_id=memory.id,
                source="baidupan",
                remote_path="photo.png",
                    source_path="photos/photo.png",
                    mime_type="image/png",
                    status=MemoryFileStatus.MATCHED,
                    remote_state=RemoteFileState.READY,
                    thumbnail_state=RemoteThumbnailState.READY,
                    stream_state=RemoteStreamState.READY,
            )
        )

    def override_get_db() -> Generator[Session, None, None]:
        yield from override_database(session_factory)

    app.dependency_overrides[get_db] = override_get_db
    try:
        with TestClient(app) as client:
            detail = client.get(f"/api/v1/memories/{memory.id}")
            assert detail.status_code == 200
            assert detail.json()["thumbnail_url"] == (
                f"/api/v1/memories/{memory.id}/thumbnail"
            )

            thumbnail_response = client.get(f"/api/v1/memories/{memory.id}/thumbnail")
            assert thumbnail_response.status_code == 200
            assert thumbnail_response.headers["content-type"] == "image/webp"
    finally:
        app.dependency_overrides.clear()


def test_video_poster_uses_ffmpeg_and_scales_long_edge(tmp_path: Path, monkeypatch) -> None:
    settings = configure_test_settings(monkeypatch, tmp_path)
    media_root = Path(settings.media_root)
    source_dir = media_root / "videos"
    source_dir.mkdir(parents=True)
    source_path = source_dir / "video.mp4"
    source_path.write_bytes(b"video-data")
    memory_id = uuid.uuid4()

    def run_ffmpeg(command, **kwargs):
        assert command[0] == "ffmpeg"
        assert "-ss" in command
        assert "0.00" in command
        assert "-nostdin" in command
        assert command[command.index("-threads") + 1] == "1"
        assert str(source_path) in command
        assert (
            "scale='if(gt(iw,ih),min(1280,iw),-2)':"
            "'if(gt(iw,ih),-2,min(1280,ih))'" in command
        )
        output_path = Path(command[-1])
        Image.new("RGB", (1600, 900), "white").save(output_path, format="WEBP")
        return CompletedProcess(command, 0)

    monkeypatch.setattr(
        "app.services.memory_thumbnails.subprocess.run", run_ffmpeg
    )

    thumbnail_path = create_memory_thumbnail(
        source_path,
        media_root,
        kind=MemoryKind.VIDEO,
        memory_id=memory_id,
        duration_seconds=10,
    )

    assert thumbnail_path == (
        f"thumbnails/{memory_id}/{settings.media_derivative_version}/1280.webp"
    )
    assert (media_root / thumbnail_path).is_file()


def test_thumbnail_url_is_absent_without_derivative() -> None:
    memory = MemoryRead(
        id=uuid.uuid4(),
        title="memory",
        description="",
        kind=MemoryKind.PHOTO,
        status=MemoryStatus.PUBLISHED,
        captured_at=None,
        location=None,
        thumbnail_path=None,
        duration_seconds=None,
        width=None,
        height=None,
        created_at="2026-09-05T00:00:00Z",
        updated_at="2026-09-05T00:00:00Z",
    )
    assert memory.thumbnail_url is None


def test_memory_derivative_isolates_cached_sizes(tmp_path: Path, monkeypatch) -> None:
    settings = configure_test_settings(monkeypatch, tmp_path)
    media_root = Path(settings.media_root)
    source_path = media_root / "photos" / "photo.png"
    source_path.parent.mkdir(parents=True)
    Image.new("RGB", (1600, 900), "white").save(source_path)
    memory_id = uuid.uuid4()

    small_path = create_memory_derivative(
        source_path,
        media_root,
        kind=MemoryKind.PHOTO,
        memory_id=memory_id,
        max_size=480,
    )
    large_path = create_memory_derivative(
        source_path,
        media_root,
        kind=MemoryKind.PHOTO,
        memory_id=memory_id,
        max_size=1280,
    )

    assert small_path == (
        f"thumbnails/{memory_id}/{settings.media_derivative_version}/480.webp"
    )
    assert large_path == (
        f"thumbnails/{memory_id}/{settings.media_derivative_version}/1280.webp"
    )
    with Image.open(media_root / small_path) as small:
        assert small.size == (480, 270)
    with Image.open(media_root / large_path) as large:
        assert large.size == (1280, 720)
