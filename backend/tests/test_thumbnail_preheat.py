import uuid
from pathlib import Path
import time

from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select

from app.db.session import get_session_factory
from app.main import app
from app.models.memory import Memory, MemoryFile
from tests.test_admin_security import configure_admin_app


def test_admin_can_preheat_missing_thumbnail(tmp_path: Path, monkeypatch) -> None:
    session_factory = configure_admin_app(tmp_path, monkeypatch)
    media_root = tmp_path / "media"
    source_dir = media_root / "photos"
    source_dir.mkdir(parents=True)
    source_path = source_dir / "photo.png"
    Image.new("RGB", (900, 450), "green").save(source_path)
    memory_id = uuid.uuid4()

    with session_factory.begin() as session:
        memory = Memory(
            id=memory_id,
            title="预热样例",
            kind="photo",
            status="published",
        )
        memory_file = MemoryFile(
            memory_id=memory_id,
            source="baidupan",
            remote_id="remote-preheat",
            remote_path="/cloud/photo.png",
            parent_path="/cloud",
            filename="photo.png",
            mime_type="image/png",
            source_path="photos/photo.png",
            thumbnail_state="missing",
        )
        session.add_all([memory, memory_file])

    try:
        app.dependency_overrides[get_session_factory] = lambda: session_factory
        with TestClient(app) as client:
            assert client.post(
                "/api/v1/admin/login",
                json={"token": "test-token"},
            ).status_code == 204

            response = client.post(
                "/api/v1/admin/thumbnails/preheat",
                json={"max_size": "480", "kind": "photo", "limit": 1},
            )
            assert response.status_code == 202
            assert response.json()["status"] in {"queued", "running", "completed"}

            payload = None
            for _ in range(50):
                latest = client.get("/api/v1/admin/thumbnails/preheat/latest")
                assert latest.status_code == 200
                payload = latest.json()
                if payload and payload["processed"] == 1:
                    break
                time.sleep(0.02)

            assert payload["total"] == 1
            assert payload["processed"] == 1
            assert payload["generated"] == 1
            assert payload["failed"] == 0
            assert payload["status"] == "completed", payload

        with session_factory() as session:
            memory = session.get(Memory, memory_id)
            memory_file = session.scalar(select(MemoryFile))
            assert memory is not None
            assert memory_file is not None
            assert memory.thumbnail_path is not None
            assert memory.thumbnail_path.endswith("480.webp")
            assert (media_root / memory.thumbnail_path).is_file()
            assert memory_file.thumbnail_state == "ready"
    finally:
        app.dependency_overrides.clear()
