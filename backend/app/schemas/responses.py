import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.models.memory import MemoryStatus
from app.schemas.memory import MemoryRead


class MemoryListResponse(BaseModel):
    items: list[MemoryRead]
    total: int
    page: int
    page_size: int


class AdminMemoryListResponse(BaseModel):
    items: list[MemoryRead]
    total: int


class AdminSyncRequest(BaseModel):
    max_files: int = Field(default=5, ge=1, le=20)


class AdminLoginRequest(BaseModel):
    token: str = Field(min_length=1, max_length=256)


class AdminSyncResponse(BaseModel):
    discovered: int
    matched: int
    failed: int


class AdminMemoryBatchUpdateRequest(BaseModel):
    ids: list[uuid.UUID] = Field(min_length=1, max_length=100)
    title: str | None = Field(default=None, max_length=255)
    description: str | None = None
    location: str | None = Field(default=None, max_length=255)
    captured_at: datetime | None = None
    status: MemoryStatus | None = None


class AdminMemoryBatchUpdateResponse(BaseModel):
    updated: int


class AdminMemoryExportRequest(BaseModel):
    ids: list[uuid.UUID] = Field(min_length=1, max_length=100)


class AdminMemoryExportResponse(BaseModel):
    exported_at: datetime
    items: list[MemoryRead]
    total: int
