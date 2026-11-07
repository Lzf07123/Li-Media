import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID
import time

from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings

from app.db.session import Base, get_session_factory
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
    RemoteThumbnailState,
    RemoteStreamState,
    RemoteFileState,
)
from app.services.thumbnail_preheat import _candidate_pairs
from app.services.thumbnail_preheat import _process_candidate
from app.services.memory_thumbnails import derivative_cache_path
from app.services.thumbnail_preheat import _process_pair
from app.services.thumbnail_preheat import _set_derivative_cache_state
from app.services.thumbnail_preheat import (
    ThumbnailPreheatRegistry,
    count_preheat_candidates,
    persist_preheat_history,
    restore_preheat_history_from_disk,
    run_thumbnail_preheat,
    start_auto_preheat_after_scan,
)
from app.services.baidu_pan import BaiduPanError
from app.services.task_limits import TaskRejected
from threading import Event
from tests.test_admin_security import configure_admin_app


def create_database(tmp_path: Path) -> sessionmaker[Session]:
    engine = create_engine(f"sqlite:///{tmp_path / 'preheat.db'}")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def add_memory(
    session_factory: sessionmaker[Session],
    *,
    memory_id: UUID,
    title: str,
    kind: MemoryKind,
    captured_at: datetime,
    thumbnail_state: RemoteThumbnailState = RemoteThumbnailState.MISSING,
    failure_kind: str | None = None,
) -> None:
    with session_factory.begin() as session:
        memory = Memory(
            id=memory_id,
            title=title,
            kind=kind,
            status=MemoryStatus.PUBLISHED,
            captured_at=captured_at,
        )
        memory_file = MemoryFile(
            memory_id=memory.id,
            source="baidupan",
            remote_id=f"remote-{memory_id}",
            remote_path=f"/cloud/{memory_id}.jpg",
            parent_path="/cloud",
            filename=f"{memory_id}.jpg",
            mime_type="image/jpeg",
            remote_state=RemoteFileState.READY,
            thumbnail_state=thumbnail_state,
            thumbnail_failure_kind=failure_kind,
            stream_state=RemoteStreamState.READY,
            browser_compatibility=BrowserCompatibilityState.SUPPORTED,
        )
        session.add_all([memory, memory_file])


def disable_retry_cooldown(monkeypatch) -> None:
    """关闭 transient 冷却：口径/排序/取消类用例不测冷却行为本身。"""
    settings = Settings(preheat_retry_cooldown_seconds=0)
    monkeypatch.setattr(
        "app.services.thumbnail_preheat.get_settings",
        lambda: settings,
    )


def test_candidate_pairs_follow_home_order_and_skip_non_retryable(
    tmp_path: Path,
    monkeypatch,
) -> None:
    disable_retry_cooldown(monkeypatch)
    session_factory = create_database(tmp_path)
    add_memory(
        session_factory,
        memory_id=UUID("00000000-0000-0000-0000-000000000003"),
        title="new video",
        kind=MemoryKind.VIDEO,
        captured_at=datetime(2026, 3, 1, tzinfo=timezone.utc),
        thumbnail_state=RemoteThumbnailState.FAILED,
        failure_kind=DerivativeFailureKind.SOURCE_TRUNCATED.value,
    )
    add_memory(
        session_factory,
        memory_id=UUID("00000000-0000-0000-0000-000000000002"),
        title="retryable photo",
        kind=MemoryKind.PHOTO,
        captured_at=datetime(2026, 2, 1, tzinfo=timezone.utc),
        thumbnail_state=RemoteThumbnailState.RETRYABLE,
        failure_kind=DerivativeFailureKind.REMOTE_UNAVAILABLE.value,
    )
    add_memory(
        session_factory,
        memory_id=UUID("00000000-0000-0000-0000-000000000001"),
        title="older photo",
        kind=MemoryKind.PHOTO,
        captured_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )

    with session_factory() as db:
        pairs = _candidate_pairs(db, kind=None, limit=10)
    unlimited_pairs = _candidate_pairs(db, kind=None, limit=0)
    photo_pairs = _candidate_pairs(db, kind=MemoryKind.PHOTO, limit=0)

    assert len(pairs) == 2
    assert len(unlimited_pairs) == 2
    assert len(photo_pairs) == 2
    assert photo_pairs[0][0] == UUID("00000000-0000-0000-0000-000000000002")
    assert pairs[0][0] == UUID("00000000-0000-0000-0000-000000000002")
    assert pairs[1][0] == UUID("00000000-0000-0000-0000-000000000001")


def test_candidate_pairs_select_one_file_per_memory(tmp_path: Path) -> None:
    session_factory = create_database(tmp_path)
    memory_id = UUID("00000000-0000-0000-0000-000000000020")
    add_memory(
        session_factory,
        memory_id=memory_id,
        title="duplicate source",
        kind=MemoryKind.PHOTO,
        captured_at=datetime(2026, 5, 1, tzinfo=timezone.utc),
    )

    with session_factory.begin() as session:
        memory = session.get(Memory, memory_id)
        assert memory is not None
        session.add(
            MemoryFile(
                memory_id=memory.id,
                source="baidupan",
                remote_id="remote-duplicate",
                remote_path="/cloud/duplicate.jpg",
                parent_path="/cloud",
                filename="duplicate.jpg",
                mime_type="image/jpeg",
                remote_state=RemoteFileState.READY,
                stream_state=RemoteStreamState.READY,
                browser_compatibility=BrowserCompatibilityState.SUPPORTED,
            )
        )

    with session_factory() as db:
        pairs = _candidate_pairs(db, kind=None, limit=0)

    assert len(pairs) == 1
    assert pairs[0][0] == memory_id


def test_candidate_pairs_include_detail_size_when_home_is_cached(
    tmp_path: Path,
) -> None:
    session_factory = create_database(tmp_path)
    memory_id = UUID("00000000-0000-0000-0000-000000000040")
    add_memory(
        session_factory,
        memory_id=memory_id,
        title="detail candidate",
        kind=MemoryKind.PHOTO,
        captured_at=datetime(2026, 7, 1, tzinfo=timezone.utc),
    )

    version = "test-version"
    with session_factory.begin() as session:
        memory = session.get(Memory, memory_id)
        memory.thumbnail_path = f"thumbnails/{memory_id}/{version}/240.webp"

    with session_factory() as db:
        assert _candidate_pairs(
            db,
            kind=MemoryKind.PHOTO,
            limit=0,
            sizes=(480,),
            derivative_version=version,
        ) != []
        assert _candidate_pairs(
            db,
            kind=MemoryKind.PHOTO,
            limit=0,
            sizes=(240,),
            derivative_version=version,
        ) == []


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
            kind=MemoryKind.PHOTO,
            status=MemoryStatus.PUBLISHED,
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
            remote_state=RemoteFileState.READY,
            thumbnail_state=RemoteThumbnailState.MISSING,
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
                json={"sizes": ["480"], "kind": "photo", "limit": 0},
            )
            assert response.status_code == 202
            assert response.json()["status"] in {"queued", "running", "completed"}

            payload = None
            for _ in range(150):
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
            assert payload["sizes"] == [480]

        with session_factory() as session:
            memory = session.get(Memory, memory_id)
            memory_file = session.scalar(select(MemoryFile))
            assert memory is not None
            assert memory_file is not None
            # detail 预热只生成派生图，不再回填首页缩略图位。
            assert memory.thumbnail_path is None
            assert memory_file.thumbnail_state == RemoteThumbnailState.READY

        # 首页 240 预热负责回填 thumbnail_path。
        with TestClient(app) as client:
            assert client.post(
                "/api/v1/admin/login",
                json={"token": "test-token"},
            ).status_code == 204

            response = client.post(
                "/api/v1/admin/thumbnails/preheat",
                json={"sizes": ["240"], "kind": "photo", "limit": 0},
            )
            assert response.status_code == 202

            payload = None
            for _ in range(150):
                latest = client.get("/api/v1/admin/thumbnails/preheat/latest")
                assert latest.status_code == 200
                payload = latest.json()
                if payload and payload["processed"] == 1:
                    break
                time.sleep(0.02)

            assert payload["generated"] == 1

        with session_factory() as session:
            memory = session.get(Memory, memory_id)
            assert memory is not None
            assert memory.thumbnail_path is not None
            assert memory.thumbnail_path.endswith("240.webp")
            assert (media_root / memory.thumbnail_path).is_file()
    finally:
        app.dependency_overrides.clear()


def test_remote_preheat_failure_is_classified(tmp_path: Path) -> None:
    session_factory = create_database(tmp_path)
    memory_id = UUID("00000000-0000-0000-0000-000000000010")
    add_memory(
        session_factory,
        memory_id=memory_id,
        title="webp sample",
        kind=MemoryKind.PHOTO,
        captured_at=datetime(2026, 4, 1, tzinfo=timezone.utc),
    )

    class FailingClient:
        def open_stream(self, remote_id: str, *, range_header: str | None):
            raise BaiduPanError("百度网盘接口限流，请稍后重试")

    failure_sink: dict[str, str] = {}
    with session_factory() as db:
        memory_file_id = db.scalar(select(MemoryFile.id))
        outcome = _process_pair(
            db,
            memory_id=memory_id,
            memory_file_id=memory_file_id,
            settings=Settings(media_root=str(tmp_path / "media")),
            max_size=240,
            failure_sink=failure_sink,
            client=FailingClient(),
        )

    assert outcome == "failed"
    assert failure_sink["kind"] == DerivativeFailureKind.BAIDU_RATE_LIMITED.value
    with session_factory() as db:
        memory_file = db.scalar(select(MemoryFile))
        assert memory_file is not None
        assert memory_file.thumbnail_state == RemoteThumbnailState.RETRYABLE
        assert memory_file.thumbnail_failure_kind == (
            DerivativeFailureKind.BAIDU_RATE_LIMITED.value
        )


def test_download_remote_source_enforces_total_deadline(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """下载超过整体总时限即分类 timeout 并清理临时文件，不无限占住 worker。"""
    from app.services.thumbnail_preheat import _download_remote_source

    settings = Settings(
        media_root=str(tmp_path),
        source_download_timeout_seconds=30,
    )
    clock = {"now": 0.0}
    monkeypatch.setattr(
        "app.services.thumbnail_preheat.time.monotonic",
        lambda: clock["now"],
    )

    class SlowStream:
        def iter_bytes(self):
            while True:
                clock["now"] += 10
                yield b"chunk"

        def close(self) -> None:
            return None

    class SlowClient:
        def open_stream(self, remote_id: str, *, range_header: str | None):
            clock["now"] += 1
            return 200, None, None, None, SlowStream()

    memory = Memory(
        id=UUID("00000000-0000-0000-0000-0000000000f1"),
        kind=MemoryKind.PHOTO,
    )
    memory_file = MemoryFile(mime_type="image/jpeg")
    failure_sink: dict[str, str] = {}

    path, written = _download_remote_source(
        client=SlowClient(),
        remote_id="remote-1",
        media_root=tmp_path,
        memory=memory,
        memory_file=memory_file,
        settings=settings,
        failure_sink=failure_sink,
        cancel_event=None,
    )

    assert path is None
    assert failure_sink["kind"] == DerivativeFailureKind.TIMEOUT.value
    assert written > 0
    assert list((tmp_path / "tmp").glob("*.tmp")) == []


def test_transient_failure_cooldown_skips_recent_failures(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """RETRYABLE 且冷却期内失败的文件不再入选；include_failed 是逃生通道。"""
    session_factory = create_database(tmp_path)
    recent_id = UUID("00000000-0000-0000-0000-0000000000c1")
    old_id = UUID("00000000-0000-0000-0000-0000000000c2")
    add_memory(
        session_factory,
        memory_id=recent_id,
        title="recent transient failure",
        kind=MemoryKind.PHOTO,
        captured_at=datetime(2026, 5, 1, tzinfo=timezone.utc),
        thumbnail_state=RemoteThumbnailState.RETRYABLE,
        failure_kind=DerivativeFailureKind.REMOTE_UNAVAILABLE.value,
    )
    add_memory(
        session_factory,
        memory_id=old_id,
        title="old transient failure",
        kind=MemoryKind.PHOTO,
        captured_at=datetime(2026, 5, 2, tzinfo=timezone.utc),
        thumbnail_state=RemoteThumbnailState.RETRYABLE,
        failure_kind=DerivativeFailureKind.REMOTE_UNAVAILABLE.value,
    )
    with session_factory.begin() as session:
        recent_file = session.scalar(
            select(MemoryFile).where(MemoryFile.remote_id == f"remote-{recent_id}")
        )
        old_file = session.scalar(
            select(MemoryFile).where(MemoryFile.remote_id == f"remote-{old_id}")
        )
        assert recent_file is not None and old_file is not None
        recent_file.updated_at = datetime.now(timezone.utc)
        old_file.updated_at = datetime.now(timezone.utc) - timedelta(hours=2)

    settings = Settings(
        media_root=str(tmp_path),
        preheat_retry_cooldown_seconds=3600,
    )
    monkeypatch.setattr(
        "app.services.thumbnail_preheat.get_settings",
        lambda: settings,
    )

    with session_factory() as db:
        pairs = _candidate_pairs(db, kind=None, limit=0, sizes=(240,))
    selected = {str(memory_id) for memory_id, _ in pairs}
    assert str(recent_id) not in selected
    assert str(old_id) in selected

    # preview 与枚举同口径；include_failed 强制找回冷却期失败项
    with session_factory() as db:
        assert count_preheat_candidates(db, kind=None, sizes=(240,)) == 1
        assert (
            count_preheat_candidates(
                db,
                kind=None,
                sizes=(240,),
                include_failed=True,
            )
            == 2
        )


def test_registry_job_records_include_failed_flag() -> None:
    registry = ThumbnailPreheatRegistry()
    job, started = registry.start(kind=None, limit=0, include_failed=True)
    assert started
    assert job.include_failed is True


def test_auth_failure_resets_thread_client_and_retries_once(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """整候选 remote_auth 失败时重置线程本地客户端并重试一次。"""
    session_factory = create_database(tmp_path)
    memory_id = UUID("00000000-0000-0000-0000-0000000000d1")
    add_memory(
        session_factory,
        memory_id=memory_id,
        title="auth rotation victim",
        kind=MemoryKind.PHOTO,
        captured_at=datetime(2026, 5, 3, tzinfo=timezone.utc),
    )
    settings = Settings(media_root=str(tmp_path / "media"))

    class AuthFailedClient:
        def open_stream(self, remote_id: str, *, range_header: str | None):
            raise BaiduPanError("百度网盘访问凭证无效、过期或授权范围不足")

    class RateLimitedClient:
        def open_stream(self, remote_id: str, *, range_header: str | None):
            raise BaiduPanError("百度网盘接口限流，请稍后重试")

    clients = [AuthFailedClient(), RateLimitedClient()]

    def fake_thread_client(current_settings: Settings):
        assert clients, "重试应只发生一次"
        return clients.pop(0)

    monkeypatch.setattr(
        "app.services.thumbnail_preheat._thread_local_client",
        fake_thread_client,
    )

    with session_factory() as db:
        memory_file_id = db.scalar(select(MemoryFile.id))

    result = _process_candidate(
        session_factory,
        memory_id=memory_id,
        memory_file_id=memory_file_id,
        settings=settings,
        sizes=(240,),
    )

    assert not clients
    assert result.failure_kind == DerivativeFailureKind.BAIDU_RATE_LIMITED.value
    with session_factory() as db:
        memory_file = db.scalar(select(MemoryFile))
        assert memory_file is not None
        assert memory_file.thumbnail_failure_kind == (
            DerivativeFailureKind.BAIDU_RATE_LIMITED.value
        )


def test_download_resumes_from_range_after_stream_interruption(
    tmp_path: Path,
) -> None:
    """读流中断且已有进度时按 Range 续传，不作废整个下载。"""
    from app.services.thumbnail_preheat import _download_remote_source

    settings = Settings(media_root=str(tmp_path))
    opened_ranges: list[str | None] = []

    class FlakyStream:
        def __init__(self, chunks: list[bytes], *, fail: bool) -> None:
            self._chunks = chunks
            self._fail = fail

        def iter_bytes(self):
            yield from self._chunks
            if self._fail:
                raise OSError("connection reset by peer")

        def close(self) -> None:
            return None

    class FlakyClient:
        def invalidate_download_url(self, remote_id: str) -> None:
            return None

        def open_stream(self, remote_id: str, *, range_header: str | None):
            opened_ranges.append(range_header)
            if len(opened_ranges) == 1:
                return 200, None, None, None, FlakyStream([b"hello ", b"worl"], fail=True)
            return 206, None, None, None, FlakyStream([b"d!"], fail=False)

    memory = Memory(
        id=UUID("00000000-0000-0000-0000-0000000000e1"),
        kind=MemoryKind.PHOTO,
    )
    memory_file = MemoryFile(mime_type="image/jpeg")
    failure_sink: dict[str, str] = {}

    path, written = _download_remote_source(
        client=FlakyClient(),
        remote_id="remote-1",
        media_root=tmp_path,
        memory=memory,
        memory_file=memory_file,
        settings=settings,
        failure_sink=failure_sink,
        cancel_event=None,
    )

    assert path is not None
    assert path.read_bytes() == b"hello world!"
    assert written == 12
    assert opened_ranges == [None, "bytes=10-"]


def test_preheat_history_persists_and_restores_across_restart(tmp_path: Path) -> None:
    """任务终态摘要落盘，新进程装回注册表后 latest 与统计完整可诊断。"""
    settings = Settings(media_root=str(tmp_path / "media"))
    registry = ThumbnailPreheatRegistry()
    job, started = registry.start(sizes=(240,), kind=None, limit=0)
    assert started
    registry.mark_running(job.id, total=2)
    registry.mark_item_processed(job.id, outcomes={240: "generated"})
    registry.mark_item_processed(job.id, outcomes={240: "cached"})
    registry.mark_completed(job.id)
    persist_preheat_history(job, settings)

    assert (tmp_path / "media" / "preheat-history.json").is_file()

    fresh_registry = ThumbnailPreheatRegistry()
    restore_preheat_history_from_disk(fresh_registry, settings)
    restored = fresh_registry.get_latest()

    assert restored is not None
    assert restored.id == job.id
    assert restored.status == "completed"
    assert restored.total == 2
    assert restored.processed == 2
    assert restored.generated == 1
    assert restored.cached == 1


def test_running_snapshot_is_coerced_to_failed_on_restore(tmp_path: Path) -> None:
    """重启前仍非终态的快照按失败收尾，不再悬空为 running。"""
    settings = Settings(media_root=str(tmp_path / "media"))
    registry = ThumbnailPreheatRegistry()
    job, _ = registry.start(sizes=(240,), kind=None, limit=0)
    registry.mark_running(job.id, total=5)
    persist_preheat_history(job, settings)

    fresh_registry = ThumbnailPreheatRegistry()
    restore_preheat_history_from_disk(fresh_registry, settings)
    restored = fresh_registry.get_latest()

    assert restored is not None
    assert restored.status == "failed"
    assert restored.message == "服务重启，任务中断"


def test_unexpected_preheat_failure_is_retryable(tmp_path: Path, monkeypatch) -> None:
    session_factory = create_database(tmp_path)
    memory_id = UUID("00000000-0000-0000-0000-000000000011")
    add_memory(
        session_factory,
        memory_id=memory_id,
        title="unexpected failure",
        kind=MemoryKind.PHOTO,
        captured_at=datetime(2026, 4, 2, tzinfo=timezone.utc),
    )
    settings = Settings(media_root=str(tmp_path / "media"))

    def raise_unexpected(*args, **kwargs):
        raise RuntimeError("unexpected")

    monkeypatch.setattr(
        "app.services.thumbnail_preheat._process_pair_sizes",
        raise_unexpected,
    )

    with session_factory() as db:
        memory_file_id = db.scalar(select(MemoryFile.id))

    result = _process_candidate(
        session_factory,
        memory_id=memory_id,
        memory_file_id=memory_file_id,
        settings=settings,
        sizes=(240,),
        cancel_event=Event(),
    )

    assert result.failure_kind == DerivativeFailureKind.UNKNOWN.value
    with session_factory() as db:
        memory_file = db.scalar(select(MemoryFile))
        assert memory_file is not None
        assert memory_file.thumbnail_state == RemoteThumbnailState.RETRYABLE
        assert memory_file.thumbnail_failure_kind == "unknown"


def test_preheat_reconciles_existing_file_without_remote_read(tmp_path: Path) -> None:
    session_factory = create_database(tmp_path)
    memory_id = UUID("00000000-0000-0000-0000-000000000030")
    add_memory(
        session_factory,
        memory_id=memory_id,
        title="existing cache",
        kind=MemoryKind.PHOTO,
        captured_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
    )
    settings = Settings(
        media_root=str(tmp_path / "media"),
        media_derivative_version="test-version",
    )
    target_path = derivative_cache_path(
        Path(settings.media_root),
        memory_id,
        max_size=240,
        version=settings.media_derivative_version,
    )
    target_path.parent.mkdir(parents=True)
    Image.new("RGB", (20, 10), "blue").save(target_path, format="WEBP")

    class ForbidRemoteClient:
        def open_stream(self, remote_id: str, *, range_header: str | None):
            raise AssertionError("existing derivative must not read remote source")

    with session_factory() as db:
        memory_file_id = db.scalar(select(MemoryFile.id))
        outcome = _process_pair(
            db,
            memory_id=memory_id,
            memory_file_id=memory_file_id,
            settings=settings,
            max_size=240,
            client=ForbidRemoteClient(),
        )

    assert outcome == "cached"
    with session_factory() as db:
        memory = db.get(Memory, memory_id)
        cache = db.scalar(select(MemoryDerivativeCache))
        assert memory is not None
        assert cache is not None
        assert memory.thumbnail_path == target_path.relative_to(Path(settings.media_root)).as_posix()
        assert cache.status == DerivativeCacheStatus.READY
        assert cache.max_size == 240


def test_derivative_cache_state_accepts_relative_media_root(
    tmp_path: Path,
    monkeypatch,
) -> None:
    session_factory = create_database(tmp_path)
    memory_id = UUID("00000000-0000-0000-0000-000000000050")
    add_memory(
        session_factory,
        memory_id=memory_id,
        title="relative media root",
        kind=MemoryKind.PHOTO,
        captured_at=datetime(2026, 8, 1, tzinfo=timezone.utc),
    )
    settings = Settings(
        media_root="./media",
        media_derivative_version="relative-version",
    )
    monkeypatch.chdir(tmp_path)
    output_path = Path("media/thumbnails") / str(memory_id) / "relative-version/240.webp"
    output_path.parent.mkdir(parents=True)
    output_path.write_bytes(b"webp")

    with session_factory() as db:
        memory_file_id = db.scalar(select(MemoryFile.id))
        _set_derivative_cache_state(
            db,
            memory_file_id=memory_file_id,
            settings=settings,
            max_size=240,
            status=DerivativeCacheStatus.READY,
            output_path=output_path,
            source_bytes=4,
            duration_ms=3,
        )
        db.commit()

    with session_factory() as db:
        cache = db.scalar(select(MemoryDerivativeCache))
        assert cache is not None
        assert cache.status == DerivativeCacheStatus.READY
        assert cache.output_path == output_path.relative_to(
            Path(settings.media_root)
        ).as_posix()
        assert cache.output_bytes == 4


def test_preheat_slot_rejection_is_skipped_without_failure_writes(
    tmp_path: Path,
    monkeypatch,
) -> None:
    session_factory = create_database(tmp_path)
    memory_id = UUID("00000000-0000-0000-0000-000000000041")
    add_memory(
        session_factory,
        memory_id=memory_id,
        title="rejected candidate",
        kind=MemoryKind.PHOTO,
        captured_at=datetime(2026, 7, 1, tzinfo=timezone.utc),
    )
    settings = Settings(media_root=str(tmp_path / "media"))

    class _RejectingLimiter:
        def slot(self, task_type, *, priority, cancel_event=None):
            raise TaskRejected("preheat queue full")

    monkeypatch.setattr(
        "app.services.thumbnail_preheat.task_limiter",
        _RejectingLimiter(),
    )

    with session_factory() as db:
        memory_file_id = db.scalar(select(MemoryFile.id))

    result = _process_candidate(
        session_factory,
        memory_id=memory_id,
        memory_file_id=memory_file_id,
        settings=settings,
        sizes=(240, 480),
        cancel_event=Event(),
    )

    assert result.outcomes == {240: "skipped", 480: "skipped"}
    assert result.failure_kind is None

    with session_factory() as db:
        memory_file = db.scalar(select(MemoryFile))
        assert memory_file is not None
        # 跳过不写失败状态与 FAILED 缓存行，留给下次预热重选。
        assert memory_file.thumbnail_state == RemoteThumbnailState.MISSING
        assert memory_file.thumbnail_failure_kind is None
        assert db.scalar(select(MemoryDerivativeCache)) is None


def test_preheat_preview_matches_candidate_pairs(
    tmp_path: Path,
    monkeypatch,
) -> None:
    session_factory = configure_admin_app(tmp_path, monkeypatch)
    add_memory(
        session_factory,
        memory_id=UUID("00000000-0000-0000-0000-000000000051"),
        title="preview photo",
        kind=MemoryKind.PHOTO,
        captured_at=datetime(2026, 8, 1, tzinfo=timezone.utc),
    )
    add_memory(
        session_factory,
        memory_id=UUID("00000000-0000-0000-0000-000000000052"),
        title="preview photo two",
        kind=MemoryKind.PHOTO,
        captured_at=datetime(2026, 8, 2, tzinfo=timezone.utc),
    )
    add_memory(
        session_factory,
        memory_id=UUID("00000000-0000-0000-0000-000000000053"),
        title="preview video",
        kind=MemoryKind.VIDEO,
        captured_at=datetime(2026, 8, 3, tzinfo=timezone.utc),
    )

    with session_factory() as db:
        expected_all = len(
            _candidate_pairs(db, kind=None, limit=0, sizes=(240,))
        )
        expected_photo = len(
            _candidate_pairs(db, kind=MemoryKind.PHOTO, limit=0, sizes=(240, 480))
        )
    assert expected_all == 3

    try:
        app.dependency_overrides[get_session_factory] = lambda: session_factory
        with TestClient(app) as client:
            assert client.post(
                "/api/v1/admin/login",
                json={"token": "test-token"},
            ).status_code == 204

            response = client.get(
                "/api/v1/admin/thumbnails/preheat/preview",
                params={"sizes": ["240"]},
            )
            assert response.status_code == 200
            assert response.json() == {"total": expected_all}

            response = client.get(
                "/api/v1/admin/thumbnails/preheat/preview",
                params={"sizes": ["240", "480"], "kind": "photo"},
            )
            assert response.status_code == 200
            assert response.json() == {"total": expected_photo}
    finally:
        app.dependency_overrides.clear()


def test_candidate_scope_follows_public_surface(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """候选口径与公开展示面共用同一条件，不再各自漂移。"""
    disable_retry_cooldown(monkeypatch)

    session_factory = create_database(tmp_path)
    retryable_photo_id = UUID("00000000-0000-0000-0000-000000000071")
    with session_factory.begin() as session:
        memory = Memory(
            id=retryable_photo_id,
            title="retryable photo",
            kind=MemoryKind.PHOTO,
            status=MemoryStatus.PUBLISHED,
            captured_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
        )
        session.add(memory)
        session.add(
            MemoryFile(
                memory_id=memory.id,
                source="baidupan",
                remote_id="remote-retryable",
                remote_path="/cloud/retryable.jpg",
                parent_path="/cloud",
                filename="retryable.jpg",
                mime_type="image/jpeg",
                remote_state=RemoteFileState.READY,
                thumbnail_state=RemoteThumbnailState.RETRYABLE,
                thumbnail_failure_kind=DerivativeFailureKind.REMOTE_UNAVAILABLE.value,
                stream_state=RemoteStreamState.READY,
                browser_compatibility=BrowserCompatibilityState.SUPPORTED,
            )
        )

    unsupported_video_id = UUID("00000000-0000-0000-0000-000000000072")
    with session_factory.begin() as session:
        memory = Memory(
            id=unsupported_video_id,
            title="unsupported video",
            kind=MemoryKind.VIDEO,
            status=MemoryStatus.PUBLISHED,
            captured_at=datetime(2026, 10, 2, tzinfo=timezone.utc),
        )
        session.add(memory)
        session.add(
            MemoryFile(
                memory_id=memory.id,
                source="baidupan",
                remote_id="remote-unsupported",
                remote_path="/cloud/video.mov",
                parent_path="/cloud",
                filename="video.mov",
                mime_type="video/quicktime",
                remote_state=RemoteFileState.READY,
                thumbnail_state=RemoteThumbnailState.MISSING,
                stream_state=RemoteStreamState.READY,
                browser_compatibility=BrowserCompatibilityState.UNSUPPORTED,
            )
        )

    with session_factory() as db:
        pairs = _candidate_pairs(db, kind=None, limit=0, sizes=(240,))
        preview_total = count_preheat_candidates(db, kind=None, sizes=(240,))

    # 浏览器不兼容的视频不在公开面上，预热不应为其消耗远端下载。
    assert [pair[0] for pair in pairs] == [retryable_photo_id]
    assert preview_total == 1


def test_auto_preheat_after_scan_starts_home_job(
    tmp_path: Path,
    monkeypatch,
) -> None:
    session_factory = create_database(tmp_path)
    settings = Settings(media_root=str(tmp_path / "media"))
    registry = ThumbnailPreheatRegistry()
    executed: list[UUID] = []

    def fake_run(job_id: UUID, **kwargs) -> None:
        executed.append(job_id)

    monkeypatch.setattr(
        "app.services.thumbnail_preheat.run_thumbnail_preheat",
        fake_run,
    )

    disabled = settings.model_copy(update={"preheat_auto_after_scan": False})
    assert (
        start_auto_preheat_after_scan(
            session_factory=session_factory,
            settings=disabled,
            registry=registry,
        )
        is None
    )
    assert registry.get_latest() is None

    job = start_auto_preheat_after_scan(
        session_factory=session_factory,
        settings=settings,
        registry=registry,
    )
    assert job is not None
    assert job.sizes == (240,)

    # 单飞注册表：已有任务在跑时静默跳过，不再叠加新任务。
    assert (
        start_auto_preheat_after_scan(
            session_factory=session_factory,
            settings=settings,
            registry=registry,
        )
        is None
    )
    assert registry.get(job.id) is registry.get_latest()

    for _ in range(200):
        if executed:
            break
        time.sleep(0.01)
    assert executed == [job.id]


def test_preheat_cancelled_during_enumeration(tmp_path: Path, monkeypatch) -> None:
    disable_retry_cooldown(monkeypatch)
    session_factory = create_database(tmp_path)
    memory_id = UUID("00000000-0000-0000-0000-000000000081")
    add_memory(
        session_factory,
        memory_id=memory_id,
        title="cancel during enum",
        kind=MemoryKind.PHOTO,
        captured_at=datetime(2026, 11, 1, tzinfo=timezone.utc),
    )
    settings = Settings(media_root=str(tmp_path / "media"))
    registry = ThumbnailPreheatRegistry()

    with session_factory() as db:
        memory_file_id = db.scalar(select(MemoryFile.id))

    def enumerate_then_cancel(
        db,
        *,
        kind,
        limit,
        sizes=None,
        derivative_version=None,
        include_failed=False,
    ):
        # 模拟枚举耗时窗口内用户取消。
        job.cancel_event.set()
        return [(memory_id, memory_file_id)]

    monkeypatch.setattr(
        "app.services.thumbnail_preheat._candidate_pairs",
        enumerate_then_cancel,
    )

    job, _ = registry.start(
        sizes=(240,),
        kind=None,
        limit=0,
        concurrency=1,
        queue_limit=0,
    )
    run_thumbnail_preheat(
        job.id,
        session_factory=session_factory,
        settings=settings,
        registry=registry,
    )

    latest = registry.get(job.id)
    assert latest is not None
    assert latest.status == "cancelled"
    assert latest.processed == 0
