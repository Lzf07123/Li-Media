from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.session import Base
from app.models.memory import Memory, MemoryFile, MemoryKind, MemoryStatus
from app.services.system_snapshot import collect_system_snapshot


def create_database(tmp_path: Path) -> sessionmaker[Session]:
    engine = create_engine(f"sqlite:///{tmp_path / 'snapshot.db'}")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def test_system_snapshot_collects_counts_sizes_and_source_zero(tmp_path: Path) -> None:
    session_factory = create_database(tmp_path)
    media_root = tmp_path / "media"
    (media_root / "thumbnails" / "memory-id" / "v1").mkdir(parents=True)
    (media_root / "thumbnails" / "memory-id" / "v1" / "240.webp").write_bytes(b"a")

    with session_factory.begin() as session:
        session.add(
            Memory(
                title="photo",
                kind=MemoryKind.PHOTO,
                status=MemoryStatus.PUBLISHED,
            )
        )
        session.add(
            Memory(
                title="video",
                kind=MemoryKind.VIDEO,
                status=MemoryStatus.PUBLISHED,
            )
        )
        session.flush()
        session.add(
            MemoryFile(
                remote_path="/cloud/photo.jpg",
                size_bytes=100,
                mime_type="image/jpeg",
            )
        )
        session.add(
            MemoryFile(
                remote_path="/cloud/video.mp4",
                size_bytes=300,
                mime_type="video/mp4",
            )
        )

    with session_factory() as db:
        snapshot = collect_system_snapshot(
            db,
            media_root,
            preheat_latest={"status": "completed", "processed": 3},
        )

    assert snapshot["memories"]["total"] == 2
    assert snapshot["memories"]["published"] == 2
    assert snapshot["memories"]["kinds"] == {"photo": 1, "video": 1}
    assert snapshot["index"]["files"] == 2
    assert snapshot["index"]["bytes"] == 400
    assert snapshot["index"]["size_percentiles"]["p50"] == 100
    assert snapshot["index"]["size_percentiles"]["p90"] == 300
    assert snapshot["thumbnails"]["states"] == {"missing": 2}
    assert snapshot["preheat_latest"] == {"status": "completed", "processed": 3}
    assert snapshot["source_zero"]["compliant"] is True
    assert snapshot["resources"]["temporary"]["files"] == 0
