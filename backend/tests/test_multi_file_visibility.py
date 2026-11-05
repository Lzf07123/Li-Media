"""多文件记忆（md5 去重）下列表/详情/主文件的口径一致性回归用例。"""

from collections.abc import Generator
from pathlib import Path
import uuid

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.session import Base, get_db
from app.main import app
from app.models.memory import (
    BrowserCompatibilityState,
    Memory,
    MemoryFile,
    MemoryFileStatus,
    MemoryKind,
    MemoryStatus,
    RemoteFileState,
    RemoteStreamState,
    RemoteThumbnailState,
)

FILE_A = uuid.UUID("00000000-0000-4000-8000-00000000000a")
FILE_B = uuid.UUID("00000000-0000-4000-8000-00000000000b")


def make_file(
    memory_id: uuid.UUID,
    file_id: uuid.UUID,
    remote_path: str,
    *,
    thumbnail_state: RemoteThumbnailState = RemoteThumbnailState.READY,
    stream_state: RemoteStreamState = RemoteStreamState.READY,
    browser_compatibility: BrowserCompatibilityState = BrowserCompatibilityState.SUPPORTED,
) -> MemoryFile:
    return MemoryFile(
        id=file_id,
        memory_id=memory_id,
        source="baidupan",
        remote_path=remote_path,
        source_path=remote_path,
        filename=remote_path.split("/")[-1],
        mime_type="image/jpeg",
        size_bytes=128,
        status=MemoryFileStatus.MATCHED,
        remote_state=RemoteFileState.READY,
        thumbnail_state=thumbnail_state,
        stream_state=stream_state,
        browser_compatibility=browser_compatibility,
    )


def _setup(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'memories.db'}")
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)

    def override_get_db() -> Generator[Session, None, None]:
        session = factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    return factory


def _teardown() -> None:
    app.dependency_overrides.pop(get_db, None)


def test_photo_memory_serves_first_healthy_duplicate(tmp_path: Path) -> None:
    factory = _setup(tmp_path)
    try:
        with factory.begin() as session:
            memory = Memory(
                title="md5 duplicate pair",
                kind=MemoryKind.PHOTO,
                status=MemoryStatus.PUBLISHED,
            )
            session.add(memory)
            session.flush()
            # A（旧副本，派生永久失败且无缓存）按 id 排在 B 前
            session.add(
                make_file(
                    memory.id,
                    FILE_A,
                    "cloud/a.jpg",
                    thumbnail_state=RemoteThumbnailState.FAILED,
                )
            )
            session.add(make_file(memory.id, FILE_B, "cloud/b.jpg"))

        client = TestClient(app)
        listed = client.get("/api/v1/memories").json()["items"]
        assert [item["id"] for item in listed] == [str(memory.id)]
        assert listed[0]["primary_file"]["filename"] == "b.jpg"

        detail = client.get(f"/api/v1/memories/{memory.id}")
        assert detail.status_code == 200
        assert detail.json()["primary_file"]["filename"] == "b.jpg"

        counts = client.get("/api/v1/memories/public-counts").json()
        assert counts["photo"] == 1
    finally:
        _teardown()


def test_video_memory_serves_first_playable_duplicate(tmp_path: Path) -> None:
    factory = _setup(tmp_path)
    try:
        with factory.begin() as session:
            memory = Memory(
                title="video duplicate pair",
                kind=MemoryKind.VIDEO,
                status=MemoryStatus.PUBLISHED,
                duration_seconds=8,
            )
            session.add(memory)
            session.flush()
            # A 流就绪但浏览器不兼容；B 完全可播
            session.add(
                make_file(
                    memory.id,
                    FILE_A,
                    "cloud/a.mov",
                    browser_compatibility=BrowserCompatibilityState.UNSUPPORTED,
                )
            )
            session.add(make_file(memory.id, FILE_B, "cloud/b.mp4"))

        client = TestClient(app)
        listed = client.get("/api/v1/memories", params={"kind": "video"}).json()
        assert [item["id"] for item in listed["items"]] == [str(memory.id)]
        assert listed["items"][0]["primary_file"]["browser_compatibility"] == "supported"

        detail = client.get(f"/api/v1/memories/{memory.id}")
        assert detail.status_code == 200
        assert detail.json()["primary_file"]["filename"] == "b.mp4"
    finally:
        _teardown()


def test_memory_without_healthy_file_stays_hidden_everywhere(tmp_path: Path) -> None:
    factory = _setup(tmp_path)
    try:
        with factory.begin() as session:
            memory = Memory(
                title="all failed",
                kind=MemoryKind.PHOTO,
                status=MemoryStatus.PUBLISHED,
            )
            session.add(memory)
            session.flush()
            session.add(
                make_file(
                    memory.id,
                    FILE_A,
                    "cloud/a.jpg",
                    thumbnail_state=RemoteThumbnailState.FAILED,
                )
            )

        client = TestClient(app)
        assert client.get("/api/v1/memories").json()["items"] == []
        assert client.get(f"/api/v1/memories/{memory.id}").status_code == 404
        assert client.get("/api/v1/memories/public-counts").json()["photo"] == 0
    finally:
        _teardown()
