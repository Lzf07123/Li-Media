from collections.abc import Generator
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
from PIL import Image
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
    RemoteThumbnailState,
    RemoteStreamState,
)
from app.services.admin_security import AdminLoginLimitError, AdminLoginRateLimiter


def create_database(tmp_path: Path) -> sessionmaker[Session]:
    engine = create_engine(f"sqlite:///{tmp_path / 'admin.db'}")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def override_database(session_factory: sessionmaker[Session]) -> Generator[Session, None, None]:
    session = session_factory()
    try:
        yield session
    finally:
        session.close()


def configure_admin_app(tmp_path: Path, monkeypatch) -> sessionmaker[Session]:
    media_root = tmp_path / "media"
    media_root.mkdir(parents=True, exist_ok=True)
    settings = Settings(
        admin_token="test-token",
        media_root=str(media_root),
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
        yield from override_database(session_factory)

    app.dependency_overrides[get_db] = override_get_db
    return session_factory


def test_admin_session_is_http_only_and_revokes_on_logout(tmp_path: Path, monkeypatch) -> None:
    session_factory = configure_admin_app(tmp_path, monkeypatch)
    try:
        with TestClient(app) as client:
            login_response = client.post(
                "/api/v1/admin/login",
                json={"token": "test-token"},
            )
            assert login_response.status_code == 204
            assert "limedia_admin_session" in client.cookies
            assert "HttpOnly" in login_response.headers["set-cookie"]
            assert client.get("/api/v1/admin/memories").status_code == 200

            logout_response = client.post("/api/v1/admin/logout")
            assert logout_response.status_code == 204
            assert client.get("/api/v1/admin/memories").status_code == 401

        with session_factory() as session:
            admin_session = session.scalar(select(AdminSession))
            logs = session.scalars(select(AdminOperationLog)).all()

            assert admin_session is not None
            assert admin_session.token_hash != "test-token"
            assert admin_session.revoked_at is not None
            assert [log.action for log in logs] == ["login", "logout"]
    finally:
        app.dependency_overrides.clear()


def test_admin_operation_log_covers_remote_lifecycle(tmp_path: Path, monkeypatch) -> None:
    session_factory = configure_admin_app(tmp_path, monkeypatch)
    memory_id = uuid4()
    with session_factory.begin() as session:
        session.add(
            Memory(
                id=memory_id,
                title="网盘回忆",
                kind=MemoryKind.PHOTO,
                status=MemoryStatus.PUBLISHED,
            )
        )
        session.add(
            MemoryFile(
                memory_id=memory_id,
                source="baidupan",
                remote_id="remote-1",
                remote_path="/cloud/photo.jpg",
                parent_path="/cloud",
                filename="photo.jpg",
                mime_type="image/jpeg",
                status=MemoryFileStatus.MATCHED,
                remote_state=RemoteFileState.READY,
                thumbnail_state=RemoteThumbnailState.MISSING,
                stream_state=RemoteStreamState.READY,
            )
        )

    try:
        with TestClient(app) as client:
            assert client.post(
                "/api/v1/admin/login",
                json={"token": "test-token"},
            ).status_code == 204

            assert client.post("/api/v1/admin/memories").status_code == 405
            assert client.patch(
                f"/api/v1/admin/memories/{memory_id}",
                json={"status": "hidden"},
            ).status_code == 200
            assert client.patch(
                f"/api/v1/admin/memories/{memory_id}",
                json={"status": "published"},
            ).status_code == 200
            assert client.delete(f"/api/v1/admin/memories/{memory_id}").status_code == 204

        with session_factory() as session:
            actions = session.scalars(select(AdminOperationLog.action)).all()

        assert set(actions) == {"login", "hide", "publish", "delete"}
        assert len(actions) == 4
    finally:
        app.dependency_overrides.clear()


def test_admin_login_rate_limiter_locks_after_failures() -> None:
    limiter = AdminLoginRateLimiter(max_attempts=2, base_delay=0, max_delay=0)

    limiter.check("127.0.0.1")
    limiter.record_failure("127.0.0.1")
    limiter.check("127.0.0.1")
    limiter.record_failure("127.0.0.1")

    try:
        limiter.check("127.0.0.1")
    except AdminLoginLimitError as exc:
        assert exc.retry_after_seconds >= 1
    else:
        raise AssertionError("expected rate limiter to lock")
