// baidu_sync.go 对齐原 app/services/baidu_sync.py:递归扫描网盘目录、
// 游标续扫、md5 去重挂载与删除策略,RemoteScanTask 全程持久化。
//
// 实现差异(有意为之):Python 用 SQLAlchemy Session 隐式事务,Go 用
// *pgxpool.Pool + 显式 pgx.Tx;Python 每页一次 db.commit(),Go 对应
// 每页一个事务(任务计数 + cursor + 该页 upsert 同事务提交)。失败路径
// 回滚后按 Python 语义重读任务、置 FAILED 并提交。
package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path"
	"reflect"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"limedia/backend/internal/models"
)

// BaiduSyncError 对齐 baidu_sync.py 的 ValueError 文案(契约的一部分)。
type BaiduSyncError struct{ Msg string }

func (e *BaiduSyncError) Error() string { return e.Msg }

// dbtx pgxpool.Pool 与 pgx.Tx 的公共查询接口,便于事务内外复用助手。
type dbtx interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// ---- 持久化浏览器兼容性(对齐 browser_compatibility.py 的持久证据判定半边) ----

// BrowserCompatibilityVersion 对齐 BROWSER_COMPATIBILITY_VERSION。
const BrowserCompatibilityVersion = "v1"

var (
	browserSupportedContainers = map[string]bool{"mp4": true, "m4v": true}
	browserSupportedVideoCodecs = map[string]bool{"h264": true, "avc1": true}
	browserSupportedAudioCodecs = map[string]bool{"aac": true, "mp4a": true}
	browserUnsupportedContainers = map[string]bool{
		"avi": true, "flv": true, "matroska": true, "mkv": true, "mov": true,
		"mpegts": true, "ts": true, "webm": true, "wmv": true,
	}
	browserUnsupportedVideoCodecs = map[string]bool{
		"av1": true, "h265": true, "hevc": true, "hvc1": true,
		"mpeg2video": true, "mpeg4": true, "prores": true, "vp8": true, "vp9": true,
	}
)

// browserFirstText 取第一个非空字符串并小写(对齐 _first_text)。
func browserFirstText(source map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := source[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.ToLower(strings.TrimSpace(value))
		}
	}
	return ""
}

// classifyBrowserFormat 对齐 _classify_format 的判定顺序。
func classifyBrowserFormat(container, videoCodec, audioCodec string) models.BrowserCompatibilityState {
	if videoCodec != "" && browserUnsupportedVideoCodecs[videoCodec] {
		return models.BrowserCompatibilityStateUnsupported
	}
	if container != "" && browserUnsupportedContainers[container] {
		return models.BrowserCompatibilityStateUnsupported
	}
	if container == "" || videoCodec == "" {
		return models.BrowserCompatibilityStateUnknown
	}
	if !browserSupportedContainers[container] {
		return models.BrowserCompatibilityStateUnsupported
	}
	if !browserSupportedVideoCodecs[videoCodec] {
		return models.BrowserCompatibilityStateUnsupported
	}
	if audioCodec != "" && !browserSupportedAudioCodecs[audioCodec] {
		return models.BrowserCompatibilityStateUnsupported
	}
	return models.BrowserCompatibilityStateSupported
}

// evaluateMemoryFileCompatibility 只依据持久化证据分类;证据缺失保持 unknown。
func evaluateMemoryFileCompatibility(raw, persisted map[string]any, extension *string) (models.BrowserCompatibilityState, map[string]any) {
	if raw == nil {
		raw = map[string]any{}
	}
	if persisted == nil {
		persisted = map[string]any{}
	}
	container := browserFirstText(raw, "container", "format_name", "container_name")
	if container == "" {
		container = browserFirstText(persisted, "container", "format_name", "container_name")
	}
	if container == "" && extension != nil && *extension != "" {
		container = strings.ToLower(*extension)
	}
	videoCodec := browserFirstText(raw, "video_codec", "vcodec", "codec_name")
	if videoCodec == "" {
		videoCodec = browserFirstText(persisted, "video_codec", "vcodec", "codec_name")
	}
	audioCodec := browserFirstText(raw, "audio_codec", "acodec", "audio_codec_name")
	if audioCodec == "" {
		audioCodec = browserFirstText(persisted, "audio_codec", "acodec", "audio_codec_name")
	}
	videoProfile := browserFirstText(raw, "video_profile", "profile")
	if videoProfile == "" {
		videoProfile = browserFirstText(persisted, "video_profile", "profile")
	}

	summary := map[string]any{}
	for key, value := range map[string]string{
		"container":     container,
		"video_codec":   videoCodec,
		"audio_codec":   audioCodec,
		"video_profile": videoProfile,
	} {
		if value != "" {
			summary[key] = value
		}
	}
	return classifyBrowserFormat(container, videoCodec, audioCodec), summary
}

func jsonMap(raw json.RawMessage) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	result := map[string]any{}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil
	}
	return result
}

// applyPersistedCompatibility 对齐 apply_persisted_compatibility:
// 直接改写内存对象的兼容性字段,持久化由调用方同一事务完成。
func applyPersistedCompatibility(f *models.MemoryFile) {
	state, summary := evaluateMemoryFileCompatibility(
		jsonMap(f.RawMetadataSummary), jsonMap(f.BrowserFormatSummary), f.Extension)
	f.BrowserCompatibility = state
	f.BrowserCompatibilityVersion = BrowserCompatibilityVersion
	summaryJSON, err := json.Marshal(summary)
	if err != nil {
		summaryJSON = []byte("{}")
	}
	f.BrowserFormatSummary = summaryJSON
	f.BrowserCompatibilityError = nil
	now := time.Now().UTC()
	f.BrowserCompatibilityCheckedAt = &now
}

// ---- memory_files.py 的文件名判定助手 ----

var photoExtensions = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".webp": true,
	".avif": true, ".gif": true, ".heic": true, ".heif": true,
}

var videoExtensions = map[string]bool{
	".mp4": true, ".m4v": true, ".mov": true, ".webm": true, ".mkv": true, ".avi": true,
}

// posixSuffix 对齐 PurePosixPath.suffix(点开头的隐藏文件无后缀)。
func posixSuffix(filename string) string {
	idx := strings.LastIndexByte(filename, '.')
	if idx <= 0 || idx == len(filename)-1 {
		return ""
	}
	return filename[idx:]
}

func posixStem(filename string) string {
	if suffix := posixSuffix(filename); suffix != "" {
		return strings.TrimSuffix(filename, suffix)
	}
	return filename
}

// InferMemoryKindOrNone 对齐 infer_memory_kind_or_none。
func InferMemoryKindOrNone(filename string, contentType *string) *models.MemoryKind {
	suffix := strings.ToLower(posixSuffix(filename))
	mediaType := ""
	if contentType != nil {
		mediaType = strings.ToLower(strings.TrimSpace(strings.SplitN(*contentType, ";", 2)[0]))
	}
	if strings.HasPrefix(mediaType, "image/") || photoExtensions[suffix] {
		kind := models.MemoryKindPhoto
		return &kind
	}
	if strings.HasPrefix(mediaType, "video/") || videoExtensions[suffix] {
		kind := models.MemoryKindVideo
		return &kind
	}
	return nil
}

// mimeByExtension 本地表对齐 mimetypes.guess_type 对媒体扩展名的常见结果。
var mimeByExtension = map[string]string{
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".png":  "image/png",
	".webp": "image/webp",
	".gif":  "image/gif",
	".avif": "image/avif",
	".heic": "image/heic",
	".heif": "image/heif",
	".mp4":  "video/mp4",
	".m4v":  "video/mp4",
	".mov":  "video/quicktime",
	".webm": "video/webm",
	".mkv":  "video/x-matroska",
	".avi":  "video/x-msvideo",
}

// GuessMimeType 对齐 guess_mime_type(此处调用点 content_type 恒为 None)。
func GuessMimeType(filename string, contentType *string) string {
	mediaType := ""
	if contentType != nil {
		mediaType = strings.TrimSpace(strings.SplitN(*contentType, ";", 2)[0])
	}
	guessed := mimeByExtension[strings.ToLower(posixSuffix(filename))]
	if mediaType == "application/octet-stream" && guessed != "" {
		return guessed
	}
	if mediaType != "" {
		return mediaType
	}
	if guessed != "" {
		return guessed
	}
	return "application/octet-stream"
}

// ---- 远端客户端协议(对齐 RemoteMediaClient Protocol) ----

// RemoteMediaClient 扫描所需的最小远端接口;*BaiduPanClient 满足。
type RemoteMediaClient interface {
	ListPage(ctx context.Context, remoteDir string, start int, limitOverride *int) (*BaiduListPage, error)
	GetFileMetadata(ctx context.Context, remoteID string) (*BaiduRemoteItem, error)
}

// ---- 扫描摘要 ----

// BaiduScanSummary 字段序对齐 Python dataclass(JSON 契约)。
type BaiduScanSummary struct {
	TaskID             uuid.UUID            `json:"task_id"`
	Status             models.RemoteScanStatus `json:"status"`
	ProcessedItems     int                  `json:"processed_items"`
	ScannedFiles       int                  `json:"scanned_files"`
	ScannedDirectories int                  `json:"scanned_directories"`
	Discovered         int                  `json:"discovered"`
	Refreshed          int                  `json:"refreshed"`
	Skipped            int                  `json:"skipped"`
	Deleted            int                  `json:"deleted"`
	LimitReached       bool                 `json:"limit_reached"`
	FailureReason      *string              `json:"failure_reason"`
	Cursor             *string              `json:"cursor"`
}

// ScanRemoteOptions 对齐 scan_remote_directory 的关键字参数。
type ScanRemoteOptions struct {
	RemoteDir    string
	MaxDepth     int
	MaxItems     int
	ResumeTaskID *uuid.UUID
	DeleteMissing bool
}

// ---- 游标 ----

// scanCursorEntry 游标栈元素;键序与 Python json.dumps 一致。
type scanCursorEntry struct {
	Path         string            `json:"path"`
	Start        int               `json:"start"`
	Depth        int               `json:"depth"`
	PendingDirs  []scanCursorEntry `json:"pending_dirs,omitempty"`
}

func marshalCursor(queue []scanCursorEntry) string {
	data, err := json.Marshal(queue)
	if err != nil {
		return ""
	}
	return string(data)
}

// decodeCursor 对齐 _decode_cursor:损坏游标回退初始目录,空列表保持空。
func decodeCursor(cursor *string, remoteDir string) []scanCursorEntry {
	if cursor == nil || *cursor == "" {
		return []scanCursorEntry{{Path: remoteDir, Start: 0, Depth: 0}}
	}
	var queue []scanCursorEntry
	if err := json.Unmarshal([]byte(*cursor), &queue); err != nil {
		return []scanCursorEntry{{Path: remoteDir, Start: 0, Depth: 0}}
	}
	if len(queue) == 0 {
		return []scanCursorEntry{}
	}
	return queue
}

// ---- 远程元数据推导 ----

var remoteDatetimePattern = regexp.MustCompile(
	`(?P<year>20\d{2})[-_. ]?(?P<month>\d{2})[-_. ]?(?P<day>\d{2})` +
		`(?:[T_ -]+(?P<hour>\d{2})[:.]?(?P<minute>\d{2})[:.]?(?P<second>\d{2})?)?`)

// parseRemoteDatetime 对齐 _parse_datetime:非法日期(Python datetime
// 构造抛 ValueError)返回 nil,借助构造回读校验而非规范化。
func parseRemoteDatetime(value string) *time.Time {
	if value == "" {
		return nil
	}
	match := remoteDatetimePattern.FindStringSubmatch(value)
	if match == nil {
		return nil
	}
	group := func(name string) int {
		idx := remoteDatetimePattern.SubexpIndex(name)
		if match[idx] == "" {
			return 0
		}
		number := 0
		for _, ch := range match[idx] {
			if ch < '0' || ch > '9' {
				return -1
			}
			number = number*10 + int(ch-'0')
		}
		return number
	}
	year, month, day := group("year"), group("month"), group("day")
	hour, minute, second := group("hour"), group("minute"), group("second")
	if month < 0 || day < 0 || hour < 0 || minute < 0 || second < 0 {
		return nil
	}
	parsed := time.Date(year, time.Month(month), day, hour, minute, second, 0, time.UTC)
	if parsed.Year() != year || int(parsed.Month()) != month || parsed.Day() != day ||
		parsed.Hour() != hour || parsed.Minute() != minute || parsed.Second() != second {
		return nil
	}
	return &parsed
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

// deriveRemoteMetadata 对齐 _derive_remote_metadata。
func deriveRemoteMetadata(item *BaiduRemoteItem) (string, *time.Time, *string) {
	stem := strings.TrimSpace(strings.NewReplacer("_", " ", "-", " ").Replace(posixStem(item.Filename)))
	capturedAt := parseRemoteDatetime(item.Filename)
	if capturedAt == nil {
		capturedAt = parseRemoteDatetime(item.ParentPath)
	}
	locationName := ""
	if item.ParentPath != "" {
		locationName = path.Base(item.ParentPath)
	}
	location := strings.TrimSpace(locationName)
	var locationPtr *string
	if location != "" {
		locationPtr = &location
	}
	title := truncateRunes(stem, 255)
	if title == "" {
		title = "未命名回忆"
	}
	return title, capturedAt, locationPtr
}

// ---- RemoteScanTask 行扫描 ----

const remoteScanTaskColumns = `id, remote_dir, status, cursor, max_depth, max_items, delete_missing,
processed_items, scanned_files, scanned_directories, discovered, refreshed, skipped,
failure_reason, started_at, completed_at, created_at, updated_at`

func scanRemoteTask(row pgx.Row) (*models.RemoteScanTask, error) {
	task := &models.RemoteScanTask{}
	if err := row.Scan(
		&task.ID, &task.RemoteDir, &task.Status, &task.Cursor, &task.MaxDepth,
		&task.MaxItems, &task.DeleteMissing, &task.ProcessedItems, &task.ScannedFiles,
		&task.ScannedDirectories, &task.Discovered, &task.Refreshed, &task.Skipped,
		&task.FailureReason, &task.StartedAt, &task.CompletedAt, &task.CreatedAt, &task.UpdatedAt,
	); err != nil {
		return nil, err
	}
	return task, nil
}

func loadScanTask(ctx context.Context, q dbtx, id uuid.UUID) (*models.RemoteScanTask, error) {
	task, err := scanRemoteTask(q.QueryRow(ctx,
		`SELECT `+remoteScanTaskColumns+` FROM remote_scan_tasks WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("读取扫描任务失败: %w", err)
	}
	return task, nil
}

func insertScanTask(ctx context.Context, q dbtx, remoteDir string, maxDepth, maxItems int, deleteMissing bool) (*models.RemoteScanTask, error) {
	cursor := marshalCursor([]scanCursorEntry{{Path: remoteDir, Start: 0, Depth: 0}})
	if maxDepth < 0 {
		maxDepth = 0
	}
	if maxItems < 1 {
		maxItems = 1
	}
	// 计数字段在库中为 NOT NULL 且无服务端默认值(原 SQLAlchemy 模型只在
	// 客户端补 default=0),这里显式写入 0,避免 INSERT 违反非空约束。
	task, err := scanRemoteTask(q.QueryRow(ctx,
		`INSERT INTO remote_scan_tasks (id, remote_dir, status, cursor, max_depth, max_items,
		 delete_missing, processed_items, scanned_files, scanned_directories, discovered, refreshed, skipped)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 0, 0, 0, 0)
		 RETURNING `+remoteScanTaskColumns,
		uuid.New(), remoteDir, models.RemoteScanStatusRunning, cursor, maxDepth, maxItems, deleteMissing))
	if err != nil {
		return nil, fmt.Errorf("创建扫描任务失败: %w", err)
	}
	return task, nil
}

// updateScanTaskProgress 每页事务内提交计数与游标(对齐页尾 db.commit())。
func updateScanTaskProgress(ctx context.Context, q dbtx, task *models.RemoteScanTask) error {
	_, err := q.Exec(ctx,
		`UPDATE remote_scan_tasks SET processed_items = $2, scanned_files = $3,
		 scanned_directories = $4, discovered = $5, refreshed = $6, skipped = $7,
		 cursor = $8, updated_at = now() WHERE id = $1`,
		task.ID, task.ProcessedItems, task.ScannedFiles, task.ScannedDirectories,
		task.Discovered, task.Refreshed, task.Skipped, task.Cursor,
	)
	if err != nil {
		return fmt.Errorf("更新扫描进度失败: %w", err)
	}
	return nil
}

func markTaskFailed(ctx context.Context, pool *pgxpool.Pool, taskID uuid.UUID, reason string) error {
	_, err := pool.Exec(ctx,
		`UPDATE remote_scan_tasks SET status = $2, failure_reason = $3, updated_at = now() WHERE id = $1`,
		taskID, models.RemoteScanStatusFailed, reason,
	)
	if err != nil {
		return fmt.Errorf("标记扫描失败失败: %w", err)
	}
	return nil
}

// failureReasonFor 对齐 except 分支:BaiduPanError 记原文,其余记异常类名。
func failureReasonFor(err error) string {
	var panErr *BaiduPanError
	if errors.As(err, &panErr) {
		return panErr.Msg
	}
	if named := reflect.TypeOf(err); named != nil {
		if name := named.Name(); name != "" {
			return name
		}
	}
	return err.Error()
}

// ---- 扫描主流程 ----

// ScanRemoteDirectory 对齐 scan_remote_directory。
func ScanRemoteDirectory(ctx context.Context, pool *pgxpool.Pool, client RemoteMediaClient, opts ScanRemoteOptions) (*BaiduScanSummary, error) {
	var task *models.RemoteScanTask
	if opts.ResumeTaskID != nil {
		loaded, err := loadScanTask(ctx, pool, *opts.ResumeTaskID)
		if err != nil {
			return nil, err
		}
		if loaded == nil || loaded.Status == models.RemoteScanStatusCompleted {
			return nil, &BaiduSyncError{Msg: "扫描任务不存在或已完成"}
		}
		task = loaded
	} else {
		created, err := insertScanTask(ctx, pool, opts.RemoteDir, opts.MaxDepth, opts.MaxItems, opts.DeleteMissing)
		if err != nil {
			return nil, err
		}
		task = created
	}

	summary := &BaiduScanSummary{TaskID: task.ID, Status: models.RemoteScanStatusRunning}
	queue := decodeCursor(task.Cursor, opts.RemoteDir)
	limitReached := false
	deletedCount := 0

	scanErr := func() error {
		for len(queue) > 0 {
			current := queue[len(queue)-1]
			directory := current.Path
			start := current.Start
			depth := current.Depth
			pendingDirectories := append([]scanCursorEntry{}, current.PendingDirs...)

			page, err := client.ListPage(ctx, directory, start, nil)
			if err != nil {
				return err
			}
			pageConsumed := 0

			tx, err := pool.Begin(ctx)
			if err != nil {
				return fmt.Errorf("开启页事务失败: %w", err)
			}
			for _, item := range page.Items {
				if task.ProcessedItems >= task.MaxItems {
					limitReached = true
					break
				}
				task.ProcessedItems++
				pageConsumed++
				if item.IsDir {
					task.ScannedDirectories++
					if depth+1 <= task.MaxDepth {
						pendingDirectories = append(pendingDirectories,
							scanCursorEntry{Path: item.RemotePath, Start: 0, Depth: depth + 1})
					} else {
						task.Skipped++
					}
					continue
				}
				task.ScannedFiles++
				if err := upsertRemoteFile(ctx, tx, item, task); err != nil {
					_ = tx.Rollback(ctx)
					return err
				}
			}
			if limitReached {
				// Python 在此处改内存游标后 break,页内已处理条目与计数随
				// 终局提交落盘(cursor 最终写 NULL)。对齐:提交本页事务。
				task.Cursor = nil
				if err := updateScanTaskProgress(ctx, tx, task); err != nil {
					_ = tx.Rollback(ctx)
					return err
				}
				if err := tx.Commit(ctx); err != nil {
					return fmt.Errorf("提交受限页事务失败: %w", err)
				}
				break
			}

			if page.NextStart != nil {
				queue[len(queue)-1] = scanCursorEntry{
					Path: directory, Start: *page.NextStart, Depth: depth, PendingDirs: pendingDirectories,
				}
			} else {
				queue = queue[:len(queue)-1]
				queue = append(queue, pendingDirectories...)
			}
			task.Cursor = ptrString(marshalCursor(queue))
			if err := updateScanTaskProgress(ctx, tx, task); err != nil {
				_ = tx.Rollback(ctx)
				return err
			}
			if err := tx.Commit(ctx); err != nil {
				return fmt.Errorf("提交页事务失败: %w", err)
			}
		}

		// 终局:置 COMPLETED、清空游标;未触限时把本任务未覆盖的网盘文件
		// 置为缺失,并按删除策略清理(Python 同一大 try 内,失败同样回滚)。
		completedAt := time.Now().UTC()
		tx, err := pool.Begin(ctx)
		if err != nil {
			return fmt.Errorf("开启完成事务失败: %w", err)
		}
		if _, err := tx.Exec(ctx,
			`UPDATE remote_scan_tasks SET processed_items = $2, scanned_files = $3,
			 scanned_directories = $4, discovered = $5, refreshed = $6, skipped = $7,
			 status = $8, completed_at = $9, cursor = NULL, updated_at = now() WHERE id = $1`,
			task.ID, task.ProcessedItems, task.ScannedFiles, task.ScannedDirectories,
			task.Discovered, task.Refreshed, task.Skipped, models.RemoteScanStatusCompleted, completedAt,
		); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("写扫描终态失败: %w", err)
		}

		if !limitReached {
			if _, err := tx.Exec(ctx,
				`UPDATE memory_files SET status = $3, remote_state = $4, stream_state = $5,
				 sync_error = $6, last_synced_at = $7, updated_at = now()
				 WHERE source = $2 AND (last_scan_task_id <> $1 OR last_scan_task_id IS NULL)`,
				task.ID, "baidupan", models.MemoryFileStatusMissing, models.RemoteFileStateMissing,
				models.RemoteStreamStateUnavailable, "网盘目录中未找到该文件", completedAt,
			); err != nil {
				_ = tx.Rollback(ctx)
				return fmt.Errorf("标记缺失文件失败: %w", err)
			}
			if task.DeleteMissing {
				missingFiles, deletedMemories, err := deleteMissingRemoteEntries(ctx, tx, task.ID)
				if err != nil {
					_ = tx.Rollback(ctx)
					return err
				}
				deletedCount = missingFiles
				detail := fmt.Sprintf("task=%s;files=%d;memories=%d;remote_resource=unchanged",
					task.ID, missingFiles, deletedMemories)
				if err := RecordAdminOperation(pool, "remote_index_delete", ptrString("memory_batch"), nil, nil, &detail); err != nil {
					slog.Error("record remote_index_delete audit failed", "error", err)
				}
			}
		}

		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("提交扫描终态失败: %w", err)
		}
		return nil
	}()

	if scanErr != nil {
		if err := markTaskFailed(ctx, pool, task.ID, failureReasonFor(scanErr)); err != nil {
			slog.Error("scan failure persistence failed", "error", err)
		}
		reloaded, loadErr := loadScanTask(ctx, pool, task.ID)
		if loadErr == nil && reloaded != nil {
			return summaryFromTask(reloaded, false, 0), nil
		}
		return summary, nil
	}

	reloaded, err := loadScanTask(ctx, pool, task.ID)
	if err != nil {
		return nil, err
	}
	return summaryFromTask(reloaded, limitReached, deletedCount), nil
}

// ptrString 返回字符串指针(游标与 detail 构造共用)。
func ptrString(value string) *string { return &value }

// upsertRemoteFile 对齐 _upsert_remote_file。
func upsertRemoteFile(ctx context.Context, tx pgx.Tx, item *BaiduRemoteItem, task *models.RemoteScanTask) error {
	kind := InferMemoryKindOrNone(item.Filename, nil)
	if kind == nil {
		task.Skipped++
		return nil
	}

	var existingID uuid.UUID
	existingErr := tx.QueryRow(ctx,
		`SELECT id FROM memory_files WHERE source = $1 AND remote_id = $2 AND remote_path = $3`,
		"baidupan", item.RemoteID, item.RemotePath).Scan(&existingID)
	switch {
	case errors.Is(existingErr, pgx.ErrNoRows):
		existingID = uuid.Nil
	case existingErr != nil:
		return fmt.Errorf("查询已有网盘文件失败: %w", existingErr)
	}

	now := time.Now().UTC()
	if existingID != uuid.Nil {
		file, err := loadMemoryFileByID(ctx, tx, existingID)
		if err != nil {
			return err
		}
		task.Refreshed++
		changed := !int64PtrEqual(file.SizeBytes, item.SizeBytes) ||
			!timePtrEqual(file.ModifiedAt, item.ModifiedAt) ||
			!stringPtrEqual(file.RemoteMD5, item.MD5)
		if err := applyRemoteMetadata(ctx, tx, file, item); err != nil {
			return err
		}
		file.RemoteState = models.RemoteFileStateReady
		file.StreamState = models.RemoteStreamStateReady
		file.Status = models.MemoryFileStatusMatched
		file.SyncError = nil
		file.LastSyncedAt = &now
		file.LastScanTaskID = &task.ID
		if err := persistMemoryFile(ctx, tx, file); err != nil {
			return err
		}

		if changed && file.MemoryID != nil {
			memory, err := loadMemoryByID(ctx, tx, *file.MemoryID)
			if err != nil {
				return err
			}
			if memory != nil && fillMemoryFromRemote(memory, item, true) {
				if err := persistMemory(ctx, tx, memory); err != nil {
					return err
				}
			}
		}
		return nil
	}

	// md5 去重挂载:同 md5 最早创建的文件决定挂载点,不重复建 memory。
	var duplicate *models.MemoryFile
	if item.MD5 != nil && *item.MD5 != "" {
		row := tx.QueryRow(ctx,
			`SELECT `+models.MemoryFilesColumns+` FROM memory_files
			 WHERE source = $1 AND remote_md5 = $2 ORDER BY created_at ASC LIMIT 1`,
			"baidupan", *item.MD5)
		dup, err := scanMemoryFileRow(row)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("查询 md5 重复失败: %w", err)
		}
		if dup != nil {
			duplicate = dup
		}
	}
	memoryID := uuid.New()
	if duplicate != nil {
		if duplicate.MemoryID != nil {
			memoryID = *duplicate.MemoryID
		}
	} else {
		title, capturedAt, location := deriveRemoteMetadata(item)
		if _, err := tx.Exec(ctx,
			`INSERT INTO memories (id, title, kind, status, captured_at, location)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			memoryID, title, *kind, models.MemoryStatusPending, capturedAt, location,
		); err != nil {
			return fmt.Errorf("创建 memory 失败: %w", err)
		}
	}

	file := &models.MemoryFile{
		ID:          uuid.New(),
		MemoryID:    &memoryID,
		Source:      "baidupan",
		RemoteID:    ptrString(item.RemoteID),
		RemotePath:  item.RemotePath,
		ParentPath:  item.ParentPath,
		Filename:    item.Filename,
		Extension:   extensionOf(item.Filename),
		MimeType:    GuessMimeType(item.Filename, nil),
		SizeBytes:   item.SizeBytes,
		ModifiedAt:  item.ModifiedAt,
		RemoteMD5:   item.MD5,
		Status:      models.MemoryFileStatusMatched,
		RemoteState: models.RemoteFileStateReady,
		StreamState: models.RemoteStreamStateReady,
		LastSyncedAt: &now,
		LastScanTaskID: &task.ID,
	}
	if item.ThumbnailURL != nil {
		file.ThumbnailState = models.RemoteThumbnailStateReady
	} else {
		file.ThumbnailState = models.RemoteThumbnailStateMissing
	}
	if *kind == models.MemoryKindPhoto {
		file.BrowserCompatibility = models.BrowserCompatibilityStateSupported
	} else {
		// Python: 插入时先置 UNKNOWN,再由持久证据判定覆盖。
		file.BrowserCompatibility = models.BrowserCompatibilityStateUnknown
	}
	summaryJSON, err := json.Marshal(orEmptyMap(item.RawMetadataSummary))
	if err != nil {
		return fmt.Errorf("序列化远端摘要失败: %w", err)
	}
	file.RawMetadataSummary = summaryJSON
	if *kind == models.MemoryKindVideo {
		applyPersistedCompatibility(file)
	}
	if err := insertMemoryFile(ctx, tx, file); err != nil {
		return err
	}
	task.Discovered++
	return nil
}

func orEmptyMap(source map[string]any) map[string]any {
	if source == nil {
		return map[string]any{}
	}
	return source
}

func extensionOf(filename string) *string {
	suffix := strings.ToLower(strings.TrimPrefix(posixSuffix(filename), "."))
	if suffix == "" {
		return nil
	}
	return &suffix
}

func int64PtrEqual(a, b *int64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func timePtrEqual(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Equal(*b)
}

func stringPtrEqual(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// applyRemoteMetadata 对齐 _apply_remote_metadata;视频按持久证据重判兼容性。
func applyRemoteMetadata(ctx context.Context, q dbtx, file *models.MemoryFile, item *BaiduRemoteItem) error {
	file.RemoteID = ptrString(item.RemoteID)
	file.RemotePath = item.RemotePath
	file.ParentPath = item.ParentPath
	file.Filename = item.Filename
	file.Extension = extensionOf(item.Filename)
	file.SizeBytes = item.SizeBytes
	file.ModifiedAt = item.ModifiedAt
	file.RemoteMD5 = item.MD5
	summaryJSON, err := json.Marshal(orEmptyMap(item.RawMetadataSummary))
	if err != nil {
		return fmt.Errorf("序列化远端摘要失败: %w", err)
	}
	file.RawMetadataSummary = summaryJSON
	if item.ThumbnailURL != nil {
		file.ThumbnailState = models.RemoteThumbnailStateReady
	} else {
		file.ThumbnailState = models.RemoteThumbnailStateMissing
	}
	file.ThumbnailFailureKind = nil

	if file.MemoryID != nil {
		var kind models.MemoryKind
		kindErr := q.QueryRow(ctx, `SELECT kind FROM memories WHERE id = $1`, *file.MemoryID).Scan(&kind)
		if kindErr == nil && kind == models.MemoryKindVideo {
			applyPersistedCompatibility(file)
		}
	}
	return nil
}

// fillMemoryFromRemote 对齐 _fill_memory_from_remote;返回是否产生实际变更。
func fillMemoryFromRemote(memory *models.Memory, item *BaiduRemoteItem, allowUpdate bool) bool {
	title, capturedAt, location := deriveRemoteMetadata(item)
	fallbackTitle := title
	changed := false

	if allowUpdate && (memory.Title == "" || memory.Title == fallbackTitle) && memory.Title != title {
		memory.Title = title
		changed = true
	}
	if memory.CapturedAt == nil && capturedAt != nil {
		memory.CapturedAt = capturedAt
		changed = true
	}
	if memory.Location == nil && location != nil {
		memory.Location = location
		changed = true
	}
	if memory.Status != models.MemoryStatusPublished && memory.Status != models.MemoryStatusHidden {
		if memory.Status != models.MemoryStatusPending {
			changed = true
		}
		memory.Status = models.MemoryStatusPending
	}
	return changed
}

// ---- 行加载与持久化助手 ----

const memoryRowColumns = `id, title, description, kind, status, captured_at,
location, thumbnail_path, duration_seconds, width, height,
created_at, updated_at`

func scanMemoryRow(row pgx.Row) (*models.Memory, error) {
	memory := &models.Memory{}
	if err := row.Scan(
		&memory.ID, &memory.Title, &memory.Description, &memory.Kind, &memory.Status,
		&memory.CapturedAt, &memory.Location, &memory.ThumbnailPath, &memory.DurationSeconds,
		&memory.Width, &memory.Height, &memory.CreatedAt, &memory.UpdatedAt,
	); err != nil {
		return nil, err
	}
	return memory, nil
}

func loadMemoryByID(ctx context.Context, q dbtx, id uuid.UUID) (*models.Memory, error) {
	memory, err := scanMemoryRow(q.QueryRow(ctx,
		`SELECT `+memoryRowColumns+` FROM memories WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("读取 memory 失败: %w", err)
	}
	return memory, nil
}

func loadMemoryFileByID(ctx context.Context, q dbtx, id uuid.UUID) (*models.MemoryFile, error) {
	file, err := scanMemoryFileRow(q.QueryRow(ctx,
		`SELECT `+models.MemoryFilesColumns+` FROM memory_files WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("读取 memory file 失败: %w", err)
	}
	return file, nil
}

func scanMemoryFileRow(row pgx.Row) (*models.MemoryFile, error) {
	file := &models.MemoryFile{}
	var createdAt, updatedAt time.Time
	err := row.Scan(
		&file.ID, &file.MemoryID, &file.Source, &file.RemotePath, &file.RemoteID, &file.SourcePath,
		&file.MimeType, &file.SizeBytes, &file.RemoteMD5, &file.ParentPath, &file.Filename, &file.Extension, &file.ModifiedAt,
		&file.RemoteState, &file.ThumbnailState, &file.ThumbnailFailureKind, &file.StreamState,
		&file.BrowserCompatibility, &file.BrowserCompatibilityVersion, &file.BrowserFormatSummary,
		&file.BrowserCompatibilityError, &file.BrowserCompatibilityCheckedAt,
		&file.RawMetadataSummary, &file.LastScanTaskID, &file.ContentHash, &file.Status,
		&file.LastSyncedAt, &file.SyncError, &createdAt, &updatedAt,
	)
	if err != nil {
		return nil, err
	}
	file.CreatedAt = createdAt
	file.UpdatedAt = updatedAt
	return file, nil
}

func persistMemory(ctx context.Context, q dbtx, memory *models.Memory) error {
	_, err := q.Exec(ctx,
		`UPDATE memories SET title = $2, captured_at = $3, location = $4, status = $5,
		 updated_at = now() WHERE id = $1`,
		memory.ID, memory.Title, memory.CapturedAt, memory.Location, memory.Status,
	)
	if err != nil {
		return fmt.Errorf("更新 memory 失败: %w", err)
	}
	return nil
}

func persistMemoryFile(ctx context.Context, q dbtx, file *models.MemoryFile) error {
	_, err := q.Exec(ctx,
		`UPDATE memory_files SET remote_id = $2, remote_path = $3, parent_path = $4,
		 filename = $5, extension = $6, size_bytes = $7, modified_at = $8, remote_md5 = $9,
		 raw_metadata_summary = $10, thumbnail_state = $11, thumbnail_failure_kind = $12,
		 remote_state = $13, stream_state = $14, status = $15, sync_error = $16,
		 last_synced_at = $17, last_scan_task_id = $18,
		 browser_compatibility = $19, browser_compatibility_version = $20,
		 browser_format_summary = $21, browser_compatibility_error = $22,
		 browser_compatibility_checked_at = $23, updated_at = now()
		 WHERE id = $1`,
		file.ID, file.RemoteID, file.RemotePath, file.ParentPath, file.Filename, file.Extension,
		file.SizeBytes, file.ModifiedAt, file.RemoteMD5, file.RawMetadataSummary,
		file.ThumbnailState, file.ThumbnailFailureKind, file.RemoteState, file.StreamState,
		file.Status, file.SyncError, file.LastSyncedAt, file.LastScanTaskID,
		file.BrowserCompatibility, file.BrowserCompatibilityVersion, file.BrowserFormatSummary,
		file.BrowserCompatibilityError, file.BrowserCompatibilityCheckedAt,
	)
	if err != nil {
		return fmt.Errorf("更新 memory file 失败: %w", err)
	}
	return nil
}

func insertMemoryFile(ctx context.Context, q dbtx, file *models.MemoryFile) error {
	_, err := q.Exec(ctx,
		`INSERT INTO memory_files (id, memory_id, source, remote_path, remote_id, mime_type,
		 size_bytes, remote_md5, parent_path, filename, extension, modified_at,
		 raw_metadata_summary, status, remote_state, thumbnail_state, stream_state,
		 browser_compatibility, browser_format_summary,
		 browser_compatibility_version, browser_compatibility_checked_at,
		 last_synced_at, last_scan_task_id)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
		file.ID, file.MemoryID, file.Source, file.RemotePath, file.RemoteID, file.MimeType,
		file.SizeBytes, file.RemoteMD5, file.ParentPath, file.Filename, file.Extension, file.ModifiedAt,
		file.RawMetadataSummary, file.Status, file.RemoteState, file.ThumbnailState, file.StreamState,
		file.BrowserCompatibility, file.BrowserFormatSummary,
		file.BrowserCompatibilityVersion, file.BrowserCompatibilityCheckedAt,
		file.LastSyncedAt, file.LastScanTaskID,
	)
	if err != nil {
		return fmt.Errorf("创建 memory file 失败: %w", err)
	}
	return nil
}

// RefreshRemoteEntry 对齐 refresh_remote_entry。
func RefreshRemoteEntry(ctx context.Context, pool *pgxpool.Pool, client RemoteMediaClient, file *models.MemoryFile) (*models.MemoryFile, error) {
	if file.Source != "baidupan" {
		return nil, &BaiduSyncError{Msg: "只有网盘条目可以刷新远程状态"}
	}

	remoteID := ""
	if file.RemoteID != nil {
		remoteID = *file.RemoteID
	}
	item, err := client.GetFileMetadata(ctx, remoteID)
	if err != nil {
		var panErr *BaiduPanError
		if errors.As(err, &panErr) {
			if markErr := persistRefreshFailure(ctx, pool, file, "远程元数据刷新失败"); markErr != nil {
				return nil, markErr
			}
		}
		return nil, err
	}

	if item.IsDir || item.RemotePath != file.RemotePath {
		if err := persistRefreshFailure(ctx, pool, file, "远程路径已变化或条目无效"); err != nil {
			return nil, err
		}
		return nil, &BaiduPanError{Msg: "远程路径已变化或条目无效"}
	}

	now := time.Now().UTC()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("开启刷新事务失败: %w", err)
	}
	if err := applyRemoteMetadata(ctx, tx, file, item); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	file.RemoteState = models.RemoteFileStateReady
	file.StreamState = models.RemoteStreamStateReady
	file.Status = models.MemoryFileStatusMatched
	file.SyncError = nil
	file.LastSyncedAt = &now

	if file.MemoryID != nil {
		memory, err := loadMemoryByID(ctx, tx, *file.MemoryID)
		if err != nil {
			_ = tx.Rollback(ctx)
			return nil, err
		}
		if memory != nil && fillMemoryFromRemote(memory, item, true) {
			if err := persistMemory(ctx, tx, memory); err != nil {
				_ = tx.Rollback(ctx)
				return nil, err
			}
		}
	}
	if err := persistMemoryFile(ctx, tx, file); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("提交刷新失败: %w", err)
	}
	return file, nil
}

// persistRefreshFailure 对齐失败分支:落盘失败状态后原样上抛。
func persistRefreshFailure(ctx context.Context, pool *pgxpool.Pool, file *models.MemoryFile, message string) error {
	now := time.Now().UTC()
	file.RemoteState = models.RemoteFileStateFailed
	file.StreamState = models.RemoteStreamStateFailed
	file.SyncError = ptrString(message)
	file.LastSyncedAt = &now
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("开启刷新失败事务失败: %w", err)
	}
	if err := persistMemoryFile(ctx, tx, file); err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("提交刷新失败状态失败: %w", err)
	}
	return nil
}

// CreateRemoteScanTask 对齐 create_remote_scan_task:已有 RUNNING 任务则复用。
func CreateRemoteScanTask(ctx context.Context, pool *pgxpool.Pool, remoteDir string, maxDepth, maxItems int, deleteMissing bool) (*models.RemoteScanTask, error) {
	row := pool.QueryRow(ctx,
		`SELECT `+remoteScanTaskColumns+` FROM remote_scan_tasks WHERE status = $1 ORDER BY created_at LIMIT 1`,
		models.RemoteScanStatusRunning)
	task, err := scanRemoteTask(row)
	if err == nil {
		return task, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("查询运行中扫描任务失败: %w", err)
	}
	return insertScanTask(ctx, pool, remoteDir, maxDepth, maxItems, deleteMissing)
}

// RunRemoteScanTask 对齐 run_remote_scan_task:槽位内执行扫描并落审计,
// 成功后按配置后台预热首页缩略图。runner 为 nil 时跳过自动预热。
func RunRemoteScanTask(
	ctx context.Context,
	runner *ThumbnailPreheatRunner,
	taskID uuid.UUID,
	clientFactory func() (RemoteMediaClient, error),
	autoPreheat *bool,
) {
	if runner == nil {
		return
	}
	pool := runner.Pool
	task, err := loadScanTask(ctx, pool, taskID)
	if err != nil {
		slog.Error("load scan task failed", "error", err)
		return
	}
	if task == nil || task.Status == models.RemoteScanStatusCompleted {
		return
	}

	_, release, err := runner.Governor.Slot(ctx, TaskTypeScan, 50, nil)
	if err != nil {
		runner.Governor.Metrics.RecordRejected(TaskTypeScan)
		return
	}
	defer release()

	client, err := clientFactory()
	if err != nil {
		runner.Governor.Metrics.RecordFailed(TaskTypeScan)
		detail := fmt.Sprintf("task=%s;status=failed;mode=%s", task.ID, scanMode(task.DeleteMissing))
		if err := RecordAdminOperation(pool, "scan", ptrString("remote_scan_task"), nil, nil, &detail); err != nil {
			slog.Error("record scan audit failed", "error", err)
		}
		return
	}

	summary, err := ScanRemoteDirectory(ctx, pool, client, ScanRemoteOptions{
		RemoteDir:     task.RemoteDir,
		MaxDepth:      task.MaxDepth,
		MaxItems:      task.MaxItems,
		ResumeTaskID:  &task.ID,
		DeleteMissing: task.DeleteMissing,
	})
	if err != nil {
		runner.Governor.Metrics.RecordFailed(TaskTypeScan)
		detail := fmt.Sprintf("task=%s;status=failed;mode=%s", task.ID, scanMode(task.DeleteMissing))
		if recordErr := RecordAdminOperation(pool, "scan", ptrString("remote_scan_task"), nil, nil, &detail); recordErr != nil {
			slog.Error("record scan audit failed", "error", recordErr)
		}
		return
	}

	runner.Governor.Metrics.RecordCompleted(TaskTypeScan)
	detail := fmt.Sprintf(
		"task=%s;status=%s;discovered=%d;refreshed=%d;skipped=%d;deleted=%d;mode=%s",
		summary.TaskID, summary.Status, summary.Discovered, summary.Refreshed,
		summary.Skipped, summary.Deleted, scanMode(task.DeleteMissing))
	if err := RecordAdminOperation(pool, "scan", ptrString("remote_scan_task"), nil, nil, &detail); err != nil {
		slog.Error("record scan audit failed", "error", err)
	}

	// 扫描可能引入新索引资源:完成后自动预热首页缩略图。任何失败都
	// 不影响扫描结果;已有预热任务在跑时由注册表单飞语义静默跳过。
	shouldAutoPreheat := runner.Settings.PreheatAutoAfterScan
	if autoPreheat != nil {
		shouldAutoPreheat = *autoPreheat
	}
	if shouldAutoPreheat {
		func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					slog.Error("auto preheat after scan failed", "task_id", task.ID, "panic", recovered)
				}
			}()
			StartAutoPreheatAfterScan(runner)
		}()
	}
}

func scanMode(deleteMissing bool) string {
	if deleteMissing {
		return "async-delete"
	}
	return "async-keep"
}

// deleteMissingRemoteEntries 对齐 _delete_missing_remote_entries:删除本任务
// 未触碰的网盘文件,并清理不再持有网盘文件的 memory(返回 文件数, memory 数)。
func deleteMissingRemoteEntries(ctx context.Context, tx pgx.Tx, taskID uuid.UUID) (int, int, error) {
	rows, err := tx.Query(ctx,
		`SELECT id, memory_id FROM memory_files
		 WHERE source = $1 AND (last_scan_task_id <> $2 OR last_scan_task_id IS NULL)`,
		"baidupan", taskID)
	if err != nil {
		return 0, 0, fmt.Errorf("查询缺失网盘文件失败: %w", err)
	}
	var fileIDs []uuid.UUID
	memoryIDs := map[uuid.UUID]bool{}
	for rows.Next() {
		var fileID uuid.UUID
		var memoryID *uuid.UUID
		if err := rows.Scan(&fileID, &memoryID); err != nil {
			rows.Close()
			return 0, 0, fmt.Errorf("扫描缺失文件失败: %w", err)
		}
		fileIDs = append(fileIDs, fileID)
		if memoryID != nil {
			memoryIDs[*memoryID] = true
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, 0, fmt.Errorf("遍历缺失文件失败: %w", err)
	}

	deletedMemories := 0
	if len(fileIDs) > 0 {
		if _, err := tx.Exec(ctx,
			`DELETE FROM memory_files WHERE id = ANY($1)`, fileIDs,
		); err != nil {
			return 0, 0, fmt.Errorf("删除缺失网盘文件失败: %w", err)
		}
	}

	for memoryID := range memoryIDs {
		count := 0
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM memory_files WHERE memory_id = $1 AND source = $2`,
			memoryID, "baidupan",
		).Scan(&count); err != nil {
			return 0, 0, fmt.Errorf("统计残留网盘文件失败: %w", err)
		}
		if count != 0 {
			continue
		}
		if _, err := tx.Exec(ctx, `DELETE FROM memories WHERE id = $1`, memoryID); err != nil {
			return 0, 0, fmt.Errorf("删除孤立 memory 失败: %w", err)
		}
		deletedMemories++
	}
	return len(fileIDs), deletedMemories, nil
}

// summaryFromTask 对齐 _summary_from_task。
func summaryFromTask(task *models.RemoteScanTask, limitReached bool, deleted int) *BaiduScanSummary {
	return &BaiduScanSummary{
		TaskID:             task.ID,
		Status:             task.Status,
		ProcessedItems:     task.ProcessedItems,
		ScannedFiles:       task.ScannedFiles,
		ScannedDirectories: task.ScannedDirectories,
		Discovered:         task.Discovered,
		Refreshed:          task.Refreshed,
		Skipped:            task.Skipped,
		Deleted:            deleted,
		LimitReached:       limitReached,
		FailureReason:      task.FailureReason,
		Cursor:             task.Cursor,
	}
}
