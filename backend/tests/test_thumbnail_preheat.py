import uuid
from datetime import datetime, timezone
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
    DerivativeFailureKind,
    Memory,
    MemoryFile,
    MemoryKind,
    MemoryStatus,
    RemoteThumbnailState,
    RemoteStreamState,
    RemoteFileState,
)
from app.services.thumbnail_preheat import _candidate_pairs
from app.services.thumbnail_preheat import _process_pair
from app.services.baidu_pan import BaiduPanError
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


def test_candidate_pairs_follow_home_order_and_skip_non_retryable(
    tmp_path: Path,
) -> None:
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
        thumbnail_state=RemoteThumbnailState.FAILED,
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
            assert payload["sizes"] == [480]

        with session_factory() as session:
            memory = session.get(Memory, memory_id)
            memory_file = session.scalar(select(MemoryFile))
            assert memory is not None
            assert memory_file is not None
            assert memory.thumbnail_path is not None
            assert memory.thumbnail_path.endswith("480.webp")
            assert (media_root / memory.thumbnail_path).is_file()
            assert memory_file.thumbnail_state == RemoteThumbnailState.READY
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
