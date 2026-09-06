import uuid
from datetime import datetime
from pydantic import BaseModel, ConfigDict, computed_field

from app.models.memory import (
    Memory,
    MemoryFileStatus,
    MemoryKind,
    MemoryStatus,
    RemoteFileState,
    RemoteStreamState,
    RemoteThumbnailState,
)


class MemoryFileRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    source: str
    remote_id: str | None
    remote_path: str
    parent_path: str
    filename: str
    extension: str | None
    remote_md5: str | None
    mime_type: str
    size_bytes: int | None
    modified_at: datetime | None
    status: MemoryFileStatus
    remote_state: RemoteFileState
    thumbnail_state: RemoteThumbnailState
    stream_state: RemoteStreamState
    last_synced_at: datetime | None
    sync_error: str | None


class MemoryCardFileRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    source: str
    remote_id: str | None
    remote_path: str
    filename: str
    status: MemoryFileStatus
    remote_state: RemoteFileState
    thumbnail_state: RemoteThumbnailState
    stream_state: RemoteStreamState


class MemorySummaryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    description: str
    kind: MemoryKind
    status: MemoryStatus
    captured_at: datetime | None
    location: str | None
    thumbnail_path: str | None
    duration_seconds: int | None
    width: int | None
    height: int | None
    primary_file: MemoryCardFileRead | None = None
    created_at: datetime
    updated_at: datetime

    @computed_field
    @property
    def file_url(self) -> str:
        return f"/api/v1/memories/{self.id}/file"

    @computed_field
    @property
    def thumbnail_url(self) -> str | None:
        if not self.thumbnail_path:
            if self.primary_file and self.primary_file.thumbnail_state.value == "ready":
                return f"/api/v1/memories/{self.id}/thumbnail"
            return None

        return f"/api/v1/memories/{self.id}/thumbnail"


class MemoryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    description: str
    kind: MemoryKind
    status: MemoryStatus
    captured_at: datetime | None
    location: str | None
    thumbnail_path: str | None
    duration_seconds: int | None
    width: int | None
    height: int | None
    primary_file: MemoryFileRead | None = None
    created_at: datetime
    updated_at: datetime

    @computed_field
    @property
    def file_url(self) -> str:
        return f"/api/v1/memories/{self.id}/file"

    @computed_field
    @property
    def thumbnail_url(self) -> str | None:
        if not self.thumbnail_path:
            if self.primary_file and self.primary_file.thumbnail_state.value == "ready":
                return f"/api/v1/memories/{self.id}/thumbnail"
            return None

        return f"/api/v1/memories/{self.id}/thumbnail"

class MemoryUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    kind: MemoryKind | None = None
    status: MemoryStatus | None = None
    captured_at: datetime | None = None
    location: str | None = None
    thumbnail_path: str | None = None


def to_memory_read(memory: Memory) -> MemoryRead:
    payload = MemoryRead.model_validate(memory)
    payload.primary_file = (
        MemoryFileRead.model_validate(memory.files[0]) if memory.files else None
    )
    return payload


def to_memory_summary(memory: Memory) -> MemorySummaryRead:
    payload = MemorySummaryRead.model_validate(memory)
    payload.primary_file = (
        MemoryCardFileRead.model_validate(memory.files[0]) if memory.files else None
    )
    return payload
