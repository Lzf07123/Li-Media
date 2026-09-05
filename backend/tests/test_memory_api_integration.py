import io
from collections.abc import Generator
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.db.session import Base, get_db
from app.main import app


def override_database(session_factory: sessionmaker[Session]) -> Generator[Session, None, None]:
    session = session_factory()
    try:
        yield session
    finally:
        session.close()


def test_public_and_admin_memory_lifecycle(tmp_path: Path, monkeypatch) -> None:
    media_root = tmp_path / "media"
    media_root.mkdir()
    settings = Settings(
        admin_token="test-token",
        media_root=str(media_root),
        admin_login_base_delay=0,
        admin_login_max_delay=0,
    )
    monkeypatch.setattr("app.api.v1.admin.get_settings", lambda: settings)
    monkeypatch.setattr("app.api.v1.memories.get_settings", lambda: settings)

    engine = create_engine(f"sqlite:///{tmp_path / 'memories.db'}")
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    def override_get_db() -> Generator[Session, None, None]:
        yield from override_database(session_factory)

    app.dependency_overrides[get_db] = override_get_db
    image_buffer = io.BytesIO()
    Image.new("RGB", (2400, 1200), "white").save(image_buffer, format="PNG")

    try:
        with TestClient(app) as client:
            assert client.post(
                "/api/v1/admin/login",
                json={"token": "test-token"},
            ).status_code == 204

            upload = client.post(
                "/api/v1/admin/memories",
                files={"file": ("lake.png", image_buffer.getvalue(), "image/png")},
                data={"description": "公开集成测试"},
            )
            assert upload.status_code == 200
            memory = upload.json()
            memory_id = memory["id"]
            assert memory["status"] == "published"
            assert memory["thumbnail_url"] == f"/api/v1/memories/{memory_id}/thumbnail"

            admin_list = client.get("/api/v1/admin/memories")
            assert admin_list.status_code == 200
            assert admin_list.json()["total"] == 1

            public_list = client.get("/api/v1/memories")
            assert public_list.status_code == 200
            assert public_list.json()["total"] == 1
            assert public_list.json()["items"][0]["title"] == "lake"

            detail = client.get(f"/api/v1/memories/{memory_id}")
            assert detail.status_code == 200
            assert detail.json()["description"] == "公开集成测试"

            file_response = client.get(f"/api/v1/memories/{memory_id}/file")
            assert file_response.status_code == 200
            assert file_response.headers["content-type"] == "image/png"

            thumbnail_response = client.get(f"/api/v1/memories/{memory_id}/thumbnail")
            assert thumbnail_response.status_code == 200
            assert thumbnail_response.headers["content-type"] == "image/webp"

            assert client.patch(
                f"/api/v1/admin/memories/{memory_id}",
                json={"status": "hidden"},
            ).status_code == 200
            assert client.get("/api/v1/memories").json()["total"] == 0
            assert client.get(f"/api/v1/memories/{memory_id}").status_code == 404
            assert client.get(f"/api/v1/memories/{memory_id}/file").status_code == 404
            assert client.get(
                f"/api/v1/memories/{memory_id}/thumbnail"
            ).status_code == 404

            assert client.patch(
                f"/api/v1/admin/memories/{memory_id}",
                json={"status": "published"},
            ).status_code == 200
            assert client.get("/api/v1/memories").json()["total"] == 1
            assert client.get(f"/api/v1/memories/{memory_id}").status_code == 200

            assert client.delete(f"/api/v1/admin/memories/{memory_id}").status_code == 204
            assert client.get("/api/v1/memories").json()["total"] == 0
            assert client.get(f"/api/v1/memories/{memory_id}").status_code == 404
    finally:
        app.dependency_overrides.clear()
