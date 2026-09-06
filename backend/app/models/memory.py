import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, Text, Uuid, func
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


class RemoteFileState(StrEnum):
    UNVERIFIED = "unverified"
    READY = "ready"
    MISSING = "missing"
    FAILED = "failed"


class RemoteThumbnailState(StrEnum):
    MISSING = "missing"
    READY = "ready"
    FAILED = "failed"


class RemoteStreamState(StrEnum):
    UNAVAILABLE = "unavailable"
    READY = "ready"
    FAILED = "failed"


class DerivativeFailureKind(StrEnum):
    UNKNOWN = "unknown"
    DISK_QUOTA = "disk_quota"
    REMOTE_AUTH = "remote_auth"
    REMOTE_FORBIDDEN = "remote_forbidden"
    REMOTE_NOT_FOUND = "remote_not_found"
    BAIDU_RATE_LIMITED = "baidu_rate_limited"
    REMOTE_UNAVAILABLE = "remote_unavailable"
    CANCELLED = "cancelled"
    SOURCE_TRUNCATED = "source_truncated"
    TEMPORARY_EMPTY = "temporary_empty"
    TIMEOUT = "timeout"
    FORMAT_UNSUPPORTED = "format_unsupported"
    MOV_MOOV = "mov_moov"
    CODEC_UNSUPPORTED = "codec_unsupported"
    TEMPORARY_IO = "temporary_io"


class RemoteScanStatus(StrEnum):
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class RemoteScanTask(Base):
    __tablename__ = "remote_scan_tasks"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    remote_dir: Mapped[str] = mapped_column(String(1024))
    status: Mapped[RemoteScanStatus] = mapped_column(
        String(32), default=RemoteScanStatus.RUNNING, index=True
    )
    cursor: Mapped[str | None] = mapped_column(Text)
    max_depth: Mapped[int] = mapped_column(Integer, default=8)
    max_items: Mapped[int] = mapped_column(Integer, default=5000)
    delete_missing: Mapped[bool] = mapped_column(Boolean, default=False)
    processed_items: Mapped[int] = mapped_column(Integer, default=0)
    scanned_files: Mapped[int] = mapped_column(Integer, default=0)
    scanned_directories: Mapped[int] = mapped_column(Integer, default=0)
    discovered: Mapped[int] = mapped_column(Integer, default=0)
    refreshed: Mapped[int] = mapped_column(Integer, default=0)
    skipped: Mapped[int] = mapped_column(Integer, default=0)
    failure_reason: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


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
    source_path: Mapped[str] = mapped_column(String(1024), default="")
    mime_type: Mapped[str] = mapped_column(String(128))
    size_bytes: Mapped[int | None]
    remote_md5: Mapped[str | None] = mapped_column(String(64), index=True)
    parent_path: Mapped[str] = mapped_column(String(1024), default="")
    filename: Mapped[str] = mapped_column(String(512), default="")
    extension: Mapped[str | None] = mapped_column(String(64))
    modified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    remote_state: Mapped[RemoteFileState] = mapped_column(
        String(32), default=RemoteFileState.UNVERIFIED, index=True
    )
    thumbnail_state: Mapped[RemoteThumbnailState] = mapped_column(
        String(32), default=RemoteThumbnailState.MISSING, index=True
    )
    thumbnail_failure_kind: Mapped[str | None] = mapped_column(
        String(64), index=True
    )
    stream_state: Mapped[RemoteStreamState] = mapped_column(
        String(32), default=RemoteStreamState.UNAVAILABLE, index=True
    )
    raw_metadata_summary: Mapped[dict[str, object]] = mapped_column(
        JSON, default=dict
    )
    last_scan_task_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    content_hash: Mapped[str | None] = mapped_column(String(64), index=True)
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
