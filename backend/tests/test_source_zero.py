from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.session import Base
from app.models.memory import MemoryFile
from app.services.source_zero import collect_source_zero_status


def create_database(tmp_path: Path) -> sessionmaker[Session]:
    engine = create_engine(f"sqlite:///{tmp_path / 'source-zero.db'}")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def test_source_zero_audits_database_and_storage_violations(tmp_path: Path) -> None:
    session_factory = create_database(tmp_path)
    media_root = tmp_path / "media"
    (media_root / "thumbnails" / "memory-id" / "v1").mkdir(parents=True)
    (media_root / "photos").mkdir()
    (media_root / "videos").mkdir()
    (media_root / "tmp").mkdir()
    (media_root / "thumbnails" / "memory-id" / "v1" / "240.webp").write_bytes(
        b"derivative"
    )
    (media_root / "photos" / "legacy.png").write_bytes(b"photo")
    (media_root / "videos" / "legacy.mov").write_bytes(b"video")
    (media_root / "tmp" / "upload.jpg").write_bytes(b"temporary source")
    (media_root / "misplaced.jpg").write_bytes(b"unexpected source")

    with session_factory() as db:
        db.add(
                MemoryFile(
                    remote_path="/cloud/legacy.png",
                    mime_type="image/png",
                    source_path="photos/legacy.png",
            )
        )
        db.commit()
        status = collect_source_zero_status(db, media_root)

    assert status["compliant"] is False
    assert status["source_path_count"] == 1
    assert status["source_path_schema_exposed"] is False
    assert status["database_blob_count"] == 0
    assert status["source_media_file_count"] == 4
    assert status["source_media_extensions"] == {
        ".jpg": 2,
        ".mov": 1,
        ".png": 1,
    }
    assert status["media_photos_file_count"] == 1
    assert status["media_videos_file_count"] == 1
    assert status["unexpected_media_file_count"] == 1
    assert status["temporary_file_count"] == 1
    assert status["filesystem_scan_failed"] is False


def test_source_zero_is_compliant_with_only_derived_media(tmp_path: Path) -> None:
    session_factory = create_database(tmp_path)
    media_root = tmp_path / "media"
    (media_root / "thumbnails" / "memory-id" / "v1").mkdir(parents=True)
    (media_root / "tmp").mkdir()
    (media_root / "thumbnails" / "memory-id" / "v1" / "480.webp").write_bytes(
        b"derivative"
    )

    with session_factory() as db:
        status = collect_source_zero_status(db, media_root)

    assert status["compliant"] is True
    assert status["source_path_count"] == 0
    assert status["database_blob_count"] == 0
    assert status["source_media_file_count"] == 0
    assert status["media_photos_file_count"] == 0
    assert status["media_videos_file_count"] == 0
    assert status["temporary_file_count"] == 0
