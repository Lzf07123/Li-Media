import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class MemoryKind(StrEnum):
    PHOTO = "photo"
    VIDEO = "video"


class MemoryStatus(StrEnum):
    PENDING = "pending"
    DRAFT = "draft"
    PUBLISHED = "published"
    HIDDEN = "hidden"
    ERROR = "error"


class MemoryFileStatus(StrEnum):
    DISCOVERED = "discovered"
    PENDING = "pending"
    SYNCING = "syncing"
    MATCHED = "matched"
    MISSING = "missing"
    REMOVED = "removed"
    FAILED = "failed"


class Memory(Base):
    __tablename__ = "memories"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(255), index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    kind: Mapped[MemoryKind] = mapped_column(String(32), index=True)
    status: Mapped[MemoryStatus] = mapped_column(
        String(32), default=MemoryStatus.PENDING, index=True
    )
    captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    location: Mapped[str | None] = mapped_column(String(255))
    thumbnail_path: Mapped[str | None] = mapped_column(String(512))
    duration_seconds: Mapped[int | None]
    width: Mapped[int | None]
    height: Mapped[int | None]
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    files: Mapped[list["MemoryFile"]] = relationship(back_populates="memory")


class MemoryFile(Base):
    __tablename__ = "memory_files"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    memory_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("memories.id", ondelete="SET NULL")
    )
    source: Mapped[str] = mapped_column(String(32), default="baidupan")
    remote_path: Mapped[str] = mapped_column(String(1024), index=True)
    remote_id: Mapped[str | None] = mapped_column(String(128))
    source_path: Mapped[str] = mapped_column(String(1024))
    mime_type: Mapped[str] = mapped_column(String(128))
    size_bytes: Mapped[int | None]
    status: Mapped[MemoryFileStatus] = mapped_column(
        String(32), default=MemoryFileStatus.PENDING, index=True
    )
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sync_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    memory: Mapped[Memory | None] = relationship(back_populates="files")
