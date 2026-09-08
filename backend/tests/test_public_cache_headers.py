from collections.abc import Generator
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.session import Base, get_db
from app.main import app
from app.models.memory import (
    Memory,
    MemoryFile,
    MemoryFileStatus,
    MemoryKind,
    MemoryStatus,
    RemoteFileState,
    RemoteStreamState,
)


def test_public_list_cache_is_private_when_credentials_are_present(tmp_path: Path) -> None:
    engine = create_engine(f"sqlite:///{tmp_path / 'memories.db'}")
    session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)

    def override_get_db() -> Generator[Session, None, None]:
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    try:
        with session_factory.begin() as session:
            memory = Memory(
                title="lake morning",
                kind=MemoryKind.PHOTO,
                status=MemoryStatus.PUBLISHED,
            )
            session.add(memory)
            session.flush()
            session.add(
                MemoryFile(
                    memory_id=memory.id,
                    source="baidupan",
                    remote_path="/cloud/lake.jpg",
                    mime_type="image/jpeg",
                    status=MemoryFileStatus.MATCHED,
                    remote_state=RemoteFileState.READY,
                    stream_state=RemoteStreamState.READY,
                )
            )

        with TestClient(app) as client:
            anonymous = client.get("/api/v1/memories")
            assert anonymous.status_code == 200
            assert anonymous.headers["Cache-Control"] == (
                "public, max-age=15, stale-while-revalidate=30"
            )

            with_cookie = client.get("/api/v1/memories", cookies={"session": "private"})
            assert with_cookie.status_code == 200
            assert with_cookie.headers["Cache-Control"] == "no-store"

            with_authorization = client.get(
                "/api/v1/memories",
                headers={"Authorization": "Bearer private"},
            )
            assert with_authorization.status_code == 200
            assert with_authorization.headers["Cache-Control"] == "no-store"
    finally:
        app.dependency_overrides.clear()
