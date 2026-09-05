import uuid
from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field


from app.models.memory import MemoryStatus, RemoteScanStatus
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
    max_depth: int = Field(default=8, ge=0, le=32)
    max_items: int = Field(default=5000, ge=1, le=50000)
    resume_task_id: uuid.UUID | None = None


class AdminLoginRequest(BaseModel):
    token: str = Field(min_length=1, max_length=256)


class RemoteScanTaskRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    remote_dir: str
    status: RemoteScanStatus
    max_depth: int
    max_items: int
    processed_items: int
    scanned_files: int
    scanned_directories: int
    discovered: int
    refreshed: int
    skipped: int
    limit_reached: bool = False
    failure_reason: str | None
    started_at: datetime
    completed_at: datetime | None


class AdminSyncResponse(BaseModel):
    discovered: int
    matched: int
    failed: int
    scan_task: RemoteScanTaskRead


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
