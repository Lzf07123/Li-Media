from collections.abc import Generator
from pathlib import Path
import uuid

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
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
    RemoteThumbnailState,
    RemoteStreamState,
)
from app.services.thumbnail_preheat import (
    ThumbnailPreheatRegistry,
    collect_public_preheat_status,
)


def create_database(tmp_path: Path) -> sessionmaker[Session]:
    engine = create_engine(f"sqlite:///{tmp_path / 'preheat-status.db'}")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def add_public_photo(session_factory: sessionmaker[Session]) -> uuid.UUID:
    with session_factory.begin() as session:
        memory = Memory(
            title="公开照片",
            kind=MemoryKind.PHOTO,
            status=MemoryStatus.PUBLISHED,
        )
        session.add(memory)
        session.flush()
        memory_id = memory.id
        session.add(
            MemoryFile(
                memory_id=memory.id,
                source="baidupan",
                remote_id="remote-public",
                remote_path="/cloud/public.jpg",
                parent_path="/cloud",
                filename="public.jpg",
                mime_type="image/jpeg",
                status=MemoryFileStatus.MATCHED,
                remote_state=RemoteFileState.READY,
                thumbnail_state=RemoteThumbnailState.READY,
                stream_state=RemoteStreamState.READY,
                browser_compatibility=BrowserCompatibilityState.SUPPORTED,
            )
        )
    return memory_id


def test_public_preheat_status_covers_registry_states(tmp_path: Path) -> None:
    session_factory = create_database(tmp_path)

    registry = ThumbnailPreheatRegistry()
    assert collect_public_preheat_status(
        session_factory(),
        latest_job=None,
    ) == {"status": "ready", "processed": 0, "total": 0}

    memory_id = add_public_photo(session_factory)
    assert collect_public_preheat_status(
        session_factory(),
        latest_job=None,
    ) == {"status": "not_preheated", "processed": 0, "total": 1}

    queued_job, _ = registry.start(
        sizes=(240,),
        kind=None,
        limit=0,
        concurrency=1,
        queue_limit=0,
    )
    assert collect_public_preheat_status(
        session_factory(),
        latest_job=queued_job,
    ) == {"status": "running", "processed": 0, "total": 1}

    running_job, _ = registry.start(
        sizes=(480,),
        kind=None,
        limit=0,
        concurrency=1,
        queue_limit=0,
    )
    registry.mark_running(running_job.id, total=1)
    assert collect_public_preheat_status(
        session_factory(),
        latest_job=running_job,
    ) == {"status": "running", "processed": 0, "total": 1}

    registry.mark_item_processed(running_job.id, outcomes={240: "cached"})
    with session_factory.begin() as session:
        memory = session.get(Memory, memory_id)
        memory.thumbnail_path = (
            f"thumbnails/cached/{get_settings().media_derivative_version}/240.webp"
        )
    registry.mark_completed(running_job.id)
    assert collect_public_preheat_status(
        session_factory(),
        latest_job=running_job,
    ) == {"status": "ready", "processed": 1, "total": 1}

    cancelled_job, _ = registry.start(
        sizes=(240,),
        kind=None,
        limit=0,
        concurrency=1,
        queue_limit=0,
    )
    registry.mark_running(cancelled_job.id, total=1)
    registry.mark_cancelled(cancelled_job.id)
    assert collect_public_preheat_status(
        session_factory(),
        latest_job=cancelled_job,
    )["status"] == "ready"

    failed_job, _ = registry.start(
        sizes=(240,),
        kind=None,
        limit=0,
        concurrency=1,
        queue_limit=0,
    )
    registry.mark_running(failed_job.id, total=1)
    registry.mark_failed(failed_job.id, "internal failure")
    assert collect_public_preheat_status(
        session_factory(),
        latest_job=failed_job,
    )["status"] == "ready"
    assert collect_public_preheat_status(
        session_factory(),
        latest_job=None,
    ) == {"status": "ready", "processed": 1, "total": 1}


def test_public_preheat_endpoint_returns_only_safe_summary(
    tmp_path: Path,
    monkeypatch,
) -> None:
    session_factory = create_database(tmp_path)
    add_public_photo(session_factory)

    def override_get_db() -> Generator[Session, None, None]:
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    monkeypatch.setattr(
        "app.api.v1.memories.thumbnail_preheat_registry",
        ThumbnailPreheatRegistry(),
    )
    try:
        with TestClient(app) as client:
            response = client.get("/api/v1/memories/preheat-status")
            assert response.status_code == 200
            assert response.headers["cache-control"] == "no-store"
            assert response.json() == {
                "status": "not_preheated",
                "processed": 0,
                "total": 1,
            }
            assert set(response.json()) == {"status", "processed", "total"}
            for forbidden in (
                "admin_token",
                "client_secret",
                "/cloud/public.jpg",
                "remote-public",
                "internal failure",
            ):
                assert forbidden not in response.text
    finally:
        app.dependency_overrides.clear()
