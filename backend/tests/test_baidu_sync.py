from collections.abc import Generator
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.db.session import Base, get_db, get_session_factory
from app.main import app
from app.models.admin import AdminOperationLog
from app.models.memory import (
    Memory,
    MemoryFile,
    MemoryFileStatus,
    MemoryKind,
    MemoryStatus,
    RemoteFileState,
    RemoteScanStatus,
    RemoteScanTask,
    RemoteStreamState,
)
from app.services.baidu_pan import BaiduListPage, BaiduPanError, BaiduRemoteItem
from app.services.baidu_oauth import BaiduCredentials, save_baidu_credentials
from app.services.baidu_sync import refresh_remote_entry, scan_remote_directory


def remote_item(
    remote_path: str,
    *,
    fs_id: str,
    is_dir: bool = False,
    md5: str | None = None,
) -> BaiduRemoteItem:
    path = Path(remote_path)
    return BaiduRemoteItem(
        remote_id=fs_id,
        remote_path=remote_path,
        filename=path.name,
        parent_path=str(path.parent) if str(path.parent) != "/" else "",
        is_dir=is_dir,
        size_bytes=None if is_dir else 256,
        modified_at=datetime(2024, 3, 4, 12, 30, tzinfo=UTC),
        md5=md5,
        category="3" if remote_path.endswith((".jpg", ".mp4")) else None,
        thumbnail_url=None,
        raw_metadata_summary={
            "fs_id": fs_id,
            "is_dir": is_dir,
            "md5": md5,
            "mtime": 1709555400,
            "size": 256,
            "has_download_link": False,
            "has_thumbnail": False,
        },
    )


class FakeRemoteClient:
    def __init__(self, tree: dict[str, list[BaiduRemoteItem]]) -> None:
        self.tree = tree
        self.metadata_calls = 0

    def list_page(
        self,
        remote_dir: str,
        *,
        start: int,
        limit: int | None = None,
    ) -> BaiduListPage:
        page_size = limit or 1
        items = self.tree.get(remote_dir, [])
        page = items[start : start + page_size]
        next_start = start + len(page) if len(page) == page_size else None
        return BaiduListPage(items=page, next_start=next_start)

    def get_file_metadata(self, remote_id: str) -> BaiduRemoteItem:
        self.metadata_calls += 1
        for items in self.tree.values():
            for item in items:
                if item.remote_id == remote_id:
                    return item
        raise BaiduPanError("远程文件不存在")


def create_database(tmp_path: Path) -> sessionmaker[Session]:
    engine = create_engine(f"sqlite:///{tmp_path / 'memories.db'}")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def override_database(session_factory: sessionmaker[Session]) -> Generator[Session, None, None]:
    session = session_factory()
    try:
        yield session
    finally:
        session.close()


def test_scan_is_recursive_incremental_and_deduplicates(tmp_path: Path) -> None:
    tree = {
        "/root": [
            remote_item("/root/2024", fs_id="10", is_dir=True),
            remote_item("/root/IMG_20240304_123456.jpg", fs_id="11"),
            remote_item("/root/notes.txt", fs_id="12"),
        ],
        "/root/2024": [
            remote_item("/root/2024/clip.mp4", fs_id="13"),
            remote_item("/root/2024/copy.jpg", fs_id="14", md5="same-md5"),
        ],
    }
    tree["/root/2024"].insert(0, remote_item("/root/2024/photo.jpg", fs_id="15", md5="same-md5"))
    session_factory = create_database(tmp_path)

    with session_factory() as session:
        first = scan_remote_directory(
            session,
            FakeRemoteClient(tree),
            remote_dir="/root",
            max_depth=4,
            max_items=100,
        )
        memories = session.scalars(select(Memory)).all()
        files = session.scalars(select(MemoryFile)).all()

        assert first.status == RemoteScanStatus.COMPLETED
        assert first.scanned_directories == 1
        assert first.skipped == 1
        assert first.discovered == 4
        assert len(memories) == 3
        assert len(files) == 4
        assert all(file.source_path == "" for file in files)
        assert all(file.status == MemoryFileStatus.MATCHED for file in files)
        assert {file.extension for file in files} == {"jpg", "mp4"}
        duplicate_paths = [file.remote_path for file in files if file.remote_md5 == "same-md5"]
        assert len(duplicate_paths) == 2
        duplicate_memory_ids = {
            file.memory_id for file in files if file.remote_md5 == "same-md5"
        }
        assert len(duplicate_memory_ids) == 1
        memory_ids = {memory.id for memory in memories}

        second = scan_remote_directory(
            session,
            FakeRemoteClient(tree),
            remote_dir="/root",
            max_depth=4,
            max_items=100,
        )
        assert second.discovered == 0
        assert second.refreshed == 4
        assert {memory.id for memory in session.scalars(select(Memory)).all()} == memory_ids


def test_failed_scan_keeps_checkpoint_and_can_resume(tmp_path: Path) -> None:
    tree = {
        "/root": [
            remote_item("/root/first.jpg", fs_id="21"),
            remote_item("/root/second.jpg", fs_id="22"),
        ]
    }

    class FailingClient(FakeRemoteClient):
        def list_page(self, remote_dir: str, *, start: int, limit: int | None = None):
            if start == 1:
                raise BaiduPanError("分页请求失败")
            return super().list_page(remote_dir, start=start, limit=limit)

    session_factory = create_database(tmp_path)
    with session_factory() as session:
        failed = scan_remote_directory(
            session,
            FailingClient(tree),
            remote_dir="/root",
            max_depth=2,
            max_items=100,
        )
        assert failed.status == RemoteScanStatus.FAILED
        assert failed.failure_reason == "分页请求失败"
        assert failed.processed_items == 1
        assert failed.cursor is not None
        assert '"start": 1' in failed.cursor
        assert session.scalar(select(MemoryFile)).remote_path == "/root/first.jpg"

        resumed = scan_remote_directory(
            session,
            FakeRemoteClient(tree),
            remote_dir="/root",
            max_depth=2,
            max_items=100,
            resume_task_id=failed.task_id,
        )
        assert resumed.status == RemoteScanStatus.COMPLETED
        assert resumed.processed_items == 2
        assert len(session.scalars(select(MemoryFile)).all()) == 2


def test_refresh_remote_entry_marks_metadata_failure(tmp_path: Path) -> None:
    session_factory = create_database(tmp_path)
    with session_factory() as session:
        memory = Memory(
            title="remote",
            kind=MemoryKind.PHOTO,
            status=MemoryStatus.PENDING,
        )
        memory_file = MemoryFile(
            memory_id=memory.id,
            source="baidupan",
            remote_id="31",
            remote_path="/root/photo.jpg",
            parent_path="/root",
            filename="photo.jpg",
            mime_type="image/jpeg",
            status=MemoryFileStatus.FAILED,
            remote_state=RemoteFileState.FAILED,
            stream_state=RemoteStreamState.FAILED,
        )
        session.add_all([memory, memory_file])
        session.commit()

        class MissingClient:
            def get_file_metadata(self, remote_id: str) -> BaiduRemoteItem:
                raise BaiduPanError("远程文件不存在")

        try:
            refresh_remote_entry(session, MissingClient(), memory_file)
        except BaiduPanError:
            pass
        else:
            raise AssertionError("expected BaiduPanError")

        assert memory_file.remote_state == RemoteFileState.FAILED
        assert memory_file.sync_error == "远程元数据刷新失败"


def test_delete_missing_policy_fully_syncs_remote_index(tmp_path: Path) -> None:
    session_factory = create_database(tmp_path)
    old_memory_id = uuid4()
    with session_factory.begin() as session:
        session.add(
            Memory(
                id=old_memory_id,
                title="旧网盘资源",
                kind=MemoryKind.PHOTO,
                status=MemoryStatus.PUBLISHED,
            )
        )
        session.add(
            MemoryFile(
                memory_id=old_memory_id,
                source="baidupan",
                remote_id="old-1",
                remote_path="/root/old.jpg",
                parent_path="/root",
                filename="old.jpg",
                mime_type="image/jpeg",
                status=MemoryFileStatus.MATCHED,
                remote_state=RemoteFileState.READY,
                stream_state=RemoteStreamState.READY,
            )
        )

    tree = {
        "/root": [
            remote_item("/root/new.jpg", fs_id="new-1"),
        ]
    }

    with session_factory() as session:
        summary = scan_remote_directory(
            session,
            FakeRemoteClient(tree),
            remote_dir="/root",
            max_depth=2,
            max_items=100,
            delete_missing=True,
        )

        assert summary.status == RemoteScanStatus.COMPLETED
        assert summary.deleted == 1
        assert session.scalar(select(MemoryFile).where(MemoryFile.remote_id == "old-1")) is None
        assert session.get(Memory, old_memory_id) is None
        remaining_file = session.scalar(select(MemoryFile))
        assert remaining_file is not None
        assert remaining_file.remote_id == "new-1"

    with session_factory() as session:
        delete_log = session.scalar(
            select(AdminOperationLog).where(
                AdminOperationLog.action == "remote_index_delete"
            )
        )
        assert delete_log is not None
        assert "remote_resource=unchanged" in delete_log.detail


def test_admin_scan_is_scan_only_and_retry_logs_operation(tmp_path: Path, monkeypatch) -> None:
    tree = {
        "/apps/Li&Media": [
            remote_item("/apps/Li&Media/photo.jpg", fs_id="41"),
        ]
    }
    client = FakeRemoteClient(tree)
    media_root = tmp_path / "media"
    media_root.mkdir()
    session_factory = create_database(tmp_path)
    settings = Settings(
        admin_token="test-token",
        baidu_access_token="test-access-token",
        media_root=str(media_root),
        baidu_sync_dir="/apps/Li&Media",
    )
    monkeypatch.setattr("app.api.v1.admin.get_settings", lambda: settings)
    monkeypatch.setattr(
        "app.api.v1.admin.BaiduPanClient",
        lambda settings: client,
    )

    def override_get_db() -> Generator[Session, None, None]:
        yield from override_database(session_factory)

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    try:
        with TestClient(app) as test_client:
            assert test_client.post(
                "/api/v1/admin/login", json={"token": "test-token"}
            ).status_code == 204

            scan_response = test_client.post("/api/v1/admin/sync")
            assert scan_response.status_code == 200
            payload = scan_response.json()
            assert payload["discovered"] == 0
            assert payload["scan_task"]["status"] == "running"
            assert payload["scan_task"]["delete_missing"] is True
            assert "dlink" not in scan_response.text.lower()
            assert not any(media_root.rglob("*"))

            file_id = session_factory().scalar(select(MemoryFile)).id
            retry_response = test_client.post(
                f"/api/v1/admin/remote-entries/{file_id}/retry"
            )
            assert retry_response.status_code == 200
            assert retry_response.json()["primary_file"]["remote_state"] == "ready"

        with session_factory() as session:
            actions = set(session.scalars(select(AdminOperationLog.action)).all())
            assert {"login", "scan_queued", "scan", "remote_retry"}.issubset(actions)
            task = session.scalar(select(RemoteScanTask))
            assert task is not None
            assert task.status == RemoteScanStatus.COMPLETED
            assert task.delete_missing is True
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.pop(get_session_factory, None)


def test_admin_scan_accepts_service_credential_file(tmp_path: Path, monkeypatch) -> None:
    tree = {
        "/apps/Li&Media": [
            remote_item("/apps/Li&Media/photo.jpg", fs_id="42"),
        ]
    }
    client = FakeRemoteClient(tree)
    media_root = tmp_path / "media"
    media_root.mkdir()
    credentials_path = tmp_path / "config" / "baidu_token.json"
    session_factory = create_database(tmp_path)
    settings = Settings(
        admin_token="test-token",
        baidu_access_token="",
        baidu_credentials_path=str(credentials_path),
        media_root=str(media_root),
        baidu_sync_dir="/apps/Li&Media",
    )
    save_baidu_credentials(
        settings,
        BaiduCredentials(
            access_token="file-access-token",
            refresh_token=None,
            expires_at=datetime.now(UTC).replace(microsecond=0),
            scope="basic,netdisk",
        ),
    )
    monkeypatch.setattr("app.api.v1.admin.get_settings", lambda: settings)
    monkeypatch.setattr(
        "app.api.v1.admin.BaiduPanClient",
        lambda settings: client,
    )

    def override_get_db() -> Generator[Session, None, None]:
        yield from override_database(session_factory)

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    try:
        with TestClient(app) as test_client:
            assert test_client.post(
                "/api/v1/admin/login", json={"token": "test-token"}
            ).status_code == 204
            assert test_client.post("/api/v1/admin/sync").status_code == 200
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.pop(get_session_factory, None)
