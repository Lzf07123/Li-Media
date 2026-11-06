from collections.abc import Generator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
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
    RemoteThumbnailState,
)
from tests.derivative_seed import seed_home_derivative


def _seed_library(session_factory: sessionmaker[Session]) -> None:
    with session_factory.begin() as session:
        memories = [
            Memory(
                title=f"memory {index:02d}",
                kind=MemoryKind.PHOTO,
                status=MemoryStatus.PUBLISHED,
            )
            for index in range(24)
        ]
        session.add_all(memories)
        session.flush()
        for memory in memories:
            memory_file = MemoryFile(
                memory_id=memory.id,
                source="baidupan",
                remote_path=f"photos/{memory.title}.jpg",
                source_path=f"photos/{memory.title}.jpg",
                filename=f"{memory.title}.jpg",
                mime_type="image/jpeg",
                size_bytes=128,
                status=MemoryFileStatus.MATCHED,
                remote_state=RemoteFileState.READY,
                thumbnail_state=RemoteThumbnailState.READY,
                stream_state=RemoteStreamState.READY,
            )
            session.add(memory_file)
            session.flush()
            seed_home_derivative(session, memory_file)


def _public_list_select_count(engine, client: TestClient, params: dict) -> int:
    statements: list[str] = []

    def _record(_conn, _cursor, statement, _parameters, _context, _executemany) -> None:
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    event.listen(engine, "after_cursor_execute", _record)
    try:
        response = client.get("/api/v1/memories", params=params)
    finally:
        event.remove(engine, "after_cursor_execute", _record)

    assert response.status_code == 200
    payload = response.json()
    assert len(payload["items"]) == 18
    assert payload["items"][0]["primary_file"] is not None
    return len(statements)


@pytest.mark.parametrize(
    "params",
    [
        {"page_size": 18},
        {"page_size": 18, "sort": "random", "seed": "unit-test-seed"},
        {"page_size": 18, "kind": "photo"},
    ],
    ids=["captured_desc", "random", "kind_filter"],
)
def test_public_list_emits_bounded_queries_per_page(
    tmp_path: Path, params: dict
) -> None:
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
        _seed_library(session_factory)
        client = TestClient(app)
        select_count = _public_list_select_count(engine, client, params)
    finally:
        app.dependency_overrides.pop(get_db, None)

    # 1 page statement + 1 eager files load + 4 count statements; a regression
    # to per-card lazy loading would add one SELECT per item on the page.
    # Random sort legitimately spends one extra SELECT on the full-ID scan
    # behind the seeded shuffle (tracked as a separate optimization task).
    bound = 7 if params.get("sort") == "random" else 6
    assert select_count <= bound, f"public list issued {select_count} SELECTs"
