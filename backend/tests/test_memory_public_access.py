from collections.abc import Generator
from pathlib import Path
from datetime import UTC, datetime

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.db.session import Base, get_db
from app.main import app
from app.models.memory import Memory, MemoryFile, MemoryFileStatus, MemoryKind, MemoryStatus
from app.models.memory import (
    BrowserCompatibilityState,
    DerivativeCacheStatus,
    MemoryDerivativeCache,
    RemoteFileState,
    RemoteThumbnailState,
    RemoteStreamState,
)
from app.services.thumbnail_preheat import HOME_PREHEAT_SIZE


def seed_home_derivative(
    session: Session,
    memory_file: MemoryFile,
    *,
    max_size: int = HOME_PREHEAT_SIZE,
) -> None:
    """写入首页尺寸就绪派生缓存行（画布可见门槛的唯一权威口径）。"""

    session.add(
        MemoryDerivativeCache(
            memory_file_id=memory_file.id,
            max_size=max_size,
            derivative_version=get_settings().media_derivative_version,
            status=DerivativeCacheStatus.READY,
        )
    )


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
            published_file = MemoryFile(
                memory_id=published.id,
                source="baidupan",
                remote_path="published.jpg",
                source_path="photos/published.jpg",
                filename="published.jpg",
                mime_type="image/jpeg",
                size_bytes=128,
                status=MemoryFileStatus.MATCHED,
                remote_state=RemoteFileState.READY,
                thumbnail_state=RemoteThumbnailState.READY,
                stream_state=RemoteStreamState.READY,
            )
            session.add(published_file)
            session.flush()
            seed_home_derivative(session, published_file)

        with TestClient(app) as client:
            public_list = client.get("/api/v1/memories")
            assert public_list.status_code == 200
            assert [item["title"] for item in public_list.json()["items"]] == ["published memory"]
            public_item = public_list.json()["items"][0]
            assert "remote_md5" not in public_item["primary_file"]
            assert "parent_path" not in public_item["primary_file"]
            assert "modified_at" not in public_item["primary_file"]
            assert "remote_id" not in public_item["primary_file"]
            assert "remote_path" not in public_item["primary_file"]
            assert "status" not in public_item["primary_file"]
            assert "thumbnail_failure_kind" not in public_item["primary_file"]
            assert "browser_format_summary" not in public_item["primary_file"]
            assert "browser_compatibility_error" not in public_item["primary_file"]
            assert "last_synced_at" not in public_item["primary_file"]
            assert "sync_error" not in public_item["primary_file"]
            assert public_item["primary_file"]["filename"] == "published.jpg"

            recommendation = client.get("/api/v1/memories/recommend?limit=1")
            assert recommendation.status_code == 200
            recommended_item = recommendation.json()[0]
            assert recommended_item["title"] == "published memory"
            assert "remote_id" not in recommended_item["primary_file"]
            assert "remote_path" not in recommended_item["primary_file"]
            assert "status" not in recommended_item["primary_file"]
            assert "thumbnail_failure_kind" not in recommended_item["primary_file"]
            assert "browser_format_summary" not in recommended_item["primary_file"]
            assert "browser_compatibility_error" not in recommended_item["primary_file"]
            assert "last_synced_at" not in recommended_item["primary_file"]
            assert "sync_error" not in recommended_item["primary_file"]

            published_detail = client.get(f"/api/v1/memories/{published.id}")
            assert published_detail.status_code == 200
            detail_file = published_detail.json()["primary_file"]
            assert detail_file["filename"] == "published.jpg"
            assert "remote_id" not in detail_file
            assert "remote_path" not in detail_file
            assert "status" not in detail_file
            assert "thumbnail_failure_kind" not in detail_file
            assert "browser_format_summary" not in detail_file
            assert "browser_compatibility_error" not in detail_file
            assert "last_synced_at" not in detail_file
            assert "sync_error" not in detail_file

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
                memory_file = MemoryFile(
                    memory_id=memory.id,
                    source="baidupan",
                    remote_path=f"/remote/{memory.id}.jpg",
                    mime_type="image/jpeg",
                    status=MemoryFileStatus.MATCHED,
                    remote_state=RemoteFileState.READY,
                    thumbnail_state=RemoteThumbnailState.READY,
                    stream_state=RemoteStreamState.READY,
                    browser_compatibility=BrowserCompatibilityState.SUPPORTED,
                )
                session.add(memory_file)
                session.flush()
                seed_home_derivative(session, memory_file)

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
                memory_file = MemoryFile(
                    memory_id=memory.id,
                    source="baidupan",
                    remote_path=f"/remote/{memory.id}.jpg",
                    mime_type="image/jpeg",
                    status=MemoryFileStatus.MATCHED,
                    remote_state=RemoteFileState.READY,
                    thumbnail_state=RemoteThumbnailState.READY,
                    stream_state=RemoteStreamState.READY,
                )
                session.add(memory_file)
                session.flush()
                if memory.status == MemoryStatus.PUBLISHED:
                    seed_home_derivative(session, memory_file)

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


def test_random_list_pages_keep_one_seed_and_refresh_can_reorder(
    tmp_path: Path,
) -> None:
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
                for index in range(9)
            ]
            session.add_all(memories)
            session.flush()
            for memory in memories:
                memory_file = MemoryFile(
                    memory_id=memory.id,
                    source="baidupan",
                    remote_path=f"/remote/{memory.id}.jpg",
                    mime_type="image/jpeg",
                    status=MemoryFileStatus.MATCHED,
                    remote_state=RemoteFileState.READY,
                    thumbnail_state=RemoteThumbnailState.READY,
                    stream_state=RemoteStreamState.READY,
                    browser_compatibility=BrowserCompatibilityState.SUPPORTED,
                )
                session.add(memory_file)
                session.flush()
                seed_home_derivative(session, memory_file)

        def get_random_page(page: int, seed: str) -> list[str]:
            response = client.get(
                f"/api/v1/memories?sort=random&seed={seed}"
                f"&page={page}&page_size=3",
            )
            assert response.status_code == 200
            assert response.headers["cache-control"] == "no-store"
            return [item["title"] for item in response.json()["items"]]

        with TestClient(app) as client:
            first_visit = get_random_page(1, "visit-a")
            assert first_visit == get_random_page(1, "visit-a")
            assert first_visit != get_random_page(1, "visit-b")

            all_titles = [
                *first_visit,
                *get_random_page(2, "visit-a"),
                *get_random_page(3, "visit-a"),
            ]
            assert len(all_titles) == len(set(all_titles)) == 9
            assert set(all_titles) == {f"photo {index}" for index in range(9)}
    finally:
        app.dependency_overrides.clear()


def test_public_canvas_only_lists_home_derivative_ready_memories(
    tmp_path: Path,
) -> None:
    """画布可见性 = 240px 派生图就绪；未就绪内容只从列表/推荐消失，直链仍可达。"""

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
    version = get_settings().media_derivative_version
    try:
        with testing_session.begin() as session:
            cached = Memory(
                title="cache ready",
                kind=MemoryKind.PHOTO,
                status=MemoryStatus.PUBLISHED,
            )
            pending = Memory(
                title="pending preheat",
                kind=MemoryKind.PHOTO,
                status=MemoryStatus.PUBLISHED,
            )
            legacy = Memory(
                title="legacy 240 path",
                kind=MemoryKind.PHOTO,
                status=MemoryStatus.PUBLISHED,
                thumbnail_path=f"thumbnails/{pending.id}/{version}/240.webp",
            )
            polluted = Memory(
                title="legacy 480 path",
                kind=MemoryKind.PHOTO,
                status=MemoryStatus.PUBLISHED,
                # 按需路由可能把 480/1280 写进 thumbnail_path；后缀口径不得放行
                thumbnail_path=f"thumbnails/{pending.id}/{version}/480.webp",
            )
            session.add_all([cached, pending, legacy, polluted])
            session.flush()
            for memory in (cached, pending, legacy, polluted):
                memory_file = MemoryFile(
                    memory_id=memory.id,
                    source="baidupan",
                    remote_path=f"/remote/{memory.id}.jpg",
                    mime_type="image/jpeg",
                    status=MemoryFileStatus.MATCHED,
                    remote_state=RemoteFileState.READY,
                    thumbnail_state=RemoteThumbnailState.READY,
                    stream_state=RemoteStreamState.READY,
                    browser_compatibility=BrowserCompatibilityState.SUPPORTED,
                )
                session.add(memory_file)
                session.flush()
                if memory is cached:
                    seed_home_derivative(session, memory_file)

        with TestClient(app) as client:
            payload = client.get("/api/v1/memories").json()
            # captured_at 均为 NULL 时排序不构成稳定序，按集合断言可见性
            assert {item["title"] for item in payload["items"]} == {
                "cache ready",
                "legacy 240 path",
            }
            assert payload["total"] == 2
            assert payload["counts"] == {"photo": 2, "video": 0}
            # 全量公开口径不随画布过滤收窄
            assert payload["public_counts"] == {"photo": 4, "video": 0}

            recommend = client.get("/api/v1/memories/recommend?limit=10")
            assert {item["title"] for item in recommend.json()} == {
                "cache ready",
                "legacy 240 path",
            }

            # 未预热内容只对画布隐身：详情直链（查看器入口）仍可达
            pending_detail = client.get(f"/api/v1/memories/{pending.id}")
            assert pending_detail.status_code == 200
            assert pending_detail.json()["title"] == "pending preheat"
    finally:
        app.dependency_overrides.clear()


def test_public_keyword_search_escapes_like_wildcards(tmp_path: Path) -> None:
    """`%`/`_` 按字面量匹配：语义注入与全表扫描放大被关掉。"""

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
            titles = ("100% 纯天然", "photo_2026", "普通照片")
            for title in titles:
                memory = Memory(
                    title=title,
                    kind=MemoryKind.PHOTO,
                    status=MemoryStatus.PUBLISHED,
                )
                session.add(memory)
                session.flush()
                memory_file = MemoryFile(
                    memory_id=memory.id,
                    source="baidupan",
                    remote_path=f"/remote/{memory.id}.jpg",
                    mime_type="image/jpeg",
                    status=MemoryFileStatus.MATCHED,
                    remote_state=RemoteFileState.READY,
                    thumbnail_state=RemoteThumbnailState.READY,
                    stream_state=RemoteStreamState.READY,
                    browser_compatibility=BrowserCompatibilityState.SUPPORTED,
                )
                session.add(memory_file)
                session.flush()
                seed_home_derivative(session, memory_file)

        with TestClient(app) as client:
            literal_percent = client.get(
                "/api/v1/memories", params={"keyword": "100%"}
            )
            assert [item["title"] for item in literal_percent.json()["items"]] == [
                "100% 纯天然"
            ]

            literal_underscore = client.get(
                "/api/v1/memories", params={"keyword": "photo_2026"}
            )
            assert [item["title"] for item in literal_underscore.json()["items"]] == [
                "photo_2026"
            ]
    finally:
        app.dependency_overrides.clear()
