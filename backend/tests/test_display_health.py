from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.session import Base
from app.db.session import get_db
from app.main import app
from app.models.memory import (
    BrowserCompatibilityState,
    Memory,
    MemoryFile,
    MemoryKind,
    MemoryStatus,
    RemoteFileState,
    RemoteStreamState,
    RemoteThumbnailState,
)
from tests.test_admin_security import configure_admin_app


def create_database(tmp_path: Path) -> sessionmaker:
    engine = create_engine(f"sqlite:///{tmp_path / 'display.db'}")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def add_memory(
    session_factory: sessionmaker,
    title: str,
    kind: MemoryKind,
    *,
    remote_state=RemoteFileState.READY,
    thumbnail_state=RemoteThumbnailState.READY,
    stream_state=RemoteStreamState.READY,
):
    memory_id = uuid4()
    with session_factory.begin() as session:
        memory = Memory(
            id=memory_id,
            title=title,
            kind=kind,
            status=MemoryStatus.PUBLISHED,
        )
        session.add(memory)
        session.flush()
        session.add(
            MemoryFile(
                memory_id=memory_id,
                source="baidupan",
                remote_id=str(memory_id),
                remote_path=f"/cloud/{memory_id}",
                filename=f"{memory_id}.jpg",
                mime_type="image/jpeg",
                remote_state=remote_state,
                thumbnail_state=thumbnail_state,
                stream_state=stream_state,
                browser_compatibility=BrowserCompatibilityState.SUPPORTED,
            )
        )
    return memory_id


def test_public_endpoints_exclude_unrenderable_media(tmp_path: Path) -> None:
    session_factory = create_database(tmp_path)
    ready_photo = add_memory(session_factory, title="ready photo", kind=MemoryKind.PHOTO)
    failed_photo = add_memory(
        session_factory,
        title="failed photo",
        kind=MemoryKind.PHOTO,
        thumbnail_state=RemoteThumbnailState.FAILED,
    )
    ready_video = add_memory(
        session_factory,
        title="ready video",
        kind=MemoryKind.VIDEO,
        thumbnail_state=RemoteThumbnailState.FAILED,
    )
    unsupported_video = add_memory(
        session_factory,
        title="unsupported video",
        kind=MemoryKind.VIDEO,
        thumbnail_state=RemoteThumbnailState.READY,
    )
    with session_factory.begin() as session:
        memory = session.get(Memory, unsupported_video)
        memory.files[0].browser_compatibility = BrowserCompatibilityState.UNSUPPORTED

    def override_get_db():
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    try:
        with TestClient(app) as client:
            listed = client.get("/api/v1/memories").json()
            assert {item["title"] for item in listed["items"]} == {
                "ready photo",
                "ready video",
            }
            assert listed["counts"] == {"photo": 1, "video": 1}
            assert all(item["media_display_state"] == "displayable" for item in listed["items"])

            recommended = client.get("/api/v1/memories/recommend?limit=10").json()
            assert {item["title"] for item in recommended} == {"ready photo", "ready video"}

            assert client.get(f"/api/v1/memories/{ready_photo}").status_code == 200
            assert client.get(f"/api/v1/memories/{failed_photo}").status_code == 404
            assert client.get(f"/api/v1/memories/{unsupported_video}/thumbnail").status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_admin_list_counts_and_filters_display_health(tmp_path: Path, monkeypatch) -> None:
    session_factory = configure_admin_app(tmp_path, monkeypatch)
    add_memory(session_factory, title="ready", kind=MemoryKind.PHOTO)
    add_memory(
        session_factory,
        title="excluded",
        kind=MemoryKind.PHOTO,
        thumbnail_state=RemoteThumbnailState.FAILED,
    )

    try:
        with TestClient(app) as client:
            assert client.post(
                "/api/v1/admin/login",
                json={"token": "test-token"},
            ).status_code == 204

            payload = client.get("/api/v1/admin/memories").json()
            assert payload["display_counts"] == {"displayable": 1, "excluded": 1}
            assert payload["items"][0]["media_display_state"] in {
                "displayable",
                "excluded",
            }

            excluded = client.get("/api/v1/admin/memories?display=excluded").json()
            assert excluded["total"] == 1
            assert excluded["items"][0]["title"] == "excluded"
            assert excluded["items"][0]["media_display_state"] == "excluded"
    finally:
        app.dependency_overrides.clear()
