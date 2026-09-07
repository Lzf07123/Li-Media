from datetime import datetime
import uuid
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal


from app.models.memory import MemoryKind, MemoryStatus, RemoteScanStatus
from app.schemas.memory import MemoryRead, MemorySummaryRead


class MemoryCounts(BaseModel):
    photo: int
    video: int


class DisplayHealthCounts(BaseModel):
    displayable: int
    excluded: int


class BrowserCompatibilityCounts(BaseModel):
    supported: int
    unsupported: int
    unknown: int


class MemoryStatusCounts(BaseModel):
    published: int
    unpublished: int


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


class PublicMediaCounts(BaseModel):
    total: int
    photo: int
    video: int


class MemoryDirectLinkResponse(BaseModel):
    direct_url: str
    expires_at: datetime | None
    mime_type: str
    size_bytes: int | None


class AdminMemoryListResponse(BaseModel):
    items: list[MemoryRead]
    total: int
    display_counts: DisplayHealthCounts
    filtered_display_counts: DisplayHealthCounts
    global_counts: MemoryCounts
    status_counts: MemoryStatusCounts
    filtered_status_counts: MemoryStatusCounts
    browser_counts: BrowserCompatibilityCounts
    filtered_browser_counts: BrowserCompatibilityCounts
    page: int
    page_size: int
    counts: MemoryCounts


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


class AdminMemoryBatchPreviewRequest(BaseModel):
    kind: MemoryKind | None = None
    keyword: str | None = Field(default=None, max_length=100)
    display: Literal["all", "displayable", "excluded"] = "all"
    compatibility: Literal["all", "supported", "unsupported", "unknown"] = "all"
    status: MemoryStatus | None = None


class AdminMemoryBatchPreviewResponse(BaseModel):
    filter_snapshot: dict[str, object]
    total: int
    counts: MemoryCounts
    status_counts: MemoryStatusCounts
    display_counts: DisplayHealthCounts
    browser_counts: BrowserCompatibilityCounts
    is_full_library: bool


class AdminMemoryBatchStatusRequest(AdminMemoryBatchPreviewRequest):
    target_status: MemoryStatus
    confirm: bool = False


class AdminBrowserCompatibilityProbeRequest(BaseModel):
    limit: int = Field(default=25, ge=1, le=100)


class AdminBackgroundJobRead(BaseModel):
    id: uuid.UUID
    action: str
    status: Literal["queued", "running", "completed", "cancelled", "failed"]
    filter_snapshot: dict[str, object]
    total: int
    processed: int
    changed: int
    skipped: int
    failed: int
    error_message: str | None
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None


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


class ServiceStatus(BaseModel):
    status: Literal["ok", "unavailable"]
    detail: str | None = None
    pool_status: str | None = None
    dialect: str | None = None
    used_memory_bytes: int | None = None
    max_memory_bytes: int | None = None
    connected_clients: int | None = None


class BackendRuntimeStatus(BaseModel):
    app_name: str
    version: str
    python_version: str
    platform: str
    pid: int
    database: ServiceStatus
    redis: ServiceStatus
    task_thread_pool_size: int
    stack_guard: str


class RemoteStorageCounts(BaseModel):
    total: int
    remote_ready: int
    remote_missing: int
    remote_failed: int
    thumbnail_ready: int
    thumbnail_missing: int
    thumbnail_failed: int
    thumbnail_failure_kinds: dict[str, int]
    stream_ready: int
    stream_failed: int


class RemoteStorageStatus(BaseModel):
    provider: str
    configured: bool
    oauth_configured: bool
    authorized: bool
    scan_dir: str
    token_expires_at: datetime | None
    direct_link_cache_entries: int
    counts: RemoteStorageCounts
    last_scan: RemoteScanTaskRead | None


class SourceZeroStatus(BaseModel):
    compliant: bool
    source_path_count: int
    source_path_schema_exposed: bool
    database_blob_count: int
    source_media_file_count: int
    source_media_extensions: dict[str, int]
    media_photos_file_count: int
    media_videos_file_count: int
    unexpected_media_file_count: int
    temporary_file_count: int
    filesystem_scan_failed: bool


class TaskQueueStatus(BaseModel):
    active: int
    queued: int
    limit: int
    queue_limit: int


class ResourceStackStatus(BaseModel):
    soft_kbytes: int | None
    hard_kbytes: int | None


class ResourceLimitStatus(BaseModel):
    backend_memory_bytes: int | None
    temp_disk_quota_bytes: int | None
    temp_max_files: int | None


class ResourceStatus(BaseModel):
    process: dict[str, int | None]
    cgroup: dict[str, int | None]
    temporary: dict[str, float | int | None]
    stack: ResourceStackStatus
    limits: ResourceLimitStatus


class AdminSystemStatusResponse(BaseModel):
    generated_at: datetime
    backend: BackendRuntimeStatus
    remote_storage: RemoteStorageStatus
    source_zero: SourceZeroStatus
    tasks: dict[str, TaskQueueStatus]
    metrics: dict[str, int]
    resources: ResourceStatus


class ThumbnailPreheatRequest(BaseModel):
    max_size: Literal["240", "480", "768", "1280"] = "480"
    kind: MemoryKind | None = None
    limit: int = Field(default=24, ge=1, le=200)


class ThumbnailPreheatJobRead(BaseModel):
    id: uuid.UUID
    max_size: int
    kind: MemoryKind | None
    limit: int
    status: Literal["queued", "running", "completed", "cancelled", "failed"]
    total: int
    processed: int
    generated: int
    cached: int
    failed: int
    message: str | None
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
