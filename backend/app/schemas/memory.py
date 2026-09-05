import uuid
from datetime import datetime
from pydantic import BaseModel, ConfigDict, computed_field

from app.models.memory import Memory, MemoryFileStatus, MemoryKind, MemoryStatus


class MemoryFileRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    source: str
    remote_path: str
    mime_type: str
    size_bytes: int | None
    status: MemoryFileStatus


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
        if self.kind == MemoryKind.PHOTO:
            return self.file_url
        return None

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
