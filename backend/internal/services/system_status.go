// system_status.go 对齐原 app/services/system_status.py:
// /admin/system/status 的大聚合——后端运行时、远程存储、源审计、
// 预热健康度、任务队列与资源指标。
//
// 结构与键序逐字段对齐 schemas/responses.py 的 pydantic 模型;
// thumbnail_preheat.py 中与本聚合相关的三个计数函数与预热健康度
// 先落在本文件(thumbnail_preheat 的完整翻译属后续里程碑)。
package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	goredis "github.com/redis/go-redis/v9"

	"limedia/backend/internal/config"
	"limedia/backend/internal/models"
	"limedia/backend/internal/repo"
)

// ---- 契约结构(字段序 = pydantic 模型字段序) ----

// ServiceStatus 对齐 responses.ServiceStatus。
type ServiceStatus struct {
	Status           string  `json:"status"`
	Detail           *string `json:"detail"`
	PoolStatus       *string `json:"pool_status"`
	Dialect          *string `json:"dialect"`
	UsedMemoryBytes  *int64  `json:"used_memory_bytes"`
	MaxMemoryBytes   *int64  `json:"max_memory_bytes"`
	ConnectedClients *int64  `json:"connected_clients"`
}

// ResourceRuntimeConfiguration 对齐 responses.ResourceRuntimeConfiguration。
type ResourceRuntimeConfiguration struct {
	PreheatConcurrencyLimit   int     `json:"preheat_concurrency_limit"`
	PreheatQueueLimit         int     `json:"preheat_queue_limit"`
	PreheatWaitTimeoutSeconds float64 `json:"preheat_wait_timeout_seconds"`
	PreheatRetryCooldownSec   int     `json:"preheat_retry_cooldown_seconds"`
	SourceDownloadTimeoutSec  float64 `json:"source_download_timeout_seconds"`
	DerivativeConcurrencyLimit int    `json:"derivative_concurrency_limit"`
	DerivativeQueueLimit      int     `json:"derivative_queue_limit"`
	DerivativeWaitTimeoutSec  float64 `json:"derivative_wait_timeout_seconds"`
	DirectProbeConcurrencyLimit int   `json:"direct_probe_concurrency_limit"`
	DirectProbeQueueLimit     int     `json:"direct_probe_queue_limit"`
	ScanConcurrencyLimit      int     `json:"scan_concurrency_limit"`
	StreamGlobalConcurrencyLimit int  `json:"stream_global_concurrency_limit"`
	StreamUserConcurrencyLimit int    `json:"stream_user_concurrency_limit"`
	TempMaxFiles              int     `json:"temp_max_files"`
	TempDiskQuotaBytes        int64   `json:"temp_disk_quota_bytes"`
}

// PreheatHealthStatus 预热健康度(对齐 responses.PreheatHealthStatus):
// 从磁盘历史聚合,重启后仍可追溯;无失败样本时成功率为 1.0。
type PreheatHealthStatus struct {
	HistoryJobs      int        `json:"history_jobs"`
	LastStatus       *string    `json:"last_status"`
	LastCompletedAt  *time.Time `json:"last_completed_at"`
	RecentGenerated  int        `json:"recent_generated"`
	RecentCached     int        `json:"recent_cached"`
	RecentFailed     int        `json:"recent_failed"`
	RecentSuccessRate float64   `json:"recent_success_rate"`
}

// BackendRuntimeStatus 对齐 responses.BackendRuntimeStatus。
type BackendRuntimeStatus struct {
	AppName           string                       `json:"app_name"`
	Version           string                       `json:"version"`
	PythonVersion     string                       `json:"python_version"`
	Platform          string                       `json:"platform"`
	Pid               int                          `json:"pid"`
	Database          ServiceStatus                `json:"database"`
	Redis             ServiceStatus                `json:"redis"`
	TaskThreadPoolSize int                         `json:"task_thread_pool_size"`
	StackGuard        string                       `json:"stack_guard"`
	Configuration     ResourceRuntimeConfiguration `json:"configuration"`
}

// RemoteStorageCounts 对齐 responses.RemoteStorageCounts。
type RemoteStorageCounts struct {
	Total                int            `json:"total"`
	RemoteReady          int            `json:"remote_ready"`
	RemoteMissing        int            `json:"remote_missing"`
	RemoteFailed         int            `json:"remote_failed"`
	ThumbnailReady       int            `json:"thumbnail_ready"`
	ThumbnailMissing     int            `json:"thumbnail_missing"`
	ThumbnailRetryable   int            `json:"thumbnail_retryable"`
	ThumbnailFailed      int            `json:"thumbnail_failed"`
	ThumbnailFailureKinds map[string]int `json:"thumbnail_failure_kinds"`
	StreamReady          int            `json:"stream_ready"`
	StreamFailed         int            `json:"stream_failed"`
	HomeDerivativeReady  int            `json:"home_derivative_ready"`
	DetailDerivativeReady int           `json:"detail_derivative_ready"`
	DetailDerivativeTotal int           `json:"detail_derivative_total"`
}

// RemoteScanTaskRead 对齐 responses.RemoteScanTaskRead(limit_reached
// 非 ORM 字段,from_attributes 序列化时恒为默认 False)。
type RemoteScanTaskRead struct {
	ID                uuid.UUID  `json:"id"`
	RemoteDir         string     `json:"remote_dir"`
	Status            string     `json:"status"`
	MaxDepth          int        `json:"max_depth"`
	MaxItems          int        `json:"max_items"`
	DeleteMissing     bool       `json:"delete_missing"`
	ProcessedItems    int        `json:"processed_items"`
	ScannedFiles      int        `json:"scanned_files"`
	ScannedDirectories int       `json:"scanned_directories"`
	Discovered        int        `json:"discovered"`
	Refreshed         int        `json:"refreshed"`
	Skipped           int        `json:"skipped"`
	LimitReached      bool       `json:"limit_reached"`
	FailureReason     *string    `json:"failure_reason"`
	StartedAt         time.Time  `json:"started_at"`
	CompletedAt       *time.Time `json:"completed_at"`
}

// RemoteStorageStatus 对齐 responses.RemoteStorageStatus。
type RemoteStorageStatus struct {
	Provider              string              `json:"provider"`
	Configured            bool                `json:"configured"`
	OauthConfigured       bool                `json:"oauth_configured"`
	Authorized            bool                `json:"authorized"`
	ScanDir               string              `json:"scan_dir"`
	TokenExpiresAt        *time.Time          `json:"token_expires_at"`
	DirectLinkCacheEntries int                `json:"direct_link_cache_entries"`
	Counts                *RemoteStorageCounts `json:"counts"`
	LastScan              *RemoteScanTaskRead `json:"last_scan"`
}

// TaskQueueStatus 对齐 responses.TaskQueueStatus。
type TaskQueueStatus struct {
	Active            int     `json:"active"`
	Queued            int     `json:"queued"`
	Limit             int     `json:"limit"`
	QueueLimit        int     `json:"queue_limit"`
	WaitTimeoutSeconds float64 `json:"wait_timeout_seconds"`
}

// AdminSystemStatusResponse 对齐 responses.AdminSystemStatusResponse。
type AdminSystemStatusResponse struct {
	GeneratedAt   time.Time            `json:"generated_at"`
	Backend       BackendRuntimeStatus `json:"backend"`
	RemoteStorage RemoteStorageStatus  `json:"remote_storage"`
	SourceZero    SourceZeroStatus     `json:"source_zero"`
	Preheat       PreheatHealthStatus  `json:"preheat"`
	Tasks         map[string]TaskQueueStatus `json:"tasks"`
	Metrics       map[string]int       `json:"metrics"`
	Resources     *ResourceStatus      `json:"resources"`
}

// ---- 子项聚合 ----

// GetDatabaseStatus 探活并报告方言与连接池状态
// (对齐 _database_status;失败文案取异常类名 → OperationalError)。
func GetDatabaseStatus(ctx context.Context, pool *pgxpool.Pool) ServiceStatus {
	if err := pool.Ping(ctx); err != nil {
		detail := "OperationalError"
		return ServiceStatus{Status: "unavailable", Detail: &detail}
	}
	stat := pool.Stat()
	poolStatus := fmt.Sprintf(
		"Pool size: %d  Connections in use: %d  Idle connections: %d  Constructing: %d",
		stat.TotalConns(), stat.AcquiredConns(), stat.IdleConns(), stat.ConstructingConns())
	dialect := "postgresql"
	return ServiceStatus{
		Status:     "ok",
		Dialect:    &dialect,
		PoolStatus: &poolStatus,
	}
}

// GetRedisStatus 对齐 get_redis_status:1s 连接 / 2s 读写超时,
// 报告版本、内存与客户端数;异常 detail 取异常类名。
func GetRedisStatus(redisURL string) ServiceStatus {
	opts, err := goredis.ParseURL(redisURL)
	if err != nil {
		detail := "ValueError"
		return ServiceStatus{Status: "unavailable", Detail: &detail}
	}
	opts.DialTimeout = 1 * time.Second
	opts.ReadTimeout = 2 * time.Second
	opts.WriteTimeout = 2 * time.Second

	client := goredis.NewClient(opts)
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		detail := "ConnectionError"
		return ServiceStatus{Status: "unavailable", Detail: &detail}
	}
	infoRaw, err := client.Info(ctx).Result()
	if err != nil {
		detail := "ConnectionError"
		return ServiceStatus{Status: "unavailable", Detail: &detail}
	}
	// INFO 原始文本按行解析为 key→value(redis 响应为 CRLF 分隔)。
	info := map[string]string{}
	for _, line := range strings.Split(strings.ReplaceAll(infoRaw, "\r\n", "\n"), "\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if key, value, found := strings.Cut(line, ":"); found {
			info[key] = value
		}
	}

	parseInfoInt := func(key string) *int64 {
		if raw, ok := info[key]; ok {
			var value int64
			if _, err := fmt.Sscanf(raw, "%d", &value); err == nil {
				return &value
			}
		}
		return nil
	}
	usedMemory := parseInfoInt("used_memory")
	if usedMemory == nil {
		zero := int64(0)
		usedMemory = &zero
	}
	maxMemory := parseInfoInt("maxmemory")
	var maxMemoryBytes *int64
	if maxMemory != nil && *maxMemory != 0 {
		maxMemoryBytes = maxMemory
	}
	connectedClients := parseInfoInt("connected_clients")
	if connectedClients == nil {
		zero := int64(0)
		connectedClients = &zero
	}
	version := info["redis_version"]

	return ServiceStatus{
		Status:           "ok",
		Detail:           &version,
		UsedMemoryBytes:  usedMemory,
		MaxMemoryBytes:   maxMemoryBytes,
		ConnectedClients: connectedClients,
	}
}

// ---- 远程存储计数 ----

const remoteStorageCountsSQL = `SELECT
	count(f.id),
	COALESCE(SUM(CASE WHEN f.remote_state = $1 THEN 1 ELSE 0 END), 0),
	COALESCE(SUM(CASE WHEN f.remote_state = $2 THEN 1 ELSE 0 END), 0),
	COALESCE(SUM(CASE WHEN f.remote_state = $3 THEN 1 ELSE 0 END), 0),
	COALESCE(SUM(CASE WHEN f.thumbnail_state = $4 THEN 1 ELSE 0 END), 0),
	COALESCE(SUM(CASE WHEN f.thumbnail_state = $5 THEN 1 ELSE 0 END), 0),
	COALESCE(SUM(CASE WHEN f.thumbnail_state = $6 THEN 1 ELSE 0 END), 0),
	COALESCE(SUM(CASE WHEN f.thumbnail_state = $7 THEN 1 ELSE 0 END), 0),
	COALESCE(SUM(CASE WHEN f.stream_state = $8 THEN 1 ELSE 0 END), 0),
	COALESCE(SUM(CASE WHEN f.stream_state = $9 THEN 1 ELSE 0 END), 0)
	FROM memory_files f
	WHERE f.source = $10`

// RemoteStorageAggregatedCounts 对齐 _remote_storage_counts 的计数部分。
func RemoteStorageAggregatedCounts(ctx context.Context, pool *pgxpool.Pool, derivativeVersion string) (*RemoteStorageCounts, error) {
	counts := &RemoteStorageCounts{ThumbnailFailureKinds: map[string]int{}}

	var total, remoteReady, remoteMissing, remoteFailed,
		thumbnailReady, thumbnailMissing, thumbnailFailed, thumbnailRetryable,
		streamReady, streamFailed int64
	if err := pool.QueryRow(ctx, remoteStorageCountsSQL,
		models.RemoteFileStateReady, models.RemoteFileStateMissing, models.RemoteFileStateFailed,
		models.RemoteThumbnailStateReady, models.RemoteThumbnailStateMissing,
		models.RemoteThumbnailStateFailed, models.RemoteThumbnailStateRetryable,
		models.RemoteStreamStateReady, models.RemoteStreamStateFailed,
		"baidupan",
	).Scan(&total, &remoteReady, &remoteMissing, &remoteFailed,
		&thumbnailReady, &thumbnailMissing, &thumbnailFailed, &thumbnailRetryable,
		&streamReady, &streamFailed); err != nil {
		return nil, fmt.Errorf("远程存储计数失败: %w", err)
	}
	counts.Total = int(total)
	counts.RemoteReady = int(remoteReady)
	counts.RemoteMissing = int(remoteMissing)
	counts.RemoteFailed = int(remoteFailed)
	counts.ThumbnailReady = int(thumbnailReady)
	counts.ThumbnailMissing = int(thumbnailMissing)
	counts.ThumbnailFailed = int(thumbnailFailed)
	counts.ThumbnailRetryable = int(thumbnailRetryable)
	counts.StreamReady = int(streamReady)
	counts.StreamFailed = int(streamFailed)

	// 失败种类分布(NULL 计为 unclassified)。
	rows, err := pool.Query(ctx,
		`SELECT f.thumbnail_failure_kind, count(*)
		 FROM memory_files f
		 WHERE f.source = $1
		   AND f.thumbnail_state IN ($2, $3)
		 GROUP BY f.thumbnail_failure_kind`,
		"baidupan", models.RemoteThumbnailStateFailed, models.RemoteThumbnailStateRetryable)
	if err != nil {
		return nil, fmt.Errorf("缩略图失败种类统计失败: %w", err)
	}
	for rows.Next() {
		var kind *string
		var count int64
		if err := rows.Scan(&kind, &count); err != nil {
			rows.Close()
			return nil, fmt.Errorf("遍历失败种类失败: %w", err)
		}
		key := "unclassified"
		if kind != nil {
			key = *kind
		}
		counts.ThumbnailFailureKinds[key] = int(count)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("遍历失败种类失败: %w", err)
	}
	rows.Close()

	counts.HomeDerivativeReady = CountPublicDerivativeCacheHits(ctx, pool, repo.HomePreheatSize, derivativeVersion)
	counts.DetailDerivativeTotal = CountPublicDerivativeCandidates(ctx, pool, derivativeVersion)
	counts.DetailDerivativeReady = CountPublicDetailDerivativeCacheHits(ctx, pool, derivativeVersion)
	return counts, nil
}

// ---- 公开口径计数(对齐 thumbnail_preheat.count_public_*) ----

// publicCountBase 公开口径的基础查询:公开状态 + baidupan 源 +
// remote_id 存在 + public_files_condition,返回 SQL 片段与参数。
func publicCountBase(b *repo.SQLCond) string {
	return "m.status = " + b.Placeholder(models.MemoryStatusPublished) +
		" AND f.source = " + b.Placeholder("baidupan") +
		" AND f.remote_id IS NOT NULL" +
		" AND " + b.PublicFilesCondition()
}

func countDistinctMemories(ctx context.Context, pool *pgxpool.Pool, sql string, args []any) (int, error) {
	count := 0
	if err := pool.QueryRow(ctx, sql, args...).Scan(&count); err != nil {
		return 0, fmt.Errorf("公开派生计数失败: %w", err)
	}
	return count, nil
}

// CountPublicDerivativeCandidates 对齐 count_public_derivative_candidates。
func CountPublicDerivativeCandidates(ctx context.Context, pool *pgxpool.Pool, derivativeVersion string) int {
	b := repo.NewSQLCond()
	sql := "SELECT count(DISTINCT m.id) FROM memory_files f" +
		" JOIN memories m ON f.memory_id = m.id" +
		" WHERE " + publicCountBase(b)
	count, err := countDistinctMemories(ctx, pool, sql, b.Args())
	if err != nil {
		return 0
	}
	return count
}

// CountPublicDerivativeCacheHits 对齐 count_public_derivative_cache_hits:
// 有持久化派生图的公开文件,与任务历史无关。
func CountPublicDerivativeCacheHits(ctx context.Context, pool *pgxpool.Pool, maxSize int, derivativeVersion string) int {
	b := repo.NewSQLCond()
	sql := "SELECT count(DISTINCT m.id) FROM memory_files f" +
		" JOIN memories m ON f.memory_id = m.id" +
		" WHERE " + publicCountBase(b) +
		" AND " + b.HomeDerivativeReadyCondition(derivativeVersion, maxSize)
	count, err := countDistinctMemories(ctx, pool, sql, b.Args())
	if err != nil {
		return 0
	}
	return count
}

// DetailPreheatSizes 详情页派生尺寸(对齐 DETAIL_PREHEAT_SIZES)。
var DetailPreheatSizes = []int{480, 768, 1280}

// CountPublicDetailDerivativeCacheHits 对齐 count_public_detail_derivative_cache_hits:
// 至少一个详情尺寸派生图就绪的公开文件。
func CountPublicDetailDerivativeCacheHits(ctx context.Context, pool *pgxpool.Pool, derivativeVersion string) int {
	b := repo.NewSQLCond()
	base := publicCountBase(b)
	args := b.Args()
	sizePlaceholder := b.Placeholder(DetailPreheatSizes)
	versionPlaceholder := b.Placeholder(derivativeVersion)
	sql := "SELECT count(DISTINCT m.id) FROM memory_files f" +
		" JOIN memories m ON f.memory_id = m.id" +
		" LEFT JOIN memory_derivative_caches d ON d.memory_file_id = f.id" +
		" AND d.max_size = " + sizePlaceholder +
		" AND d.derivative_version = " + versionPlaceholder +
		" AND d.status = " + b.Placeholder(models.DerivativeCacheStatusReady) +
		" WHERE " + base +
		" AND d.id IS NOT NULL"
	count, err := countDistinctMemories(ctx, pool, sql, args)
	if err != nil {
		return 0
	}
	return count
}

// ---- 远程存储状态 ----

// RemoteStorageAggregatedStatus 对齐 _remote_storage_status。
func RemoteStorageAggregatedStatus(ctx context.Context, pool *pgxpool.Pool, settings *config.Settings) (*RemoteStorageStatus, error) {
	credentials := LoadBaiduCredentials(settings)

	counts, err := RemoteStorageAggregatedCounts(ctx, pool, settings.MediaDerivativeVersion)
	if err != nil {
		return nil, err
	}

	lastScan := FetchLastScanTask(ctx, pool)

	status := &RemoteStorageStatus{
		Provider:              "baidupan",
		Configured:            credentials != nil || settings.BaiduAccessToken != "",
		OauthConfigured:       settings.BaiduOAuthClientID != "" && settings.BaiduOAuthClientSecret != "",
		Authorized:            credentials != nil,
		ScanDir:               settings.BaiduSyncDir,
		TokenExpiresAt:        nil,
		DirectLinkCacheEntries: DownloadURLCache.Size(),
		Counts:                counts,
		LastScan:              lastScan,
	}
	if credentials != nil {
		status.TokenExpiresAt = credentials.ExpiresAt
	}
	return status, nil
}

// FetchLastScanTask 最近一次扫描任务(对齐 order_by(started_at.desc()) 首行)。
func FetchLastScanTask(ctx context.Context, pool *pgxpool.Pool) *RemoteScanTaskRead {
	row := pool.QueryRow(ctx,
		`SELECT id, remote_dir, status, max_depth, max_items, delete_missing,
		 processed_items, scanned_files, scanned_directories, discovered,
		 refreshed, skipped, failure_reason, started_at, completed_at
		 FROM remote_scan_tasks ORDER BY started_at DESC LIMIT 1`)
	task := &RemoteScanTaskRead{}
	err := row.Scan(
		&task.ID, &task.RemoteDir, &task.Status, &task.MaxDepth, &task.MaxItems,
		&task.DeleteMissing, &task.ProcessedItems, &task.ScannedFiles,
		&task.ScannedDirectories, &task.Discovered, &task.Refreshed, &task.Skipped,
		&task.FailureReason, &task.StartedAt, &task.CompletedAt,
	)
	if err != nil {
		return nil
	}
	return task
}

// ---- 预热健康度(thumbnail_preheat.collect_preheat_health 先行落地) ----

// PreheatHistoryFilename 预热历史文件名(对齐 PREHEAT_HISTORY_FILENAME)。
const PreheatHistoryFilename = "preheat-history.json"

// CollectPreheatHealth 从磁盘历史聚合预热健康度;无历史或损坏时给
// 中性默认值(成功率 1.0、零计数),不阻塞状态接口。
// 口径为「派生图交付」:(生成+缓存命中)/(总尝试)。
func CollectPreheatHealth(settings *config.Settings) PreheatHealthStatus {
	status := PreheatHealthStatus{RecentSuccessRate: 1.0}

	historyPath := filepath.Join(settings.MediaRoot, PreheatHistoryFilename)
	data, err := os.ReadFile(historyPath)
	if err == nil {
		var history []map[string]any
		if err := json.Unmarshal(data, &history); err == nil {
			status.HistoryJobs = len(history)
			for _, entry := range history {
				status.RecentGenerated += snapshotNonNegative(entry, "generated")
				status.RecentCached += snapshotNonNegative(entry, "cached")
				status.RecentFailed += snapshotNonNegative(entry, "failed")
			}
			for i := len(history) - 1; i >= 0; i-- {
				raw, _ := history[i]["status"].(string)
				if raw == "completed" || raw == "cancelled" || raw == "failed" {
					last := raw
					status.LastStatus = &last
					status.LastCompletedAt = parseSnapshotDatetime(history[i]["completed_at"])
					break
				}
			}
		}
	}

	delivered := status.RecentGenerated + status.RecentCached
	attempts := delivered + status.RecentFailed
	if attempts > 0 {
		status.RecentSuccessRate = float64(delivered) / float64(attempts)
	}
	return status
}

func snapshotNonNegative(entry map[string]any, key string) int {
	raw, ok := entry[key]
	if !ok || raw == nil {
		return 0
	}
	var value float64
	switch v := raw.(type) {
	case float64:
		value = v
	case string:
		if _, err := fmt.Sscanf(v, "%f", &value); err != nil {
			return 0
		}
	case json.Number:
		if f, err := v.Float64(); err == nil {
			value = f
		} else {
			return 0
		}
	default:
		return 0
	}
	if value < 0 {
		value = 0
	}
	return int(value)
}

// parseSnapshotDatetime 对齐 _parse_snapshot_datetime:ISO8601 字符串。
func parseSnapshotDatetime(value any) *time.Time {
	text, ok := value.(string)
	if !ok || text == "" {
		return nil
	}
	for _, layout := range [...]string{
		time.RFC3339Nano,
		"2006-01-02T15:04:05.999999999",
		"2006-01-02T15:04:05",
	} {
		if parsed, err := time.Parse(layout, text); err == nil {
			return &parsed
		}
	}
	return nil
}

// ---- 大聚合 ----

// SystemStatusDeps 大聚合依赖注入。
type SystemStatusDeps struct {
	Pool     *pgxpool.Pool
	Settings *config.Settings
	Governor *TaskGovernor
}

// CollectSystemStatus 组装 /admin/system/status 响应
// (对齐 collect_system_status;redis_status 允许外部预取)。
func CollectSystemStatus(
	ctx context.Context,
	deps *SystemStatusDeps,
	redisStatus *ServiceStatus,
) (*AdminSystemStatusResponse, error) {
	settings := deps.Settings

	// 任务队列快照与指标。
	tasks := make(map[string]TaskQueueStatus)
	for taskType, values := range deps.Governor.Stats() {
		tasks[taskType] = TaskQueueStatus{
			Active:             toInt(values["active"]),
			Queued:             toInt(values["queued"]),
			Limit:              toInt(values["limit"]),
			QueueLimit:         toInt(values["queue_limit"]),
			WaitTimeoutSeconds: toFloat(values["wait_timeout_seconds"]),
		}
	}
	metrics := make(map[string]int)
	for key, value := range deps.Governor.Metrics.Snapshot() {
		if n, ok := value.(int); ok {
			metrics[key] = n
		}
	}

	database := GetDatabaseStatus(ctx, deps.Pool)
	redis := redisStatus
	if redis == nil {
		status := GetRedisStatus(settings.RedisURL)
		redis = &status
	}

	remoteStorage, err := RemoteStorageAggregatedStatus(ctx, deps.Pool, settings)
	if err != nil {
		return nil, err
	}

	sourceZero := CollectSourceZeroStatus(ctx, deps.Pool, settings.MediaRoot)
	preheat := CollectPreheatHealth(settings)
	resources := CollectResourceMetrics(
		settings.MediaRoot,
		&settings.BackendMemoryLimitBytes,
		&settings.RemoteThumbnailDiskQuotaBytes,
		&settings.RemoteThumbnailMaxTempFiles,
		settings.NginxCacheRoot,
	)

	backend := BackendRuntimeStatus{
		AppName:           settings.ProjectName,
		Version:           settings.Version,
		PythonVersion:     runtime.Version(),
		Platform:          runtime.GOOS,
		Pid:               os.Getpid(),
		Database:          database,
		Redis:             *redis,
		TaskThreadPoolSize: settings.TaskThreadPoolSize,
		StackGuard:        "task thread pool + cgroup memory + pids limit",
		Configuration: ResourceRuntimeConfiguration{
			PreheatConcurrencyLimit:     settings.PreheatConcurrencyLimit,
			PreheatQueueLimit:           settings.PreheatQueueLimit,
			PreheatWaitTimeoutSeconds:   settings.PreheatWaitTimeoutSec,
			PreheatRetryCooldownSec:     settings.PreheatRetryCooldownSec,
			SourceDownloadTimeoutSec:    settings.SourceDownloadTimeoutSec,
			DerivativeConcurrencyLimit:  settings.DerivativeConcurrencyLimit,
			DerivativeQueueLimit:        settings.DerivativeQueueLimit,
			DerivativeWaitTimeoutSec:    settings.DerivativeWaitTimeoutSec,
			DirectProbeConcurrencyLimit: settings.DirectProbeConcurrencyLimit,
			DirectProbeQueueLimit:       settings.DirectProbeQueueLimit,
			ScanConcurrencyLimit:        settings.ScanConcurrencyLimit,
			StreamGlobalConcurrencyLimit: settings.StreamGlobalConcurrencyLimit,
			StreamUserConcurrencyLimit:  settings.StreamUserConcurrencyLimit,
			TempMaxFiles:                settings.RemoteThumbnailMaxTempFiles,
			TempDiskQuotaBytes:          settings.RemoteThumbnailDiskQuotaBytes,
		},
	}

	return &AdminSystemStatusResponse{
		GeneratedAt:   time.Now().UTC(),
		Backend:       backend,
		RemoteStorage: *remoteStorage,
		SourceZero:    *sourceZero,
		Preheat:       preheat,
		Tasks:         tasks,
		Metrics:       metrics,
		Resources:     resources,
	}, nil
}

func toInt(value any) int {
	if n, ok := value.(int); ok {
		return n
	}
	return 0
}

func toFloat(value any) float64 {
	if f, ok := value.(float64); ok {
		return f
	}
	return 0
}
