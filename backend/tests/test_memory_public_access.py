from collections.abc import Generator
from pathlib import Path
from datetime import UTC, datetime

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.session import Base, get_db
from app.main import app
from app.models.memory import Memory, MemoryFile, MemoryFileStatus, MemoryKind, MemoryStatus


def test_published_memory_is_visible_and_hidden_memory_is_not(tmp_path: Path) -> None:
    engine = create_engine(f"sqlite:///{tmp_path / 'memories.db'}")
    testing_session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)

    def override_get_db() -> Generator[Session, None, None]:
        session = testing_session()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    try:
        with testing_session.begin() as session:
            published = Memory(
                title="published memory",
                kind=MemoryKind.PHOTO,
                status=MemoryStatus.PUBLISHED,
            )
            hidden = Memory(
                title="hidden memory",
                kind=MemoryKind.PHOTO,
                status=MemoryStatus.HIDDEN,
            )
            session.add_all([published, hidden])
            session.flush()
            session.add(
                MemoryFile(
                    memory_id=published.id,
                    source="baidupan",
                    remote_path="published.jpg",
                    source_path="photos/published.jpg",
                    mime_type="image/jpeg",
                    size_bytes=128,
                    status=MemoryFileStatus.MATCHED,
                )
            )

        with TestClient(app) as client:
            public_list = client.get("/api/v1/memories")
            assert public_list.status_code == 200
            assert [item["title"] for item in public_list.json()["items"]] == ["published memory"]
            public_item = public_list.json()["items"][0]
            assert "remote_md5" not in public_item["primary_file"]
            assert "parent_path" not in public_item["primary_file"]
            assert "modified_at" not in public_item["primary_file"]
            assert "sync_error" not in public_item["primary_file"]

            published_detail = client.get(f"/api/v1/memories/{published.id}")
            assert published_detail.status_code == 200
            assert published_detail.json()["primary_file"]["status"] == "matched"

            hidden_detail = client.get(f"/api/v1/memories/{hidden.id}")
            assert hidden_detail.status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_public_memories_support_kind_counts_and_sort(tmp_path: Path) -> None:
    engine = create_engine(f"sqlite:///{tmp_path / 'memories.db'}")
    testing_session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)

    def override_get_db() -> Generator[Session, None, None]:
        session = testing_session()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    try:
        with testing_session.begin() as session:
            older = Memory(
                title="older photo",
                kind=MemoryKind.PHOTO,
                status=MemoryStatus.PUBLISHED,
                captured_at=datetime(2025, 1, 1, tzinfo=UTC),
            )
            newer = Memory(
                title="newer photo",
                kind=MemoryKind.PHOTO,
                status=MemoryStatus.PUBLISHED,
                captured_at=datetime(2026, 1, 1, tzinfo=UTC),
            )
            video = Memory(
                title="a video",
                kind=MemoryKind.VIDEO,
                status=MemoryStatus.PUBLISHED,
            )
            session.add_all([older, newer, video])
            session.flush()
            for memory in (older, newer, video):
                session.add(
                    MemoryFile(
                        memory_id=memory.id,
                        source="baidupan",
                        remote_path=f"/remote/{memory.id}.jpg",
                        mime_type="image/jpeg",
                        status=MemoryFileStatus.MATCHED,
                    )
                )

        with TestClient(app) as client:
            list_response = client.get("/api/v1/memories")
            payload = list_response.json()
            assert [item["title"] for item in payload["items"]] == [
                "newer photo",
                "older photo",
                "a video",
            ]
            assert payload["counts"] == {"photo": 2, "video": 1}

            ascending = client.get("/api/v1/memories?kind=photo&sort=captured_asc")
            assert [item["title"] for item in ascending.json()["items"]] == [
                "older photo",
                "newer photo",
            ]

            assert client.get(
                "/api/v1/memories?sort=invalid",
            ).status_code == 422
    finally:
        app.dependency_overrides.clear()


def test_memory_recommendations_are_public_and_not_cached(tmp_path: Path) -> None:
    engine = create_engine(f"sqlite:///{tmp_path / 'memories.db'}")
    testing_session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)

    def override_get_db() -> Generator[Session, None, None]:
        session = testing_session()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    try:
        with testing_session.begin() as session:
            memories = [
                Memory(
                    title=f"photo {index}",
                    kind=MemoryKind.PHOTO,
                    status=MemoryStatus.PUBLISHED,
                )
                for index in range(5)
            ]
            hidden = Memory(
                title="hidden photo",
                kind=MemoryKind.PHOTO,
                status=MemoryStatus.HIDDEN,
            )
            memories.append(hidden)
            session.add_all(memories)
            session.flush()
            for memory in memories:
                session.add(
                    MemoryFile(
                        memory_id=memory.id,
                        source="baidupan",
                        remote_path=f"/remote/{memory.id}.jpg",
                        mime_type="image/jpeg",
                        status=MemoryFileStatus.MATCHED,
                    )
                )

        with TestClient(app) as client:
            response = client.get("/api/v1/memories/recommend?limit=3")
            assert response.status_code == 200
            assert len(response.json()) == 3
            assert response.headers["cache-control"] == "no-store"
            assert "hidden photo" not in [
                item["title"] for item in response.json()
            ]

            kind_response = client.get(
                "/api/v1/memories/recommend?kind=video&limit=8",
            )
            assert kind_response.status_code == 200
            assert kind_response.json() == []
    finally:
        app.dependency_overrides.clear()
