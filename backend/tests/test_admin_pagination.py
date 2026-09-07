from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from app.main import app
from app.models.memory import Memory, MemoryFile, MemoryKind, MemoryStatus
from app.models.memory import MemoryKind
from tests.test_admin_security import configure_admin_app


def add_remote_memory(
    session_factory: sessionmaker,
    *,
    kind: MemoryKind,
    title: str,
) -> None:
    memory_id = uuid4()
    with session_factory.begin() as session:
        memory = Memory(
            id=memory_id,
            title=title,
            kind=kind,
            status=MemoryStatus.PUBLISHED,
        )
        memory_file = MemoryFile(
            memory_id=memory_id,
            source="baidupan",
            remote_id=str(memory_id),
            remote_path=f"/cloud/{memory_id}.jpg",
            parent_path="/cloud",
            filename=f"{memory_id}.jpg",
            mime_type="image/jpeg" if kind == MemoryKind.PHOTO else "video/mp4",
        )
        session.add_all([memory, memory_file])


def test_admin_memories_are_paginated_and_filtered(tmp_path: Path, monkeypatch) -> None:
    session_factory = configure_admin_app(tmp_path, monkeypatch)
    add_remote_memory(session_factory, kind=MemoryKind.PHOTO, title="照片一")
    add_remote_memory(session_factory, kind=MemoryKind.PHOTO, title="照片二")
    add_remote_memory(session_factory, kind=MemoryKind.VIDEO, title="视频一")

    try:
        with TestClient(app) as client:
            assert client.post(
                "/api/v1/admin/login",
                json={"token": "test-token"},
            ).status_code == 204

            first = client.get("/api/v1/admin/memories?page=1&page_size=2")
            assert first.status_code == 200
            first_payload = first.json()
            assert first_payload["total"] == 3
            assert first_payload["page"] == 1
            assert first_payload["page_size"] == 2
            assert first_payload["counts"] == {"photo": 2, "video": 1}
            assert len(first_payload["items"]) == 2

            second = client.get("/api/v1/admin/memories?page=2&page_size=2")
            assert second.status_code == 200
            assert len(second.json()["items"]) == 1

            videos = client.get("/api/v1/admin/memories?kind=video")
            assert videos.status_code == 200
            videos_payload = videos.json()
            assert videos_payload["total"] == 1
            assert videos_payload["counts"] == {"photo": 0, "video": 1}
            assert videos_payload["items"][0]["title"] == "视频一"

            search = client.get("/api/v1/admin/memories?keyword=视频")
            assert search.status_code == 200
            search_payload = search.json()
            assert search_payload["total"] == 1
            assert search_payload["items"][0]["title"] == "视频一"
    finally:
        app.dependency_overrides.clear()
