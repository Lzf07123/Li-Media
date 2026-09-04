import uuid
from datetime import datetime
from decimal import Decimal
from enum import StrEnum

from sqlalchemy import DateTime, ForeignKey, Numeric, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class MediaKind(StrEnum):
    MOVIE = "movie"
    TV = "tv"
    ANIME = "anime"
    DOCUMENTARY = "documentary"
    MV = "mv"


class MediaStatus(StrEnum):
    PENDING = "pending"
    DRAFT = "draft"
    PUBLISHED = "published"
    HIDDEN = "hidden"
    ERROR = "error"


class MediaFileStatus(StrEnum):
    DISCOVERED = "discovered"
    MATCHED = "matched"
    MISSING = "missing"
    REMOVED = "removed"


class Media(Base):
    __tablename__ = "media"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(255), index=True)
    original_title: Mapped[str | None] = mapped_column(String(255))
    kind: Mapped[MediaKind] = mapped_column(String(32))
    status: Mapped[MediaStatus] = mapped_column(
        String(32), default=MediaStatus.PENDING, index=True
    )
    year: Mapped[int | None]
    overview: Mapped[str] = mapped_column(Text, default="")
    rating: Mapped[Decimal | None] = mapped_column(Numeric(3, 1))
    poster_path: Mapped[str | None] = mapped_column(String(512))
    backdrop_path: Mapped[str | None] = mapped_column(String(512))
    tmdb_id: Mapped[str | None] = mapped_column(String(32), unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    files: Mapped[list["MediaFile"]] = relationship(back_populates="media")


class MediaFile(Base):
    __tablename__ = "media_files"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    media_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("media.id", ondelete="SET NULL")
    )
    source: Mapped[str] = mapped_column(String(32), default="baidupan")
    remote_path: Mapped[str] = mapped_column(String(1024), index=True)
    remote_id: Mapped[str | None] = mapped_column(String(128))
    size_bytes: Mapped[int | None]
    status: Mapped[MediaFileStatus] = mapped_column(
        String(32), default=MediaFileStatus.DISCOVERED, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    media: Mapped[Media | None] = relationship(back_populates="files")

