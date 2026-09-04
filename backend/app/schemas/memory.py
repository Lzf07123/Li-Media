import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.models.memory import MemoryKind, MemoryStatus


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
    created_at: datetime
    updated_at: datetime
