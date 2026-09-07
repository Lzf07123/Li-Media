from pathlib import Path
import time
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.main import app
from app.db.session import Base, get_db, get_session_factory
from app.models.admin import AdminBackgroundJob, AdminOperationLog
from app.models.memory import (
    BrowserCompatibilityState,
    Memory,
    MemoryFile,
    MemoryKind,
    MemoryStatus,
    RemoteFileState,
    RemoteStreamState,
    RemoteThumbnailState,
)
from app.services.browser_compatibility import evaluate_memory_file
from app.services.admin_batch_status import run_batch_status_job
from tests.test_admin_security import configure_admin_app


def create_database(tmp_path: Path) -> sessionmaker:
    engine = create_engine(f"sqlite:///{tmp_path / 'checklist.db'}")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def add_memory(
    session_factory: sessionmaker,
    *,
    title: str,
    kind: MemoryKind,
    status: MemoryStatus = MemoryStatus.PUBLISHED,
    thumbnail_state: RemoteThumbnailState = RemoteThumbnailState.READY,
    compatibility: BrowserCompatibilityState = BrowserCompatibilityState.SUPPORTED,
) -> tuple[Memory, MemoryFile]:
    memory_id = uuid4()
    with session_factory.begin() as session:
        memory = Memory(
            id=memory_id,
            title=title,
            kind=kind,
            status=status,
        )
        memory_file = MemoryFile(
            memory_id=memory_id,
            source="baidupan",
            remote_id=str(memory_id),
            remote_path=f"/cloud/{memory_id}",
            filename=f"{memory_id}.jpg",
            mime_type="image/jpeg" if kind == MemoryKind.PHOTO else "video/mp4",
            remote_state=RemoteFileState.READY,
            thumbnail_state=thumbnail_state,
            stream_state=RemoteStreamState.READY,
            browser_compatibility=compatibility,
        )
        session.add_all([memory, memory_file])
    return memory, memory_file


def override_database(session_factory: sessionmaker):
    def override():
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    return override


def test_public_media_counts_and_compatibility_predicate(tmp_path: Path) -> None:
    session_factory = create_database(tmp_path)
    add_memory(
        session_factory,
        title="photo one",
        kind=MemoryKind.PHOTO,
    )
    add_memory(
        session_factory,
        title="photo two",
        kind=MemoryKind.PHOTO,
        status=MemoryStatus.HIDDEN,
    )
    supported = add_memory(
        session_factory,
        title="supported video",
        kind=MemoryKind.VIDEO,
    )
    add_memory(
        session_factory,
        title="unsupported video",
        kind=MemoryKind.VIDEO,
        compatibility=BrowserCompatibilityState.UNSUPPORTED,
    )
    add_memory(
        session_factory,
        title="unknown video",
        kind=MemoryKind.VIDEO,
        compatibility=BrowserCompatibilityState.UNKNOWN,
    )

    app.dependency_overrides[get_db] = override_database(session_factory)
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    try:
        with TestClient(app) as client:
            counts = client.get("/api/v1/memories/public-counts")
            assert counts.status_code == 200
            assert counts.json() == {"total": 2, "photo": 1, "video": 1}

            listed = client.get("/api/v1/memories")
            assert listed.status_code == 200
            payload = listed.json()
            assert payload["total"] == 2
            assert payload["counts"] == {"photo": 1, "video": 1}
            assert {item["title"] for item in payload["items"]} == {
                "photo one",
                "supported video",
            }

            recommended = client.get("/api/v1/memories/recommend?limit=10")
            assert {item["title"] for item in recommended.json()} == {
                "photo one",
                "supported video",
            }

            assert client.get(f"/api/v1/memories/{supported[0].id}").status_code == 200
    finally:
        app.dependency_overrides.clear()


def test_admin_counts_filters_batch_preview_and_idempotent_batch(
    tmp_path: Path,
    monkeypatch,
) -> None:
    session_factory = configure_admin_app(tmp_path, monkeypatch)
    add_memory(session_factory, title="photo", kind=MemoryKind.PHOTO)
    add_memory(session_factory, title="video", kind=MemoryKind.VIDEO)
    add_memory(
        session_factory,
        title="unknown",
        kind=MemoryKind.VIDEO,
        compatibility=BrowserCompatibilityState.UNKNOWN,
    )

    app.dependency_overrides[get_db] = override_database(session_factory)
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    try:
        with TestClient(app) as client:
            assert client.post(
                "/api/v1/admin/login",
                json={"token": "test-token"},
            ).status_code == 204

            listed = client.get("/api/v1/admin/memories").json()
            assert listed["counts"] == {"photo": 1, "video": 2}
            assert listed["global_counts"] == {"photo": 1, "video": 2}
            assert listed["status_counts"] == {"published": 3, "unpublished": 0}
            assert listed["display_counts"] == {"displayable": 3, "excluded": 0}
            assert listed["browser_counts"] == {
                "supported": 1,
                "unsupported": 0,
                "unknown": 1,
            }

            videos = client.get("/api/v1/admin/memories?kind=video").json()
            assert videos["total"] == 2
            assert videos["counts"] == {"photo": 0, "video": 2}
            assert videos["global_counts"] == {"photo": 1, "video": 2}

            supported = client.get(
                "/api/v1/admin/memories?compatibility=supported"
            ).json()
            assert supported["total"] == 1
            assert supported["items"][0]["title"] == "video"

            preview = client.post(
                "/api/v1/admin/memories/batch-preview",
                json={"kind": "photo"},
            )
            assert preview.status_code == 200
            assert preview.json()["total"] == 1
            assert preview.json()["is_full_library"] is False

            first = client.post(
                "/api/v1/admin/memories/batch-status",
                json={
                    "kind": "photo",
                    "target_status": "hidden",
                    "confirm": True,
                },
            )
            assert first.status_code == 202
            job = first.json()
            for _ in range(100):
                latest = client.get("/api/v1/admin/memories/batch-status/latest").json()
                if latest and latest["status"] not in {"queued", "running"}:
                    job = latest
                    break
                time.sleep(0.02)
            assert job["total"] == 1
            assert job["status"] == "completed"
            assert job["changed"] == 1

        with session_factory() as session:
            photo = session.scalar(select(Memory).where(Memory.kind == MemoryKind.PHOTO))
            assert photo.status == MemoryStatus.HIDDEN
            videos = session.scalars(
                select(Memory).where(Memory.kind == MemoryKind.VIDEO)
            ).all()
            assert all(video.status == MemoryStatus.PUBLISHED for video in videos)
            logs = session.scalars(
                select(AdminOperationLog).where(
                    AdminOperationLog.action == "batch_hide"
                )
            ).all()
            assert len(logs) == 1
            assert all("resource_ids=" in log.detail for log in logs)
            assert all("session=" in log.detail for log in logs)

            repeat_job = AdminBackgroundJob(
                action="batch_status_hidden",
                resource_ids=[str(photo.id)],
                total=1,
                filter_snapshot={"kind": "photo", "target_status": "hidden"},
            )
            session.add(repeat_job)
            session.commit()

        run_batch_status_job(
            session_factory,
            repeat_job.id,
            target_status=MemoryStatus.HIDDEN,
        )

        with session_factory() as session:
            repeat = session.get(AdminBackgroundJob, repeat_job.id)
            assert repeat.status == "completed"
            assert repeat.changed == 0
            assert repeat.skipped == 1
    finally:
        app.dependency_overrides.clear()


def test_browser_compatibility_matrix_is_conservative() -> None:
    supported = MemoryFile(raw_metadata_summary={
        "container": "mp4",
        "video_codec": "h264",
        "audio_codec": "aac",
    })
    unsupported = MemoryFile(raw_metadata_summary={
        "container": "mov",
        "video_codec": "hevc",
        "audio_codec": "aac",
    })
    unknown = MemoryFile(raw_metadata_summary={"container": "mp4"})

    assert evaluate_memory_file(supported)[0] == BrowserCompatibilityState.SUPPORTED
    assert evaluate_memory_file(unsupported)[0] == BrowserCompatibilityState.UNSUPPORTED
    assert evaluate_memory_file(unknown)[0] == BrowserCompatibilityState.UNKNOWN


def test_admin_status_updates_are_idempotent(tmp_path: Path, monkeypatch) -> None:
    session_factory = configure_admin_app(tmp_path, monkeypatch)
    memory, _ = add_memory(
        session_factory,
        title="idempotent",
        kind=MemoryKind.PHOTO,
    )

    app.dependency_overrides[get_db] = override_database(session_factory)
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    try:
        with TestClient(app) as client:
            assert client.post(
                "/api/v1/admin/login",
                json={"token": "test-token"},
            ).status_code == 204

            assert client.patch(
                f"/api/v1/admin/memories/{memory.id}",
                json={"status": "hidden"},
            ).status_code == 200

            selected_responses = []
            for target_status in ("published", "published"):
                response = client.patch(
                    "/api/v1/admin/memories/batch",
                    json={"ids": [str(memory.id)], "status": target_status},
                )
                assert response.status_code == 200
                selected_responses.append(response.json())

            assert selected_responses[0] == {
                "changed": 1,
                "skipped": 0,
                "updated": 1,
            }
            assert selected_responses[1] == {
                "changed": 0,
                "skipped": 1,
                "updated": 0,
            }

        with session_factory() as session:
            persisted = session.get(Memory, memory.id)
            assert persisted is not None
            assert persisted.status == MemoryStatus.PUBLISHED
            logs = session.scalars(
                select(AdminOperationLog).where(
                    AdminOperationLog.action.in_(["hide", "batch_publish"])
                )
            ).all()
            assert len(logs) == 3
            assert [log.action for log in logs].count("hide") == 1
            assert [log.action for log in logs].count("batch_publish") == 2
            batch_logs = [log for log in logs if log.action == "batch_publish"]
            assert all("resource_ids=" in (log.detail or "") for log in batch_logs)
            assert all("changed=" in (log.detail or "") for log in batch_logs)
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.pop(get_session_factory, None)
