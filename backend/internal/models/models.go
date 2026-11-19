// Package models 定义 7 张业务表的 Go struct,逐列对应
// app/models/memory.py 与 app/models/admin.py。
package models

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// ---- 枚举(取值与 StrEnum 逐字一致,是 JSON 契约的一部分) ----

type MemoryKind string

const (
	MemoryKindPhoto MemoryKind = "photo"
	MemoryKindVideo MemoryKind = "video"
)

type MemoryStatus string

const (
	MemoryStatusPending   MemoryStatus = "pending"
	MemoryStatusDraft     MemoryStatus = "draft"
	MemoryStatusPublished MemoryStatus = "published"
	MemoryStatusHidden    MemoryStatus = "hidden"
	MemoryStatusError     MemoryStatus = "error"
)

type MemoryFileStatus string

const (
	MemoryFileStatusDiscovered MemoryFileStatus = "discovered"
	MemoryFileStatusPending    MemoryFileStatus = "pending"
	MemoryFileStatusSyncing    MemoryFileStatus = "syncing"
	MemoryFileStatusMatched    MemoryFileStatus = "matched"
	MemoryFileStatusMissing    MemoryFileStatus = "missing"
	MemoryFileStatusRemoved    MemoryFileStatus = "removed"
	MemoryFileStatusFailed     MemoryFileStatus = "failed"
)

type RemoteFileState string

const (
	RemoteFileStateUnverified RemoteFileState = "unverified"
	RemoteFileStateReady      RemoteFileState = "ready"
	RemoteFileStateMissing    RemoteFileState = "missing"
	RemoteFileStateFailed     RemoteFileState = "failed"
)

type RemoteThumbnailState string

const (
	RemoteThumbnailStateMissing   RemoteThumbnailState = "missing"
	RemoteThumbnailStateReady     RemoteThumbnailState = "ready"
	RemoteThumbnailStateFailed    RemoteThumbnailState = "failed"
	RemoteThumbnailStateRetryable RemoteThumbnailState = "retryable"
)

type DerivativeCacheStatus string

const (
	DerivativeCacheStatusReady  DerivativeCacheStatus = "ready"
	DerivativeCacheStatusFailed DerivativeCacheStatus = "failed"
)

type RemoteStreamState string

const (
	RemoteStreamStateUnavailable RemoteStreamState = "unavailable"
	RemoteStreamStateReady       RemoteStreamState = "ready"
	RemoteStreamStateFailed      RemoteStreamState = "failed"
)

type BrowserCompatibilityState string

const (
	BrowserCompatibilityStateSupported   BrowserCompatibilityState = "supported"
	BrowserCompatibilityStateUnsupported BrowserCompatibilityState = "unsupported"
	BrowserCompatibilityStateUnknown     BrowserCompatibilityState = "unknown"
)

type DerivativeFailureKind string

const (
	DerivativeFailureUnknown          DerivativeFailureKind = "unknown"
	DerivativeFailureDiskQuota        DerivativeFailureKind = "disk_quota"
	DerivativeFailureRemoteAuth       DerivativeFailureKind = "remote_auth"
	DerivativeFailureRemoteForbidden  DerivativeFailureKind = "remote_forbidden"
	DerivativeFailureRemoteNotFound   DerivativeFailureKind = "remote_not_found"
	DerivativeFailureBaiduRateLimited DerivativeFailureKind = "baidu_rate_limited"
	DerivativeFailureRemoteUnavail    DerivativeFailureKind = "remote_unavailable"
	DerivativeFailureCancelled        DerivativeFailureKind = "cancelled"
	DerivativeFailureSourceTruncated  DerivativeFailureKind = "source_truncated"
	DerivativeFailureTemporaryEmpty   DerivativeFailureKind = "temporary_empty"
	DerivativeFailureTimeout          DerivativeFailureKind = "timeout"
	DerivativeFailureFormatUnsupport  DerivativeFailureKind = "format_unsupported"
	DerivativeFailureMovMoov          DerivativeFailureKind = "mov_moov"
	DerivativeFailureCodecUnsupport   DerivativeFailureKind = "codec_unsupported"
	DerivativeFailureTemporaryIO      DerivativeFailureKind = "temporary_io"
	DerivativeFailureQueueRejected    DerivativeFailureKind = "queue_rejected"
)

type RemoteScanStatus string

const (
	RemoteScanStatusRunning   RemoteScanStatus = "running"
	RemoteScanStatusCompleted RemoteScanStatus = "completed"
	RemoteScanStatusFailed    RemoteScanStatus = "failed"
)

// ---- memories ----

type Memory struct {
	ID              uuid.UUID
	Title           string
	Description     string
	Kind            MemoryKind
	Status          MemoryStatus
	CapturedAt      *time.Time
	Location        *string
	ThumbnailPath   *string
	DurationSeconds *int
	Width           *int
	Height          *int
	CreatedAt       time.Time
	UpdatedAt       time.Time

	Files []MemoryFile // selectinload 等价:按 memory_id 二次查询组装,按文件 id 升序
}

// MemoryFilesColumns 与 scanMemoryFile 配对使用,列序即扫描序。
const MemoryFilesColumns = `id, memory_id, source, remote_path, remote_id, source_path,
mime_type, size_bytes, remote_md5, parent_path, filename, extension, modified_at,
remote_state, thumbnail_state, thumbnail_failure_kind, stream_state,
browser_compatibility, browser_compatibility_version, browser_format_summary,
browser_compatibility_error, browser_compatibility_checked_at,
raw_metadata_summary, last_scan_task_id, content_hash, status,
last_synced_at, sync_error, created_at, updated_at`

type MemoryFile struct {
	ID                          uuid.UUID
	MemoryID                    *uuid.UUID // ON DELETE SET NULL 场景允许为空
	Source                      string
	RemotePath                  string
	RemoteID                    *string
	SourcePath                  string
	MimeType                    string
	SizeBytes                   *int64
	RemoteMD5                   *string
	ParentPath                  string
	Filename                    string
	Extension                   *string
	ModifiedAt                  *time.Time
	RemoteState                 RemoteFileState
	ThumbnailState              RemoteThumbnailState
	ThumbnailFailureKind        *string
	StreamState                 RemoteStreamState
	BrowserCompatibility        BrowserCompatibilityState
	BrowserCompatibilityVersion string
	BrowserFormatSummary        json.RawMessage
	BrowserCompatibilityError   *string
	BrowserCompatibilityCheckedAt *time.Time
	RawMetadataSummary          json.RawMessage
	LastScanTaskID              *uuid.UUID
	ContentHash                 *string
	Status                      MemoryFileStatus
	LastSyncedAt                *time.Time
	SyncError                   *string
	CreatedAt                   time.Time
	UpdatedAt                   time.Time
}

// ---- memory_derivative_caches ----

type MemoryDerivativeCache struct {
	ID               uuid.UUID
	MemoryFileID     uuid.UUID
	MaxSize          int
	DerivativeVersion string
	Status           DerivativeCacheStatus
	FailureKind      *string
	OutputPath       *string
	OutputBytes      *int
	SourceBytes      *int
	DurationMS       *int
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// ---- remote_scan_tasks ----

type RemoteScanTask struct {
	ID                uuid.UUID
	RemoteDir         string
	Status            RemoteScanStatus
	Cursor            *string
	MaxDepth          int
	MaxItems          int
	DeleteMissing     bool
	ProcessedItems    int
	ScannedFiles      int
	ScannedDirectories int
	Discovered        int
	Refreshed         int
	Skipped           int
	FailureReason     *string
	StartedAt         time.Time
	CompletedAt       *time.Time
	CreatedAt         time.Time
	UpdatedAt         time.Time
}
