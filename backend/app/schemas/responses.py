import uuid
from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field


from app.models.memory import MemoryStatus, RemoteScanStatus
from app.schemas.memory import MemoryRead, MemorySummaryRead


class MemoryCounts(BaseModel):
    photo: int
    video: int


class MemoryListResponse(BaseModel):
    items: list[MemoryRead]
    total: int
    page: int
    page_size: int
    counts: MemoryCounts


class MemorySummaryListResponse(BaseModel):
    items: list[MemorySummaryRead]
    total: int
    page: int
    page_size: int
    counts: MemoryCounts


class MemoryDirectLinkResponse(BaseModel):
    direct_url: str
    expires_at: datetime | None
    mime_type: str
    size_bytes: int | None


class AdminMemoryListResponse(BaseModel):
    items: list[MemoryRead]
    total: int


class AdminSyncRequest(BaseModel):
    max_files: int = Field(default=5, ge=1, le=20)
    max_depth: int = Field(default=8, ge=0, le=32)
    max_items: int = Field(default=5000, ge=1, le=50000)
    delete_missing: bool = True
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
    delete_missing: bool
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
    deleted: int
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


class AdminRemoteConfigResponse(BaseModel):
    configured: bool
    oauth_configured: bool
    authorized: bool
    scan_dir: str
    redirect_uri: str
    docs_url: str
    token_expires_at: datetime | None


class AdminCleanupRequest(BaseModel):
    confirm: bool = False


class AdminCleanupStats(BaseModel):
    memories: int
    remote_file_indexes: int
    scan_tasks: int
    thumbnail_files: int
    nginx_cache_files: int
    estimated_bytes_to_free: int


class AdminCleanupResponse(BaseModel):
    dry_run: bool
    stats: AdminCleanupStats
    duration_seconds: float = 0
    completed_at: datetime | None = None
    file_cleanup_error: str | None = None


class AdminBaiduAuthorizeResponse(BaseModel):
    authorize_url: str
    expires_at: datetime


class AdminBaiduCallbackRequest(BaseModel):
    code: str = Field(min_length=1, max_length=2048)
    state: str = Field(min_length=1, max_length=1024)


class AdminBaiduCallbackResponse(BaseModel):
    authorized: bool
    expires_at: datetime | None
