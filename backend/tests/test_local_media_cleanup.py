from collections.abc import Generator
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.db.session import Base, get_db
from app.main import app
from app.models.admin import AdminOperationLog, AdminSession
from app.models.memory import (
    Memory,
    MemoryFile,
    MemoryFileStatus,
    MemoryKind,
    MemoryStatus,
    RemoteFileState,
    RemoteScanTask,
    RemoteScanStatus,
    RemoteThumbnailState,
    RemoteStreamState,
)
from app.services.admin_security import AdminLoginRateLimiter
from app.services.baidu_pan import download_url_cache


def create_database(tmp_path: Path) -> sessionmaker[Session]:
    engine = create_engine(f"sqlite:///{tmp_path / 'cleanup.db'}")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def configure_app(tmp_path: Path, monkeypatch) -> sessionmaker[Session]:
    settings = Settings(
        admin_token="test-token",
        media_root=str(tmp_path / "media"),
        nginx_cache_root=str(tmp_path / "media" / "nginx_cache"),
        admin_login_base_delay=0,
        admin_login_max_delay=0,
    )
    monkeypatch.setattr("app.api.v1.admin.get_settings", lambda: settings)
    monkeypatch.setattr(
        "app.api.v1.admin.admin_login_rate_limiter",
        AdminLoginRateLimiter(max_attempts=5, base_delay=0, max_delay=0),
    )
    session_factory = create_database(tmp_path)

    def override_get_db() -> Generator[Session, None, None]:
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    return session_factory


def add_remote_data(session_factory: sessionmaker[Session], media_root: Path) -> None:
    memory_id = uuid4()
    thumbnail_dir = media_root / "thumbnails" / str(memory_id) / "20260906-ratio-v1"
    thumbnail_dir.mkdir(parents=True)
    (media_root / "tmp").mkdir(parents=True)
    (media_root / "nginx_cache" / "proxy").mkdir(parents=True)
    (thumbnail_dir / "480.webp").write_bytes(b"thumbnail")
    (media_root / "tmp" / "source.tmp").write_bytes(b"temporary")
    (media_root / "nginx_cache" / "proxy" / "cached-file").write_bytes(b"proxy")

    with session_factory.begin() as session:
        memory = Memory(
            id=memory_id,
            title="remote memory",
            kind=MemoryKind.PHOTO,
            status=MemoryStatus.PUBLISHED,
            thumbnail_path="thumbnails/480.webp",
        )
        memory_file = MemoryFile(
            memory_id=memory_id,
            source="baidupan",
            remote_id="remote-1",
            remote_path="/cloud/photo.jpg",
            parent_path="/cloud",
            filename="photo.jpg",
            mime_type="image/jpeg",
            status=MemoryFileStatus.MATCHED,
            remote_state=RemoteFileState.READY,
            thumbnail_state=RemoteThumbnailState.READY,
            stream_state=RemoteStreamState.READY,
        )
        scan_task = RemoteScanTask(
            remote_dir="/apps/Li&Media",
            status=RemoteScanStatus.COMPLETED,
        )
        session.add_all([memory, memory_file, scan_task])


def login(client: TestClient) -> None:
    assert client.post(
        "/api/v1/admin/login",
        json={"token": "test-token"},
    ).status_code == 204


def test_cleanup_dry_run_and_confirm_preserves_admin_and_remote_resources(
    tmp_path: Path, monkeypatch
) -> None:
    session_factory = configure_app(tmp_path, monkeypatch)
    media_root = Path(tmp_path / "media")
    add_remote_data(session_factory, media_root)
    download_url_cache.set("remote-1", "https://baidu.invalid/private-download")
    assert download_url_cache.get("remote-1") is not None

    try:
        with TestClient(app) as client:
            assert client.post("/api/v1/admin/cleanup", json={}).status_code == 401
            login(client)

            dry_run = client.post("/api/v1/admin/cleanup", json={"confirm": False})
            assert dry_run.status_code == 200
            payload = dry_run.json()
            assert payload["dry_run"] is True
            assert payload["stats"] == {
                "memories": 1,
                "remote_file_indexes": 1,
                "scan_tasks": 1,
                "thumbnail_files": 2,
                "nginx_cache_files": 1,
                "estimated_bytes_to_free": 23,
            }
            assert (media_root / "thumbnails").is_dir()

            confirmed = client.post("/api/v1/admin/cleanup", json={"confirm": True})
            assert confirmed.status_code == 200
            result = confirmed.json()
            assert result["dry_run"] is False
            assert result["completed_at"] is not None
            assert result["file_cleanup_error"] is None
            assert result["stats"]["memories"] == 1

            assert client.get("/api/v1/admin/memories").status_code == 200

        with session_factory() as session:
            assert session.scalar(select(Memory.id)) is None
            assert session.scalar(select(MemoryFile.id)) is None
            assert session.scalar(select(RemoteScanTask.id)) is None
            assert session.scalar(select(AdminSession.id)) is not None
            actions = session.scalars(select(AdminOperationLog.action)).all()
            assert "cleanup_local_media" in actions

        assert download_url_cache.get("remote-1") is None
        assert not any((media_root / "thumbnails").rglob("*"))
        assert not any((media_root / "tmp").rglob("*"))
        assert not any((media_root / "nginx_cache" / "proxy").rglob("*"))
    finally:
        download_url_cache.clear()
        app.dependency_overrides.clear()


def test_cleanup_database_failure_rolls_back_and_keeps_files(
    tmp_path: Path, monkeypatch
) -> None:
    session_factory = configure_app(tmp_path, monkeypatch)
    media_root = Path(tmp_path / "media")
    add_remote_data(session_factory, media_root)

    def fail_delete(*args, **kwargs):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr("app.api.v1.admin.delete", fail_delete)

    try:
        with TestClient(app) as client:
            login(client)
            response = client.post("/api/v1/admin/cleanup", json={"confirm": True})

        assert response.status_code == 500
        assert response.json()["detail"] == "本地媒体索引清理失败，数据库已回滚"

        with session_factory() as session:
            assert session.scalar(select(Memory.id)) is not None
            assert session.scalar(select(MemoryFile.id)) is not None
            assert session.scalar(select(RemoteScanTask.id)) is not None

        assert (media_root / "thumbnails").is_dir()
    finally:
        app.dependency_overrides.clear()
