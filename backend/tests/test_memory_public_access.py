from collections.abc import Generator
from pathlib import Path

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
                    source="upload",
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

            published_detail = client.get(f"/api/v1/memories/{published.id}")
            assert published_detail.status_code == 200
            assert published_detail.json()["primary_file"]["status"] == "matched"

            hidden_detail = client.get(f"/api/v1/memories/{hidden.id}")
            assert hidden_detail.status_code == 404
    finally:
        app.dependency_overrides.clear()
