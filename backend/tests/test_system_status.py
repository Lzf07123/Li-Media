from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker
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
from app.schemas.responses import ServiceStatus
from tests.test_admin_security import configure_admin_app
def test_system_status_requires_admin_session(tmp_path: Path, monkeypatch) -> None:
    configure_admin_app(tmp_path, monkeypatch)
    try:
        with TestClient(app) as client:
            assert client.get("/api/v1/admin/system/status").status_code == 401
    finally:
        app.dependency_overrides.clear()


def test_system_status_reports_backend_remote_and_resources(
    tmp_path: Path, monkeypatch
) -> None:
    session_factory = configure_admin_app(tmp_path, monkeypatch)
    memory_id = uuid4()
    with session_factory.begin() as session:
        session.add(
            Memory(
                id=memory_id,
                title="状态样例",
                kind=MemoryKind.VIDEO,
                status=MemoryStatus.PUBLISHED,
            )
        )
        session.add(
            MemoryFile(
                memory_id=memory_id,
                source="baidupan",
                remote_id="remote-1",
                remote_path="/cloud/video.mp4",
                parent_path="/cloud",
                filename="video.mp4",
                mime_type="video/mp4",
                status=MemoryFileStatus.MATCHED,
                remote_state=RemoteFileState.READY,
                thumbnail_state=RemoteThumbnailState.READY,
                stream_state=RemoteStreamState.READY,
            )
        )

    monkeypatch.setattr(
        "app.services.system_status.get_redis_status",
        lambda redis_url: ServiceStatus(status="ok"),
    )

    try:
        with TestClient(app) as client:
            assert client.post(
                "/api/v1/admin/login",
                json={"token": "test-token"},
            ).status_code == 204

            response = client.get("/api/v1/admin/system/status")
            assert response.status_code == 200
            payload = response.json()

            assert payload["backend"]["database"]["status"] == "ok"
            assert payload["backend"]["redis"]["status"] == "ok"
            assert payload["backend"]["stack_guard"].startswith("task thread pool")
            assert payload["remote_storage"]["provider"] == "baidupan"
            assert payload["remote_storage"]["counts"]["total"] == 1
            assert payload["remote_storage"]["counts"]["remote_ready"] == 1
            assert payload["remote_storage"]["counts"]["thumbnail_ready"] == 1
            assert payload["remote_storage"]["counts"]["stream_ready"] == 1
            assert payload["resources"]["limits"]["backend_memory_bytes"] == (
                256 * 1024 * 1024
            )
            assert payload["backend"]["configuration"] == {
                "preheat_concurrency_limit": 2,
                "preheat_queue_limit": 64,
                "preheat_wait_timeout_seconds": 2.0,
                "derivative_concurrency_limit": 1,
                "derivative_queue_limit": 32,
                "derivative_wait_timeout_seconds": 15.0,
                "direct_probe_concurrency_limit": 4,
                "direct_probe_queue_limit": 16,
                "scan_concurrency_limit": 1,
                "stream_global_concurrency_limit": 16,
                "stream_user_concurrency_limit": 3,
                "temp_max_files": 2,
                "temp_disk_quota_bytes": 4294967296,
            }
            assert payload["resources"]["filesystem"]["total_bytes"] > 0
            assert payload["resources"]["caches"]["derived_thumbnails"]["status"] == "ok"
            assert payload["resources"]["caches"]["temporary"]["status"] == "ok"
            assert payload["resources"]["caches"]["nginx"]["status"] == "ok"
            for task_status in payload["tasks"].values():
                assert "wait_timeout_seconds" in task_status
            assert "access_token" not in response.text.lower()
            assert "client_secret" not in response.text.lower()
    finally:
        app.dependency_overrides.clear()
