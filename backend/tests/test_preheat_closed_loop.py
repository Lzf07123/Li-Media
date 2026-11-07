"""预热逻辑闭环：HTTP 启动 → worker 本地源派生 → 状态落库 →
公开面翻转 → 缩略图路由可达 → 历史落盘与重启恢复。

不触碰百度凭证：被预热文件走本地源路径；冷却期失败文件用
「FAILED + transient 类型」构造——候选枚举默认被冷却排除、公开面
按失败隐藏，闭环全程零远端调用。
"""

import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select

from app.core.config import Settings
from app.main import app
from app.models.memory import (
    BrowserCompatibilityState,
    DerivativeCacheStatus,
    DerivativeFailureKind,
    Memory,
    MemoryDerivativeCache,
    MemoryFile,
    MemoryKind,
    MemoryStatus,
    RemoteFileState,
    RemoteThumbnailState,
    RemoteStreamState,
)
from app.services.thumbnail_preheat import (
    restore_preheat_history_from_disk,
    thumbnail_preheat_registry,
)
from tests.test_admin_security import configure_admin_app


def test_preheat_closed_loop_from_admin_api_to_public_surface(
    tmp_path: Path,
    monkeypatch,
) -> None:
    session_factory = configure_admin_app(tmp_path, monkeypatch)
    media_root = tmp_path / "media"
    settings = Settings(
        admin_token="test-token",
        media_root=str(media_root),
        nginx_cache_root=str(tmp_path / "nginx-cache"),
        preheat_retry_cooldown_seconds=3600,
    )
    monkeypatch.setattr("app.api.v1.admin.get_settings", lambda: settings)
    monkeypatch.setattr("app.api.v1.memories.get_settings", lambda: settings)
    monkeypatch.setattr(
        "app.services.thumbnail_preheat.get_settings",
        lambda: settings,
    )

    # 待预热记忆：本地源真实 PNG，三档全部缺失
    ready_id = uuid4()
    source_dir = media_root / "photos"
    source_dir.mkdir(parents=True)
    Image.new("RGB", (1600, 1000), "teal").save(source_dir / "loop.png")
    Image.new("RGB", (1200, 800), "plum").save(source_dir / "cooldown.png")

    # 冷却期失败记忆：RETRYABLE + 最近失败（updated_at 默认即现在），
    # 候选枚举默认被冷却排除；include_failed 强制找回后走本地源重新
    # 派生并自愈为 READY——公开面随之完整。
    cooldown_id = uuid4()

    with session_factory.begin() as session:
        ready_memory = Memory(
            id=ready_id,
            title="闭环样例",
            kind=MemoryKind.PHOTO,
            status=MemoryStatus.PUBLISHED,
            captured_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
        )
        ready_file = MemoryFile(
            memory_id=ready_id,
            source="baidupan",
            remote_id="remote-loop-ready",
            remote_path="/cloud/loop.png",
            parent_path="/cloud",
            filename="loop.png",
            mime_type="image/png",
            source_path="photos/loop.png",
            remote_state=RemoteFileState.READY,
            thumbnail_state=RemoteThumbnailState.MISSING,
            stream_state=RemoteStreamState.READY,
            browser_compatibility=BrowserCompatibilityState.SUPPORTED,
        )
        cooldown_memory = Memory(
            id=cooldown_id,
            title="冷却期失败样例",
            kind=MemoryKind.PHOTO,
            status=MemoryStatus.PUBLISHED,
            captured_at=datetime(2026, 6, 2, tzinfo=timezone.utc),
        )
        cooldown_file = MemoryFile(
            memory_id=cooldown_id,
            source="baidupan",
            remote_id="remote-loop-cooldown",
            remote_path="/cloud/cooldown.png",
            parent_path="/cloud",
            filename="cooldown.png",
            mime_type="image/png",
            source_path="photos/cooldown.png",
            remote_state=RemoteFileState.READY,
            thumbnail_state=RemoteThumbnailState.RETRYABLE,
            thumbnail_failure_kind=DerivativeFailureKind.REMOTE_UNAVAILABLE.value,
            stream_state=RemoteStreamState.READY,
            browser_compatibility=BrowserCompatibilityState.SUPPORTED,
        )
        session.add_all(
            [ready_memory, ready_file, cooldown_memory, cooldown_file]
        )

    try:
        app.dependency_overrides[get_session_factory_key()] = lambda: session_factory
        with TestClient(app) as client:
            assert client.post(
                "/api/v1/admin/login",
                json={"token": "test-token"},
            ).status_code == 204

            # 预估口径：默认冷却排除失败项；include_failed 强制找回
            default_preview = client.get(
                "/api/v1/admin/thumbnails/preheat/preview",
                params={"sizes": ["240"], "include_failed": "false"},
            )
            forced_preview = client.get(
                "/api/v1/admin/thumbnails/preheat/preview",
                params={"sizes": ["240"], "include_failed": "true"},
            )
            assert default_preview.json() == {"total": 1}
            assert forced_preview.json() == {"total": 2}

            # 启动三档预热并强制包含冷却期失败项：两条记忆全部重新派生
            response = client.post(
                "/api/v1/admin/thumbnails/preheat",
                json={
                    "sizes": ["240", "480", "1280"],
                    "kind": "photo",
                    "limit": 0,
                    "include_failed": True,
                },
            )
            assert response.status_code == 202
            job_id = response.json()["id"]

            payload = None
            for _ in range(300):
                latest = client.get("/api/v1/admin/thumbnails/preheat/latest")
                assert latest.status_code == 200
                payload = latest.json()
                if payload and payload["status"] in {"completed", "failed"}:
                    break
                time.sleep(0.05)

            assert payload is not None
            assert payload["id"] == job_id
            assert payload["status"] == "completed", payload
            assert payload["total"] == 2
            assert payload["processed"] == 2
            assert payload["generated"] == 6
            assert payload["failed"] == 0
            assert payload["sizes"] == [240, 480, 1280]

        with session_factory() as session:
            # 三档派生缓存 READY 落库（含被 include_failed 找回的冷却文件）
            for remote_id in ("remote-loop-ready", "remote-loop-cooldown"):
                memory_file = session.scalar(
                    select(MemoryFile).where(MemoryFile.remote_id == remote_id)
                )
                assert memory_file is not None
                cache_rows = session.scalars(
                    select(MemoryDerivativeCache).where(
                        MemoryDerivativeCache.memory_file_id == memory_file.id
                    )
                ).all()
                assert sorted(row.max_size for row in cache_rows) == [
                    240,
                    480,
                    1280,
                ]
                assert all(
                    row.status == DerivativeCacheStatus.READY
                    for row in cache_rows
                )
                # 240 预热回填首页缩略图位，文件真实落盘
                memory = session.get(Memory, memory_file.memory_id)
                assert memory is not None
                assert memory.thumbnail_path is not None
                assert memory.thumbnail_path.endswith("240.webp")
                assert (media_root / memory.thumbnail_path).is_file()
                assert memory_file.thumbnail_state == RemoteThumbnailState.READY

        with TestClient(app) as client:
            # 公开状态翻 ready：两条记忆（含被找回的冷却文件）240 全部就绪
            status_response = client.get("/api/v1/memories/preheat-status")
            assert status_response.status_code == 200
            assert status_response.json()["status"] == "ready"

            # 公开缩略图路由三档全部可达（两条记忆 × 三档）
            for memory_id in (ready_id, cooldown_id):
                for size in ("240", "480", "1280"):
                    thumb = client.get(
                        f"/api/v1/memories/{memory_id}/thumbnail",
                        params={"size": size},
                    )
                    assert thumb.status_code == 200, (size, thumb.status_code)
                    assert thumb.headers["content-type"] == "image/webp"

            # 历史落盘：重启后新注册表从磁盘恢复 latest
            history_path = media_root / "preheat-history.json"
            assert history_path.is_file()

        fresh_registry = restore_into_fresh_registry(settings)
        restored = fresh_registry.get_latest()
        assert restored is not None
        assert restored.id == UUID(job_id)
        assert restored.status == "completed"
        assert restored.generated == 6
        assert restored.processed == 2
    finally:
        app.dependency_overrides.clear()
        thumbnail_preheat_registry._jobs.clear()
        thumbnail_preheat_registry._latest_id = None


def get_session_factory_key():
    from app.db.session import get_session_factory

    return get_session_factory


def restore_into_fresh_registry(settings: Settings):
    from app.services.thumbnail_preheat import ThumbnailPreheatRegistry

    fresh_registry = ThumbnailPreheatRegistry()
    restore_preheat_history_from_disk(fresh_registry, settings)
    return fresh_registry
