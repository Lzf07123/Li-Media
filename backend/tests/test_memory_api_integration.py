from collections.abc import Generator
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.db.session import Base, get_db
from app.main import app
from app.models.admin import AdminOperationLog
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


def add_memory(
    session_factory: sessionmaker[Session],
    *,
    title: str,
    source: str,
    status: MemoryStatus,
) -> str:
    memory_id = uuid4()
    with session_factory.begin() as session:
        session.add(
            Memory(
                id=memory_id,
                title=title,
                kind=MemoryKind.PHOTO,
                status=status,
            )
        )
        session.add(
            MemoryFile(
                memory_id=memory_id,
                source=source,
                remote_id="remote-1" if source == "baidupan" else None,
                remote_path="/cloud/photo.jpg" if source == "baidupan" else "photo.jpg",
                parent_path="/cloud" if source == "baidupan" else "",
                filename="photo.jpg",
                mime_type="image/jpeg",
                status=MemoryFileStatus.MATCHED,
                remote_state=RemoteFileState.READY,
                thumbnail_state=RemoteThumbnailState.MISSING,
                stream_state=RemoteStreamState.READY,
            )
        )
    return str(memory_id)


def test_remote_only_admin_and_public_lifecycle(tmp_path: Path, monkeypatch) -> None:
    media_root = tmp_path / "media"
    media_root.mkdir()
    settings = Settings(
        admin_token="test-token",
        media_root=str(media_root),
        baidu_access_token="test-access-token",
        baidu_oauth_client_id="test-client-id",
        baidu_oauth_client_secret="test-client-secret",
        baidu_credentials_path=str(tmp_path / "baidu-token.json"),
        baidu_sync_dir="/apps/Li&Media",
        baidu_oauth_redirect_uri="",
        public_base_url="http://127.0.0.1:8080",
        admin_login_base_delay=0,
        admin_login_max_delay=0,
    )
    monkeypatch.setattr("app.api.v1.admin.get_settings", lambda: settings)

    session_factory = create_database(tmp_path)
    remote_id = add_memory(
        session_factory,
        title="网盘照片",
        source="baidupan",
        status=MemoryStatus.PUBLISHED,
    )
    local_id = add_memory(
        session_factory,
        title="旧本地上传",
        source="upload",
        status=MemoryStatus.PUBLISHED,
    )

    def override_get_db() -> Generator[Session, None, None]:
        yield from override_database(session_factory)

    baidu_client_calls: list[object] = []

    class GuardedBaiduClient:
        def __init__(self, settings: Settings) -> None:
            baidu_client_calls.append(settings)

    app.dependency_overrides[get_db] = override_get_db
    monkeypatch.setattr("app.api.v1.admin.BaiduPanClient", GuardedBaiduClient)
    try:
        with TestClient(app) as client:
            assert client.post(
                "/api/v1/admin/login",
                json={"token": "test-token"},
            ).status_code == 204

            upload = client.post(
                "/api/v1/admin/memories",
                files={"file": ("lake.png", b"not-media", "image/png")},
            )
            assert upload.status_code == 405

            config = client.get("/api/v1/admin/remote-config")
            assert config.status_code == 200
            assert config.json() == {
                "configured": True,
                "authorized": False,
                "oauth_configured": True,
                "scan_dir": "/apps/Li&Media",
                "redirect_uri": "http://127.0.0.1:8080/admin/baidu/callback",
                "docs_url": "https://pan.baidu.com/union/doc/",
                "token_expires_at": None,
            }

            admin_list = client.get("/api/v1/admin/memories")
            assert admin_list.status_code == 200
            assert admin_list.json()["total"] == 1
            assert [item["id"] for item in admin_list.json()["items"]] == [remote_id]

            public_list = client.get("/api/v1/memories")
            assert public_list.status_code == 200
            assert public_list.json()["total"] == 1
            assert public_list.json()["items"][0]["title"] == "网盘照片"
            assert public_list.json()["counts"] == {"photo": 1, "video": 0}

            assert client.get(f"/api/v1/memories/{local_id}").status_code == 404
            assert client.get(f"/api/v1/memories/{local_id}/file").status_code == 404
            assert client.get(f"/api/v1/memories/{remote_id}").status_code == 200
            assert client.get(f"/api/v1/memories/{remote_id}/file").status_code == 502

            assert client.patch(
                "/api/v1/admin/memories/batch",
                json={"ids": [remote_id, local_id], "status": "hidden"},
            ).status_code == 404

            assert client.patch(
                "/api/v1/admin/memories/batch",
                json={"ids": [remote_id], "status": "hidden"},
            ).status_code == 200
            assert client.get("/api/v1/memories").json()["total"] == 0

            assert client.patch(
                "/api/v1/admin/memories/batch",
                json={
                    "ids": [remote_id],
                    "status": "published",
                    "title": "更新后的网盘照片",
                    "location": "汕头",
                },
            ).status_code == 200

            export = client.post(
                "/api/v1/admin/memories/export",
                json={"ids": [remote_id]},
            )
            assert export.status_code == 200
            assert export.json()["items"][0]["title"] == "更新后的网盘照片"
            assert export.json()["items"][0]["location"] == "汕头"

            assert client.delete(
                f"/api/v1/admin/memories/{local_id}"
            ).status_code == 404
            assert client.delete(
                f"/api/v1/admin/memories/{remote_id}"
            ).status_code == 204
            assert client.get("/api/v1/memories").json()["total"] == 0

            with session_factory() as session:
                delete_log = session.scalar(
                    select(AdminOperationLog)
                    .where(AdminOperationLog.action == "delete")
                    .order_by(AdminOperationLog.created_at.desc())
                    .limit(1)
                )
                assert delete_log is not None
                assert "remote_resource=unchanged" in (delete_log.detail or "")

            assert baidu_client_calls == []
    finally:
        app.dependency_overrides.clear()
