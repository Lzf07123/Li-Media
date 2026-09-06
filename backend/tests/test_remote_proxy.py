from collections.abc import Generator
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
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
    RemoteThumbnailState,
    RemoteStreamState,
)
from app.services.baidu_pan import BaiduPanError, BaiduRemoteItem


class FakeResponse:
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks

    def iter_bytes(self):
        yield from self.chunks

    def close(self) -> None:
        return None


class FakeProxyClient:
    def __init__(self, *, thumbnail_fails: bool = False) -> None:
        self.thumbnail_fails = thumbnail_fails
        self.thumbnail_sizes: list[str] = []

    def open_stream(self, remote_id: str, *, range_header: str | None):
        assert remote_id == "remote-1"
        return (
            206,
            2,
            "bytes 0-1/3",
            "video/mp4",
            FakeResponse([b"ab"]),
        )

    def get_file_metadata(self, remote_id: str) -> BaiduRemoteItem:
        return BaiduRemoteItem(
            remote_id=remote_id,
            remote_path="/remote/photo.jpg",
            filename="photo.jpg",
            parent_path="/remote",
            is_dir=False,
            size_bytes=3,
            modified_at=None,
            md5=None,
            category=None,
            thumbnail_url="https://baidu.invalid/private-thumbnail",
            raw_metadata_summary={},
        )

    def get_thumbnail(self, remote_id: str, *, requested_size: str = "medium") -> tuple[bytes, str]:
        self.thumbnail_sizes.append(requested_size)
        if self.thumbnail_fails:
            raise BaiduPanError("远程缩略图不可用")
        return b"thumb", "image/webp"

    def resolve_direct_url(self, remote_id: str) -> tuple[str, int]:
        assert remote_id == "remote-1"
        return "https://baidu.invalid/private-download?access_token=test-token", 300


def create_database(tmp_path: Path) -> sessionmaker[Session]:
    engine = create_engine(f"sqlite:///{tmp_path / 'memories.db'}")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def configure_app(tmp_path: Path, monkeypatch, *, thumbnail_fails=False):
    session_factory = create_database(tmp_path)
    settings = Settings(
        admin_token="test-token",
        baidu_access_token="test-access-token",
        media_root=str(tmp_path / "media"),
    )
    monkeypatch.setattr("app.api.v1.memories.get_settings", lambda: settings)
    monkeypatch.setattr(
        "app.api.v1.memories.BaiduPanClient",
        lambda settings: FakeProxyClient(thumbnail_fails=thumbnail_fails),
    )

    def override_get_db() -> Generator[Session, None, None]:
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    return session_factory


def add_remote_memory(session_factory: sessionmaker[Session], *, published=True):
    with session_factory.begin() as session:
        memory_id = uuid4()
        memory = Memory(
            id=memory_id,
            title="remote video",
            kind=MemoryKind.VIDEO,
            status=MemoryStatus.PUBLISHED if published else MemoryStatus.HIDDEN,
        )
        memory_file = MemoryFile(
            memory_id=memory.id,
            source="baidupan",
            remote_id="remote-1",
            remote_path="/remote/video.mp4",
            parent_path="/remote",
            filename="video.mp4",
            mime_type="video/mp4",
            size_bytes=3,
            status=MemoryFileStatus.MATCHED,
            remote_state=RemoteFileState.READY,
            thumbnail_state=RemoteThumbnailState.READY,
            stream_state=RemoteStreamState.READY,
        )
        session.add_all([memory, memory_file])
    return memory.id


def test_published_stream_supports_range_without_exposing_direct_link(
    tmp_path: Path, monkeypatch
) -> None:
    session_factory = configure_app(tmp_path, monkeypatch)
    memory_id = add_remote_memory(session_factory)

    try:
        with TestClient(app) as client:
            response = client.get(
                f"/api/v1/memories/{memory_id}/stream",
                headers={"Range": "bytes=0-1"},
            )

        assert response.status_code == 206
        assert response.content == b"ab"
        assert response.headers["content-range"] == "bytes 0-1/3"
        assert response.headers["accept-ranges"] == "bytes"
        assert "private-thumbnail" not in response.text
        assert all("private-thumbnail" not in value for value in response.headers.values())
    finally:
        app.dependency_overrides.clear()


def test_remote_thumbnail_is_proxied_for_published_memory(
    tmp_path: Path, monkeypatch
) -> None:
    session_factory = configure_app(tmp_path, monkeypatch)
    memory_id = add_remote_memory(session_factory)

    try:
        with TestClient(app) as client:
            response = client.get(f"/api/v1/memories/{memory_id}/thumbnail")

        assert response.status_code == 200
        assert response.content == b"thumb"
        assert response.headers["content-type"] == "image/webp"
        assert response.headers["cache-control"].startswith("public, max-age=86400")
        assert response.headers["etag"] == f'"{memory_id}-medium"'
        assert "private-thumbnail" not in response.text
    finally:
        app.dependency_overrides.clear()


def test_remote_thumbnail_failure_is_logged_and_hidden_is_not_served(
    tmp_path: Path, monkeypatch
) -> None:
    session_factory = configure_app(tmp_path, monkeypatch, thumbnail_fails=True)
    published_id = add_remote_memory(session_factory)
    hidden_id = add_remote_memory(session_factory, published=False)

    try:
        with TestClient(app) as client:
            hidden_response = client.get(
                f"/api/v1/memories/{hidden_id}/thumbnail"
            )
            assert hidden_response.status_code == 404

            response = client.get(f"/api/v1/memories/{published_id}/thumbnail")
            assert response.status_code == 502
            assert response.json()["detail"] == "远程缩略图不可用"

        with session_factory() as session:
            memory_file = session.scalar(select(MemoryFile))
            assert memory_file.thumbnail_state == RemoteThumbnailState.FAILED
    finally:
        app.dependency_overrides.clear()


def test_direct_media_url_is_returned_for_published_memory_only(
    tmp_path: Path, monkeypatch
) -> None:
    session_factory = configure_app(tmp_path, monkeypatch)
    published_id = add_remote_memory(session_factory)
    hidden_id = add_remote_memory(session_factory, published=False)

    try:
        with TestClient(app) as client:
            hidden_response = client.get(
                f"/api/v1/memories/{hidden_id}/direct-url"
            )
            assert hidden_response.status_code == 404

            response = client.get(
                f"/api/v1/memories/{published_id}/direct-url"
            )
            assert response.status_code == 200
            payload = response.json()
            assert payload["direct_url"].startswith("https://baidu.invalid/")
            assert payload["mime_type"] == "video/mp4"
            assert payload["size_bytes"] == 3
            assert payload["expires_at"] is not None
            assert response.headers["cache-control"] == "no-store"
    finally:
        app.dependency_overrides.clear()
