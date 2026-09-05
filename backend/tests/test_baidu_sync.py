from collections.abc import Generator
from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.db.session import Base, get_db
from app.main import app
from app.models.memory import MemoryFile, MemoryFileStatus, MemoryStatus
from app.services.baidu_pan import BaiduRemoteFile
from app.services.baidu_sync import sync_baidu_files


class FakeBaiduClient:
    def __init__(self, source_path: Path) -> None:
        self.source_path = source_path

    def list_directory(self, remote_dir: str) -> list[BaiduRemoteFile]:
        return [
            BaiduRemoteFile(
                remote_id="123456",
                remote_path=f"{remote_dir}/metadata.jpg",
                filename="metadata.jpg",
                size_bytes=self.source_path.stat().st_size,
                modified_at=datetime.now(timezone.utc),
            )
        ]

    def download(
        self,
        remote_id: str,
        target_path: Path,
        *,
        max_bytes: int,
    ) -> int:
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_bytes(self.source_path.read_bytes())
        return target_path.stat().st_size


def create_test_image(path: Path) -> None:
    image = Image.new("RGB", (2400, 1200), "white")
    exif = Image.Exif()
    exif[40091] = "同步标题".encode("utf-16le")
    exif[270] = "同步描述".encode("utf-8")
    exif_ifd = exif.get_ifd(0x8769)
    exif_ifd[36867] = "2024:03:04 12:34:56"
    gps_ifd = exif.get_ifd(0x8825)
    gps_ifd[1] = "N"
    gps_ifd[2] = (30.0, 0.0, 0.0)
    gps_ifd[3] = "E"
    gps_ifd[4] = (120.0, 0.0, 0.0)
    image.save(path, format="JPEG", exif=exif)


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


def test_sync_downloads_metadata_and_prevents_duplicates(tmp_path: Path) -> None:
    source_path = tmp_path / "source.jpg"
    create_test_image(source_path)
    media_root = tmp_path / "media"
    media_root.mkdir()
    session_factory = create_database(tmp_path)

    with session_factory() as session:
        summary = sync_baidu_files(
            session,
            FakeBaiduClient(source_path),
            media_root,
            remote_dir="/apps/Li&Media",
        )
        memory_file = session.scalar(select(MemoryFile))
        memory = memory_file.memory

        assert summary.discovered == 1
        assert memory_file.sync_error is None
        assert summary.matched == 1
        assert memory_file is not None
        assert memory_file.status == MemoryFileStatus.MATCHED
        assert memory_file.remote_id == "123456"
        assert memory_file.source_path.startswith("remote/")
        assert memory_file.last_synced_at is not None
        assert memory_file.sync_error is None
        assert memory is not None
        assert memory.title == "同步标题"
        assert memory.description == "同步描述"
        assert memory.captured_at is not None
        assert memory.captured_at.year == 2024
        assert memory.location == "30.000000, 120.000000"
        assert memory.width == 2400
        assert memory.height == 1200
        assert memory.thumbnail_path is not None
        assert (media_root / memory.thumbnail_path).is_file()
        assert memory.status == MemoryStatus.PENDING

        second_summary = sync_baidu_files(
            session,
            FakeBaiduClient(source_path),
            media_root,
            remote_dir="/apps/Li&Media",
        )
        file_count = len(session.scalars(select(MemoryFile)).all())

        assert second_summary.discovered == 0
        assert file_count == 1


def test_sync_failure_records_status_without_local_source(tmp_path: Path) -> None:
    media_root = tmp_path / "media"
    media_root.mkdir()
    session_factory = create_database(tmp_path)

    class FailingClient:
        def list_directory(self, remote_dir: str) -> list[BaiduRemoteFile]:
            return [
                BaiduRemoteFile(
                    remote_id="123456",
                    remote_path=f"{remote_dir}/metadata.jpg",
                    filename="metadata.jpg",
                    size_bytes=64,
                    modified_at=datetime.now(timezone.utc),
                )
            ]

        def download(
            self,
            remote_id: str,
            target_path: Path,
            *,
            max_bytes: int,
        ) -> int:
            target_path.write_bytes(b"partial")
            raise RuntimeError("download interrupted")

    with session_factory() as session:
        summary = sync_baidu_files(
            session,
            FailingClient(),
            media_root,
            remote_dir="/apps/Li&Media",
        )
        memory_file = session.scalar(select(MemoryFile))

        assert summary.failed == 1
        assert memory_file is not None
        assert memory_file.status == MemoryFileStatus.FAILED
        assert memory_file.source_path == ""
        assert memory_file.sync_error is not None
        assert memory_file.last_synced_at is not None
        assert not (media_root / "remote" / str(memory_file.id)).exists()


def test_sync_marks_absent_remote_file_missing(tmp_path: Path) -> None:
    source_path = tmp_path / "source.jpg"
    create_test_image(source_path)
    media_root = tmp_path / "media"
    media_root.mkdir()
    session_factory = create_database(tmp_path)

    class EmptyClient:
        def list_directory(self, remote_dir: str) -> list[BaiduRemoteFile]:
            return []

        def download(self, remote_id: str, target_path: Path, *, max_bytes: int) -> int:
            return 0

    with session_factory() as session:
        sync_baidu_files(
            session,
            FakeBaiduClient(source_path),
            media_root,
            remote_dir="/apps/Li&Media",
        )
        summary = sync_baidu_files(
            session,
            EmptyClient(),
            media_root,
            remote_dir="/apps/Li&Media",
        )
        memory_file = session.scalar(select(MemoryFile))

        assert summary.discovered == 0
        assert memory_file is not None
        assert memory_file.status == MemoryFileStatus.MISSING
        assert memory_file.sync_error == "网盘目录中未找到该文件"


def test_admin_sync_endpoint_uses_worker(tmp_path: Path, monkeypatch) -> None:
    source_path = tmp_path / "source.jpg"
    create_test_image(source_path)
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
        lambda settings: FakeBaiduClient(source_path),
    )

    def override_get_db() -> Generator[Session, None, None]:
        yield from override_database(session_factory)

    app.dependency_overrides[get_db] = override_get_db
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/v1/admin/sync",
                headers={"X-Admin-Token": "test-token"},
            )

        assert response.status_code == 200
        assert response.json() == {"discovered": 1, "matched": 1, "failed": 0}
    finally:
        app.dependency_overrides.clear()
