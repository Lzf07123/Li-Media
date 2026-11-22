// thumbnail_preheat.go 对齐原 app/services/thumbnail_preheat.py:
// 有界、可取消的缩略图预热,进程内注册表 + 历史落盘 + 公开状态聚合。
//
// 实现差异(有意为之):
//   - Python ThreadPoolExecutor futures → Go goroutine worker pool(每
//     worker 一个惰性远端客户端,对齐线程本地客户端语义);
//   - cancel_event → context.Context(registry 持有 cancelFunc);
//   - SQLAlchemy Session → *pgxpool.Pool 显式事务。
package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"limedia/backend/internal/config"
	"limedia/backend/internal/models"
	"limedia/backend/internal/repo"
)

const (
	// MaxPreheatJobHistory 注册表与落盘历史保留的最近任务数。
	MaxPreheatJobHistory = 20
)

// 预热任务状态(契约字符串)。
const (
	PreheatJobQueued    = "queued"
	PreheatJobRunning   = "running"
	PreheatJobCompleted = "completed"
	PreheatJobCancelled = "cancelled"
	PreheatJobFailed    = "failed"
)

// PublicPreheatStatus 公开预热状态(status/processed/total 键序契约)。
type PublicPreheatStatus struct {
	Status    string `json:"status"`
	Processed int    `json:"processed"`
	Total     int    `json:"total"`
}

// PreheatCandidateResult 单候选处理结果(对齐 PreheatCandidateResult;
// FailureKind 空串等价 Python None)。
type PreheatCandidateResult struct {
	Outcomes             map[int]string
	SourceBytesDownloaded int
	DerivativeDurationMS  int
	FailureKind           string
}

// ---- 任务与注册表 ----

// ThumbnailPreheatJob 单次预热任务。可变字段全部由注册表锁保护;
// 消费方通过 Snapshot/Counters/Cancelled 读取,避免数据竞争。
type ThumbnailPreheatJob struct {
	ID                    uuid.UUID
	Sizes                 []int
	Kind                  *models.MemoryKind
	Limit                 int
	Concurrency           int
	QueueLimit            int
	IncludeFailed         bool
	Status                string
	Total                 int
	Processed             int
	Generated             int
	Cached                int
	Failed                int
	Skipped               int
	SourceBytesDownloaded int
	DerivativeDurationMS  int
	SizeResults           map[string]map[string]int
	Message               *string
	CreatedAt             time.Time
	StartedAt             *time.Time
	CompletedAt           *time.Time

	cancelCtx  context.Context
	cancelFunc context.CancelFunc
}

// newThumbnailPreheatJob 对齐 __post_init__:尺寸去重(空回退 240),
// size_results 按尺寸初始化四类计数。
func newThumbnailPreheatJob(id uuid.UUID, sizes []int, kind *models.MemoryKind, limit, concurrency, queueLimit int, includeFailed bool) *ThumbnailPreheatJob {
	deduped := dedupeInts(sizes)
	if len(deduped) == 0 {
		deduped = []int{repo.HomePreheatSize}
	}
	sizeResults := make(map[string]map[string]int, len(deduped))
	for _, size := range deduped {
		sizeResults[fmt.Sprintf("%d", size)] = map[string]int{
			"generated": 0, "cached": 0, "failed": 0, "skipped": 0,
		}
	}
	var kindCopy *models.MemoryKind
	if kind != nil {
		value := *kind
		kindCopy = &value
	}
	return &ThumbnailPreheatJob{
		ID:            id,
		Sizes:         deduped,
		Kind:          kindCopy,
		Limit:         limit,
		Concurrency:   concurrency,
		QueueLimit:    queueLimit,
		IncludeFailed: includeFailed,
		Status:        PreheatJobQueued,
		SizeResults:   sizeResults,
		CreatedAt:     time.Now().UTC(),
	}
}

// ThumbnailPreheatRegistry 进程内预热任务注册表(单飞 + 历史保留)。
type ThumbnailPreheatRegistry struct {
	mu       sync.Mutex
	jobs     map[uuid.UUID]*ThumbnailPreheatJob
	order    []uuid.UUID // 插入序,对齐 Python dict 的裁剪语义
	latestID *uuid.UUID
}

// DefaultThumbnailPreheatRegistry 行为对齐 Python 包级单例;main 装配
// 时可注入独立实例,测试一律独立构造。
var DefaultThumbnailPreheatRegistry = NewThumbnailPreheatRegistry()

func NewThumbnailPreheatRegistry() *ThumbnailPreheatRegistry {
	return &ThumbnailPreheatRegistry{jobs: make(map[uuid.UUID]*ThumbnailPreheatJob)}
}

// Start 单飞:已有 queued/running 任务时返回其 (job, false)。
func (r *ThumbnailPreheatRegistry) Start(sizes []int, kind *models.MemoryKind, limit, concurrency, queueLimit int, includeFailed bool) (*ThumbnailPreheatJob, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, job := range r.jobs {
		if job.Status == PreheatJobQueued || job.Status == PreheatJobRunning {
			return job, false
		}
	}
	job := newThumbnailPreheatJob(uuid.New(), sizes, kind, limit, concurrency, queueLimit, includeFailed)
	if job.Concurrency < 1 {
		job.Concurrency = 1
	}
	if job.QueueLimit < 0 {
		job.QueueLimit = 0
	}
	job.cancelCtx, job.cancelFunc = context.WithCancel(context.Background())
	r.jobs[job.ID] = job
	r.order = append(r.order, job.ID)
	latest := job.ID
	r.latestID = &latest
	for len(r.jobs) > MaxPreheatJobHistory {
		oldest := r.order[0]
		if oldest == job.ID {
			break
		}
		r.order = r.order[1:]
		delete(r.jobs, oldest)
	}
	return job, true
}

// RestoreHistory 进程重启后从磁盘恢复历史任务(仅终态),供 admin 事后
// 诊断。快照只进历史、不重挂任何执行体;latest 指向最新一条。
func (r *ThumbnailPreheatRegistry) RestoreHistory(jobs []*ThumbnailPreheatJob) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, job := range jobs {
		if job == nil || job.Status == PreheatJobQueued || job.Status == PreheatJobRunning {
			continue
		}
		r.jobs[job.ID] = job
	}
	ordered := make([]*ThumbnailPreheatJob, 0, len(r.jobs))
	for _, job := range r.jobs {
		ordered = append(ordered, job)
	}
	sort.Slice(ordered, func(i, j int) bool {
		ti := ordered[i].terminalSortTime()
		tj := ordered[j].terminalSortTime()
		return ti.After(*tj)
	})
	if len(ordered) > MaxPreheatJobHistory {
		ordered = ordered[:MaxPreheatJobHistory]
	}
	r.jobs = make(map[uuid.UUID]*ThumbnailPreheatJob, len(ordered))
	r.order = r.order[:0]
	for _, job := range ordered {
		r.jobs[job.ID] = job
		r.order = append(r.order, job.ID)
	}
	if len(ordered) > 0 {
		latest := ordered[0].ID
		r.latestID = &latest
	}
}

func (j *ThumbnailPreheatJob) terminalSortTime() *time.Time {
	if j.CompletedAt != nil {
		return j.CompletedAt
	}
	value := j.CreatedAt
	return &value
}

// Get 按 id 取任务(内部锁保护,消费方读可变字段请用快照访问器)。
func (r *ThumbnailPreheatRegistry) Get(jobID uuid.UUID) *ThumbnailPreheatJob {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.jobs[jobID]
}

// GetLatest 最近一次注册的任务。
func (r *ThumbnailPreheatRegistry) GetLatest() *ThumbnailPreheatJob {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.latestID == nil {
		return nil
	}
	return r.jobs[*r.latestID]
}

func (r *ThumbnailPreheatRegistry) updateJob(jobID uuid.UUID, apply func(*ThumbnailPreheatJob)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if job, ok := r.jobs[jobID]; ok {
		apply(job)
	}
}

// MarkRunning 进入执行态并登记候选总数。
func (r *ThumbnailPreheatRegistry) MarkRunning(jobID uuid.UUID, total int) {
	r.updateJob(jobID, func(job *ThumbnailPreheatJob) {
		job.Status = PreheatJobRunning
		job.Total = total
		now := time.Now().UTC()
		job.StartedAt = &now
	})
}

// MarkItemProcessed 记一次候选结算;未知结果归入 failed。
func (r *ThumbnailPreheatRegistry) MarkItemProcessed(jobID uuid.UUID, outcomes map[int]string, sourceBytes, derivativeDurationMS int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	job, ok := r.jobs[jobID]
	if !ok {
		return
	}
	if sourceBytes < 0 {
		sourceBytes = 0
	}
	if derivativeDurationMS < 0 {
		derivativeDurationMS = 0
	}
	job.Processed++
	job.SourceBytesDownloaded += sourceBytes
	job.DerivativeDurationMS += derivativeDurationMS
	for size, outcome := range outcomes {
		key := fmt.Sprintf("%d", size)
		counts, exists := job.SizeResults[key]
		if !exists {
			counts = map[string]int{"generated": 0, "cached": 0, "failed": 0, "skipped": 0}
			job.SizeResults[key] = counts
		}
		normalized := outcome
		switch outcome {
		case "generated", "cached", "failed", "skipped":
		default:
			normalized = "failed"
		}
		counts[normalized]++
		switch normalized {
		case "generated":
			job.Generated++
		case "cached":
			job.Cached++
		case "failed":
			job.Failed++
		case "skipped":
			job.Skipped++
		}
	}
}

func (r *ThumbnailPreheatRegistry) MarkCompleted(jobID uuid.UUID, message *string) {
	r.updateJob(jobID, func(job *ThumbnailPreheatJob) {
		job.Status = PreheatJobCompleted
		job.Message = message
		now := time.Now().UTC()
		job.CompletedAt = &now
	})
}

// MarkFailed 消息截断到 255 字符(对齐 message[:255])。
func (r *ThumbnailPreheatRegistry) MarkFailed(jobID uuid.UUID, message string) {
	r.updateJob(jobID, func(job *ThumbnailPreheatJob) {
		job.Status = PreheatJobFailed
		truncated := truncateRunes(message, 255)
		job.Message = &truncated
		now := time.Now().UTC()
		job.CompletedAt = &now
	})
}

func (r *ThumbnailPreheatRegistry) MarkCancelled(jobID uuid.UUID, message *string) {
	r.updateJob(jobID, func(job *ThumbnailPreheatJob) {
		job.Status = PreheatJobCancelled
		job.Message = message
		now := time.Now().UTC()
		job.CompletedAt = &now
	})
}

// RequestCancel 非终态任务置取消;执行体经由 context 感知并收尾。
func (r *ThumbnailPreheatRegistry) RequestCancel(jobID uuid.UUID) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	job, ok := r.jobs[jobID]
	if !ok || (job.Status != PreheatJobQueued && job.Status != PreheatJobRunning) {
		return false
	}
	if job.cancelFunc != nil {
		job.cancelFunc()
	}
	return true
}

// Cancelled 任务是否已被请求取消。
func (r *ThumbnailPreheatRegistry) Cancelled(jobID uuid.UUID) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	job, ok := r.jobs[jobID]
	if !ok {
		return false
	}
	return job.cancelCtx != nil && job.cancelCtx.Err() != nil
}

// Counters 任务计数快照(取消消息与状态展示用)。
func (r *ThumbnailPreheatRegistry) Counters(jobID uuid.UUID) (processed, total int, found bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	job, ok := r.jobs[jobID]
	if !ok {
		return 0, 0, false
	}
	return job.Processed, job.Total, true
}

// Snapshot 返回任务的一致性副本(可变字段深拷贝;cancel 句柄剥离)。
func (r *ThumbnailPreheatRegistry) Snapshot(jobID uuid.UUID) *ThumbnailPreheatJob {
	r.mu.Lock()
	defer r.mu.Unlock()
	job, ok := r.jobs[jobID]
	if !ok {
		return nil
	}
	clone := *job
	clone.Sizes = append([]int(nil), job.Sizes...)
	if job.Kind != nil {
		value := *job.Kind
		clone.Kind = &value
	}
	if job.Message != nil {
		value := *job.Message
		clone.Message = &value
	}
	if job.StartedAt != nil {
		value := *job.StartedAt
		clone.StartedAt = &value
	}
	if job.CompletedAt != nil {
		value := *job.CompletedAt
		clone.CompletedAt = &value
	}
	clone.SizeResults = make(map[string]map[string]int, len(job.SizeResults))
	for key, counts := range job.SizeResults {
		copied := make(map[string]int, len(counts))
		for name, count := range counts {
			copied[name] = count
		}
		clone.SizeResults[key] = copied
	}
	clone.cancelCtx = nil
	clone.cancelFunc = nil
	return &clone
}

// ---- 历史落盘与恢复 ----

// preheatJobSnapshotJSON 字段序对齐 _serialize_job_snapshot。
type preheatJobSnapshotJSON struct {
	ID                    string                    `json:"id"`
	Status                string                    `json:"status"`
	Sizes                 []int                     `json:"sizes"`
	Kind                  *string                   `json:"kind"`
	Limit                 int                       `json:"limit"`
	Concurrency           int                       `json:"concurrency"`
	QueueLimit            int                       `json:"queue_limit"`
	IncludeFailed         bool                      `json:"include_failed"`
	Total                 int                       `json:"total"`
	Processed             int                       `json:"processed"`
	Generated             int                       `json:"generated"`
	Cached                int                       `json:"cached"`
	Failed                int                       `json:"failed"`
	Skipped               int                       `json:"skipped"`
	SourceBytesDownloaded int                       `json:"source_bytes_downloaded"`
	DerivativeDurationMS  int                       `json:"derivative_duration_ms"`
	SizeResults           map[string]map[string]int `json:"size_results"`
	Message               *string                   `json:"message"`
	CreatedAt             string                    `json:"created_at"`
	StartedAt             *string                   `json:"started_at"`
	CompletedAt           *string                   `json:"completed_at"`
}

// formatSnapshotTime 对齐 datetime.isoformat():微秒为零时省略小数部分。
func formatSnapshotTime(t time.Time) string {
	t = t.UTC()
	if t.Nanosecond()/1000 == 0 {
		return t.Format("2006-01-02T15:04:05+00:00")
	}
	return t.Format("2006-01-02T15:04:05.000000+00:00")
}

// parseSnapshotTime 对齐 _parse_snapshot_datetime:非字符串或解析失败为 nil。
func parseSnapshotTime(value any) *time.Time {
	text, ok := value.(string)
	if !ok || text == "" {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, text)
	if err != nil {
		return nil
	}
	return &parsed
}

func serializePreheatJob(job *ThumbnailPreheatJob) *preheatJobSnapshotJSON {
	var kind *string
	if job.Kind != nil {
		value := string(*job.Kind)
		kind = &value
	}
	var startedAt, completedAt *string
	if job.StartedAt != nil {
		value := formatSnapshotTime(*job.StartedAt)
		startedAt = &value
	}
	if job.CompletedAt != nil {
		value := formatSnapshotTime(*job.CompletedAt)
		completedAt = &value
	}
	return &preheatJobSnapshotJSON{
		ID:                    job.ID.String(),
		Status:                job.Status,
		Sizes:                 append([]int(nil), job.Sizes...),
		Kind:                  kind,
		Limit:                 job.Limit,
		Concurrency:           job.Concurrency,
		QueueLimit:            job.QueueLimit,
		IncludeFailed:         job.IncludeFailed,
		Total:                 job.Total,
		Processed:             job.Processed,
		Generated:             job.Generated,
		Cached:                job.Cached,
		Failed:                job.Failed,
		Skipped:               job.Skipped,
		SourceBytesDownloaded: job.SourceBytesDownloaded,
		DerivativeDurationMS:  job.DerivativeDurationMS,
		SizeResults:           job.SizeResults,
		Message:               job.Message,
		CreatedAt:             formatSnapshotTime(job.CreatedAt),
		StartedAt:             startedAt,
		CompletedAt:           completedAt,
	}
}

func preheatHistoryPath(settings *config.Settings) string {
	return filepath.Join(settings.MediaRoot, PreheatHistoryFilename)
}

// intOf 快照整数宽容解析(Python int() 接受数字与数字字符串)。
func intOf(value any, fallback int) int {
	switch typed := value.(type) {
	case nil:
		return fallback
	case float64:
		return int(typed)
	case int:
		return typed
	case int64:
		return int(typed)
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil {
			return fallback
		}
		return int(parsed)
	case string:
		var parsed int
		if _, err := fmt.Sscanf(strings.TrimSpace(typed), "%d", &parsed); err != nil {
			return fallback
		}
		return parsed
	case bool:
		if typed {
			return 1
		}
		return 0
	default:
		return fallback
	}
}

func boolOf(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		// 对齐 Python bool(str):非空字符串即真。
		return typed != ""
	case float64:
		return typed != 0
	default:
		return false
	}
}

// jobFromSnapshot 对齐 _job_from_snapshot:非法快照返回 nil。
func jobFromSnapshot(raw any) *ThumbnailPreheatJob {
	snapshot, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	idValue, present := snapshot["id"]
	if !present {
		return nil
	}
	idText, ok := idValue.(string)
	if !ok {
		return nil
	}
	id, err := uuid.Parse(idText)
	if err != nil {
		return nil
	}

	var sizes []int
	if rawSizes, exists := snapshot["sizes"]; exists && rawSizes != nil {
		list, ok := rawSizes.([]any)
		if !ok {
			return nil
		}
		for _, item := range list {
			number, ok := item.(float64)
			if !ok {
				return nil
			}
			sizes = append(sizes, int(number))
		}
	}

	var kind *models.MemoryKind
	if rawKind, exists := snapshot["kind"]; exists && rawKind != nil {
		kindText, ok := rawKind.(string)
		if !ok {
			return nil
		}
		value := models.MemoryKind(kindText)
		if value != models.MemoryKindPhoto && value != models.MemoryKindVideo {
			return nil
		}
		kind = &value
	}

	job := newThumbnailPreheatJob(id, sizes, kind,
		intOf(snapshot["limit"], 0),
		intOf(snapshot["concurrency"], 1),
		intOf(snapshot["queue_limit"], 0),
		boolOf(snapshot["include_failed"]))
	if job.Concurrency < 1 {
		job.Concurrency = 1
	}
	if job.QueueLimit < 0 {
		job.QueueLimit = 0
	}
	if job.Limit < 0 {
		job.Limit = 0
	}

	status := PreheatJobCompleted
	if rawStatus, ok := snapshot["status"].(string); ok && rawStatus != "" {
		status = rawStatus
	}
	originalStatus := status
	// 重启前仍非终态的任务按失败收尾:执行体已随进程消失。
	if status != PreheatJobCompleted && status != PreheatJobCancelled && status != PreheatJobFailed {
		status = PreheatJobFailed
	}
	job.Status = status
	if originalStatus == PreheatJobQueued || originalStatus == PreheatJobRunning {
		message := "服务重启，任务中断"
		job.Message = &message
	}

	job.Total = maxInt(0, intOf(snapshot["total"], 0))
	job.Processed = maxInt(0, intOf(snapshot["processed"], 0))
	job.Generated = maxInt(0, intOf(snapshot["generated"], 0))
	job.Cached = maxInt(0, intOf(snapshot["cached"], 0))
	job.Failed = maxInt(0, intOf(snapshot["failed"], 0))
	job.Skipped = maxInt(0, intOf(snapshot["skipped"], 0))
	job.SourceBytesDownloaded = maxInt(0, intOf(snapshot["source_bytes_downloaded"], 0))
	job.DerivativeDurationMS = maxInt(0, intOf(snapshot["derivative_duration_ms"], 0))

	if rawResults, ok := snapshot["size_results"].(map[string]any); ok {
		for key, value := range rawResults {
			counts, ok := value.(map[string]any)
			if !ok {
				continue
			}
			job.SizeResults[key] = map[string]int{
				"generated": intOf(counts["generated"], 0),
				"cached":    intOf(counts["cached"], 0),
				"failed":    intOf(counts["failed"], 0),
				"skipped":   intOf(counts["skipped"], 0),
			}
		}
	}
	if job.Message == nil {
		if rawMessage, exists := snapshot["message"]; exists && rawMessage != nil {
			if text, ok := rawMessage.(string); ok {
				job.Message = &text
			}
		}
	}
	if parsed := parseSnapshotTime(snapshot["created_at"]); parsed != nil {
		job.CreatedAt = *parsed
	}
	job.StartedAt = parseSnapshotTime(snapshot["started_at"])
	job.CompletedAt = parseSnapshotTime(snapshot["completed_at"])
	return job
}

// PersistPreheatHistory 任务终态时原子落盘最近 N 条摘要;纯诊断数据,
// 存储失败静默放弃。settings 为 nil 时直接返回(对齐 Python)。
func PersistPreheatHistory(job *ThumbnailPreheatJob, settings *config.Settings) {
	if settings == nil || job == nil {
		return
	}
	path := preheatHistoryPath(settings)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		slog.Debug("preheat history persistence failed", "error", err)
		return
	}

	entries := make([]any, 0, MaxPreheatJobHistory+1)
	if data, err := os.ReadFile(path); err == nil {
		var parsed []any
		if json.Unmarshal(data, &parsed) == nil {
			for _, item := range parsed {
				if m, ok := item.(map[string]any); ok {
					entries = append(entries, m)
				}
			}
		}
	}
	jobID := job.ID.String()
	kept := make([]any, 0, len(entries)+1)
	for _, entry := range entries {
		if id, _ := entry.(map[string]any)["id"].(string); id != jobID {
			kept = append(kept, entry)
		}
	}
	kept = append(kept, snapshotToOrderedMap(job))
	if len(kept) > MaxPreheatJobHistory {
		kept = kept[len(kept)-MaxPreheatJobHistory:]
	}

	data := marshalIndentNoEscape(kept)
	if data == nil {
		return
	}
	temporaryPath := filepath.Join(filepath.Dir(path),
		fmt.Sprintf(".%s.%d.tmp", filepath.Base(path), os.Getpid()))
	if err := os.WriteFile(temporaryPath, data, 0o644); err != nil {
		slog.Debug("preheat history persistence failed", "error", err)
		return
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		_ = os.Remove(temporaryPath)
		slog.Debug("preheat history persistence failed", "error", err)
	}
}

// snapshotToOrderedMap 保持键序与 Python _serialize_job_snapshot 一致。
func snapshotToOrderedMap(job *ThumbnailPreheatJob) *orderedSnapshotMap {
	return &orderedSnapshotMap{job: serializePreheatJob(job)}
}

// orderedSnapshotMap 以结构体字段序序列化(Go map 会按键重排)。
type orderedSnapshotMap struct{ job *preheatJobSnapshotJSON }

// MarshalJSON 直接透出结构体序列化结果,使其可嵌入 []map[string]any。
func (m *orderedSnapshotMap) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(m.job); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func marshalIndentNoEscape(v any) []byte {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(v); err != nil {
		return nil
	}
	return buf.Bytes()
}

// persistJob 快照当前任务并落盘。
func (r *ThumbnailPreheatRegistry) persistJob(jobID uuid.UUID, settings *config.Settings) {
	if settings == nil {
		return
	}
	PersistPreheatHistory(r.Snapshot(jobID), settings)
}

// RestorePreheatHistoryFromDisk 进程启动时把磁盘历史装回注册表;
// 损坏文件按空历史处理。
func RestorePreheatHistoryFromDisk(registry *ThumbnailPreheatRegistry, settings *config.Settings) {
	if registry == nil || settings == nil {
		return
	}
	data, err := os.ReadFile(preheatHistoryPath(settings))
	if err != nil {
		return
	}
	var parsed []any
	if json.Unmarshal(data, &parsed) != nil {
		return
	}
	var jobs []*ThumbnailPreheatJob
	for _, item := range parsed {
		if job := jobFromSnapshot(item); job != nil {
			jobs = append(jobs, job)
		}
	}
	if len(jobs) > 0 {
		registry.RestoreHistory(jobs)
	}
}

// ---- 候选枚举 ----

// sortedPermanentKinds 永久失败种类(NOT IN 列表,排序保证确定性)。
func sortedPermanentKinds() []string {
	kinds := make([]string, 0, len(repo.PermanentThumbnailFailureKinds))
	for kind := range repo.PermanentThumbnailFailureKinds {
		kinds = append(kinds, kind)
	}
	sort.Strings(kinds)
	return kinds
}

// candidateWhere 共享候选过滤(枚举与计数同一口径)。预热只为公开访客
// 会看到的资源做远端下载;永久失败类型显式排除;transient 失败在冷却
// 窗口内不再入选(include_failed 是管理端的逃生通道)。
// 谓词统一经由导出的 repo.SQLCond 组装,公开口径单一来源。
func candidateWhere(b *repo.SQLCond, derivativeVersion string, kind *models.MemoryKind, sizes []int, includeFailed bool, cooldownSeconds int) string {
	selectedSizes := dedupeInts(sizes)
	if len(selectedSizes) == 0 {
		selectedSizes = []int{repo.HomePreheatSize}
	}
	missingConditions := make([]string, 0, len(selectedSizes))
	for _, maxSize := range selectedSizes {
		missingConditions = append(missingConditions,
			"NOT "+b.HomeDerivativeReadyCondition(derivativeVersion, maxSize))
	}

	permanent := sortedPermanentKinds()
	permanentPlaceholders := make([]string, len(permanent))
	for i, kindValue := range permanent {
		permanentPlaceholders[i] = b.Placeholder(kindValue)
	}

	where := `m.status = ` + b.Placeholder(models.MemoryStatusPublished) +
		` AND f.source = ` + b.Placeholder("baidupan") +
		` AND f.remote_id IS NOT NULL` +
		` AND ` + b.PublicFilesCondition() +
		` AND (f.thumbnail_failure_kind IS NULL OR f.thumbnail_failure_kind NOT IN (` +
		strings.Join(permanentPlaceholders, ",") + `))` +
		` AND (` + strings.Join(missingConditions, " OR ") + `)`

	if !includeFailed && cooldownSeconds > 0 {
		cutoff := time.Now().UTC().Add(-time.Duration(cooldownSeconds) * time.Second)
		where += ` AND NOT (f.thumbnail_state = ` + b.Placeholder(models.RemoteThumbnailStateRetryable) +
			` AND f.updated_at IS NOT NULL AND f.updated_at >= ` + b.Placeholder(cutoff) + `)`
	}
	if kind != nil {
		where += ` AND m.kind = ` + b.Placeholder(*kind)
	}
	return where
}

// PreheatPair 候选 (memory_id, file_id) 对。
type PreheatPair struct {
	MemoryID uuid.UUID
	FileID   uuid.UUID
}

// CandidatePairs 枚举候选:每 memory 只取排序最前的文件,limit>0 截断。
func CandidatePairs(ctx context.Context, pool *pgxpool.Pool, settings *config.Settings, kind *models.MemoryKind, limit int, sizes []int, includeFailed bool) ([]PreheatPair, error) {
	b := repo.NewSQLCond()
	where := candidateWhere(b, settings.MediaDerivativeVersion, kind, sizes, includeFailed, settings.PreheatRetryCooldownSec)
	rows, err := pool.Query(ctx,
		`SELECT m.id, f.id FROM memories m JOIN memory_files f ON f.memory_id = m.id
		 WHERE `+where+
			` ORDER BY m.captured_at DESC NULLS LAST, m.updated_at DESC, m.id DESC, f.id`,
		b.Args()...)
	if err != nil {
		return nil, fmt.Errorf("枚举预热候选失败: %w", err)
	}
	defer rows.Close()

	var pairs []PreheatPair
	seenMemories := make(map[uuid.UUID]bool)
	for rows.Next() {
		var memoryID, fileID uuid.UUID
		if err := rows.Scan(&memoryID, &fileID); err != nil {
			return nil, fmt.Errorf("扫描预热候选失败: %w", err)
		}
		if seenMemories[memoryID] {
			continue
		}
		seenMemories[memoryID] = true
		pairs = append(pairs, PreheatPair{MemoryID: memoryID, FileID: fileID})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历预热候选失败: %w", err)
	}
	if limit > 0 && len(pairs) > limit {
		pairs = pairs[:limit]
	}
	return pairs, nil
}

// CountPreheatCandidates 统计一次预热将触及的去重 memory 数(预览 UI)。
func CountPreheatCandidates(ctx context.Context, pool *pgxpool.Pool, settings *config.Settings, kind *models.MemoryKind, sizes []int, includeFailed bool) (int, error) {
	b := repo.NewSQLCond()
	where := candidateWhere(b, settings.MediaDerivativeVersion, kind, sizes, includeFailed, settings.PreheatRetryCooldownSec)
	count := 0
	if err := pool.QueryRow(ctx,
		`SELECT count(DISTINCT m.id) FROM memories m JOIN memory_files f ON f.memory_id = m.id WHERE `+where,
		b.Args()...,
	).Scan(&count); err != nil {
		return 0, fmt.Errorf("统计预热候选失败: %w", err)
	}
	return count, nil
}

// IsHomePreheatJob 任务是否只预热首页尺寸。
func IsHomePreheatJob(job *ThumbnailPreheatJob) bool {
	return job != nil && len(job.Sizes) == 1 && job.Sizes[0] == repo.HomePreheatSize
}

// CollectPublicPreheatStatus 聚合公开预热状态;聚合失败降级为 unavailable,
// 公开端点保持 200 而非 500。计数口径与 system_status.go 的公开计数
// 一致(public_files_condition + home_derivative_ready),此处自带错误
// 传播以便降级。
func CollectPublicPreheatStatus(ctx context.Context, pool *pgxpool.Pool, settings *config.Settings, latestJob *ThumbnailPreheatJob) PublicPreheatStatus {
	countPublic := func(withHomeReady bool) (int, error) {
		b := repo.NewSQLCond()
		sql := "SELECT count(DISTINCT m.id) FROM memory_files f" +
			" JOIN memories m ON f.memory_id = m.id" +
			" WHERE " + publicCountBase(b)
		if withHomeReady {
			sql += " AND " + b.HomeDerivativeReadyCondition(settings.MediaDerivativeVersion, repo.HomePreheatSize)
		}
		return countDistinctMemories(ctx, pool, sql, b.Args())
	}

	total, err := countPublic(false)
	var cacheHits int
	if err == nil {
		cacheHits, err = countPublic(true)
	}
	if err != nil {
		slog.Error("public preheat status aggregation failed", "error", err)
		return PublicPreheatStatus{Status: "unavailable", Processed: 0, Total: 0}
	}

	if IsHomePreheatJob(latestJob) &&
		(latestJob.Status == PreheatJobQueued || latestJob.Status == PreheatJobRunning) {
		processed := maxInt(0, latestJob.Processed)
		// total 与 processed 同源(job 自身枚举数),避免与公开计数口径错位。
		return PublicPreheatStatus{
			Status:    "running",
			Processed: processed,
			Total:     maxInt(0, latestJob.Total),
		}
	}

	isReady := total == 0 || cacheHits >= total
	isDegraded := false
	if IsHomePreheatJob(latestJob) {
		if latestJob.Status == PreheatJobCancelled || latestJob.Status == PreheatJobFailed {
			isDegraded = true
		} else if latestJob.Status == PreheatJobCompleted && latestJob.Failed > 0 {
			isDegraded = true
		}
	}
	status := "not_preheated"
	if isReady {
		status = "ready"
	} else if isDegraded {
		status = "degraded"
	}
	processed := cacheHits
	if isReady {
		processed = total
	}
	return PublicPreheatStatus{Status: status, Processed: processed, Total: total}
}

// ---- 候选处理 ----

func allFailedOutcomes(sizes []int) map[int]string {
	outcomes := make(map[int]string, len(sizes))
	for _, size := range sizes {
		outcomes[size] = "failed"
	}
	return outcomes
}

func allCancelledOutcomes(sizes []int) map[int]string {
	outcomes := make(map[int]string, len(sizes))
	for _, size := range sizes {
		outcomes[size] = "cancelled"
	}
	return outcomes
}

func allSkippedOutcomes(sizes []int) map[int]string {
	outcomes := make(map[int]string, len(sizes))
	for _, size := range sizes {
		outcomes[size] = "skipped"
	}
	return outcomes
}

func anyOutcome(outcomes map[int]string, target string) bool {
	for _, outcome := range outcomes {
		if outcome == target {
			return true
		}
	}
	return false
}

func allOutcomesFailed(outcomes map[int]string) bool {
	if len(outcomes) == 0 {
		return false
	}
	for _, outcome := range outcomes {
		if outcome != "failed" {
			return false
		}
	}
	return true
}

func intPtr(value int) *int { return &value }

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// setDerivativeCacheState 对齐 _set_derivative_cache_state:按
// (memory_file, max_size, version) upsert 缓存行,READY 回填产物大小。
func setDerivativeCacheState(
	ctx context.Context,
	q dbtx,
	settings *config.Settings,
	memoryFileID uuid.UUID,
	maxSize int,
	status models.DerivativeCacheStatus,
	outputPath string,
	failureKind *string,
	sourceBytes *int,
	durationMS *int,
) error {
	mediaRoot, err := filepath.Abs(settings.MediaRoot)
	if err != nil {
		return fmt.Errorf("解析 media_root 失败: %w", err)
	}
	relativeOutputPath := ""
	haveRelative := false
	if outputPath != "" {
		absolute := outputPath
		if !filepath.IsAbs(absolute) {
			absolute = filepath.Join(mediaRoot, absolute)
		}
		absolute = filepath.Clean(absolute)
		rel, relErr := filepath.Rel(mediaRoot, absolute)
		if relErr != nil {
			return fmt.Errorf("计算相对路径失败: %w", relErr)
		}
		relativeOutputPath = filepath.ToSlash(rel)
		haveRelative = true
	}

	var cacheID uuid.UUID
	var existingOutputBytes *int
	scanErr := q.QueryRow(ctx,
		`SELECT id, output_bytes FROM memory_derivative_caches
		 WHERE memory_file_id = $1 AND max_size = $2 AND derivative_version = $3`,
		memoryFileID, maxSize, settings.MediaDerivativeVersion,
	).Scan(&cacheID, &existingOutputBytes)

	isReady := status == models.DerivativeCacheStatusReady
	var outputBytes *int
	var outputPathPtr *string
	var failureKindPtr *string
	if isReady {
		failureKindPtr = nil
		if haveRelative {
			outputPathPtr = &relativeOutputPath
			info, statErr := os.Stat(outputPath)
			if statErr != nil {
				return fmt.Errorf("统计派生产物失败: %w", statErr)
			}
			size := int(info.Size())
			outputBytes = &size
		}
	} else {
		outputBytes = existingOutputBytes
		failureKindPtr = failureKind
	}

	if errors.Is(scanErr, pgx.ErrNoRows) {
		if _, err := q.Exec(ctx,
			`INSERT INTO memory_derivative_caches (id, memory_file_id, max_size, derivative_version,
			 status, failure_kind, output_path, output_bytes, source_bytes, duration_ms)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			uuid.New(), memoryFileID, maxSize, settings.MediaDerivativeVersion,
			status, failureKindPtr, outputPathPtr, outputBytes, sourceBytes, durationMS,
		); err != nil {
			return fmt.Errorf("创建派生缓存失败: %w", err)
		}
		return nil
	}
	if scanErr != nil {
		return fmt.Errorf("查询派生缓存失败: %w", scanErr)
	}
	if _, err := q.Exec(ctx,
		`UPDATE memory_derivative_caches SET status = $2, failure_kind = $3, output_path = $4,
		 output_bytes = $5, source_bytes = $6, duration_ms = $7, updated_at = now()
		 WHERE id = $1`,
		cacheID, status, failureKindPtr, outputPathPtr, outputBytes, sourceBytes, durationMS,
	); err != nil {
		return fmt.Errorf("更新派生缓存失败: %w", err)
	}
	return nil
}

// sourceLimitKindForMime 对齐下载超限的失败种类(moov 只对 quicktime)。
func sourceLimitKindForMime(isQuicktime bool) models.DerivativeFailureKind {
	if isQuicktime {
		return models.DerivativeFailureMovMoov
	}
	return models.DerivativeFailureSourceTruncated
}

// shouldResumeDownload 断点续传条件:已有进度、未取消、未超时、仍有额度。
func shouldResumeDownload(cancelCtx context.Context, deadline time.Time, resumeAttempts int, written int64) bool {
	return written > 0 && resumeAttempts < 2 &&
		(cancelCtx == nil || cancelCtx.Err() == nil) &&
		time.Now().Before(deadline)
}

// downloadRemoteSource 对齐 _download_remote_source:流式下载 + Range
// 断点续传(上限 2 次,重开前失效旧直链)。失败种类写入 failure_sink,
// 不以上抛表达;返回 (临时文件路径, 已写字节数, 上下文级错误)。
func downloadRemoteSource(
	ctx context.Context,
	client *BaiduPanClient,
	remoteID string,
	mediaRoot string,
	memory *models.Memory,
	file *models.MemoryFile,
	settings *config.Settings,
	failureSink map[string]string,
	cancelCtx context.Context,
) (*string, int, error) {
	temporaryDir := filepath.Join(mediaRoot, "tmp")
	if err := os.MkdirAll(temporaryDir, 0o755); err != nil {
		return nil, 0, fmt.Errorf("创建临时目录失败: %w", err)
	}
	temporaryPath := filepath.Join(temporaryDir,
		fmt.Sprintf("%s.%s.source.tmp", memory.ID, uuid.NewString()))
	var maxSourceBytes int64
	if memory.Kind == models.MemoryKindVideo {
		maxSourceBytes = settings.RemoteThumbnailVideoSourceMaxBytes
	} else {
		maxSourceBytes = settings.RemoteThumbnailSourceMaxBytes
	}
	// 单次下载的整体总时限:connect/read 超时之外兜底慢流,跨续传共享。
	deadline := time.Now().Add(time.Duration(settings.SourceDownloadTimeoutSec * float64(time.Second)))

	written := int64(0)
	registered := false
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(temporaryPath)
		}
		if registered {
			UnregisterTemporaryPath(absPath(temporaryPath))
		}
	}()

	if !temporaryDirectoryHasCapacity(settings, temporaryDir) {
		setFailureKind(failureSink, models.DerivativeFailureDiskQuota)
		return nil, 0, nil
	}

	resumeAttempts := 0
	for {
		rangeHeader := ""
		if written > 0 {
			rangeHeader = fmt.Sprintf("bytes=%d-", written)
		}
		status, contentLength, _, _, body, err := client.OpenStream(ctx, remoteID, rangeHeader)
		if err != nil {
			if shouldResumeDownload(cancelCtx, deadline, resumeAttempts, written) {
				resumeAttempts++
				client.InvalidateDownloadURL(remoteID)
				continue
			}
			setFailureKind(failureSink, classifyRemoteError(err))
			return nil, int(written), nil
		}
		if status >= 400 {
			closeAndDrain(body)
			setFailureKind(failureSink, models.DerivativeFailureRemoteUnavail)
			return nil, int(written), nil
		}
		if written > 0 && status != 206 {
			// 续传必须命中 206:服务器忽略 Range 会把整文件重发,追加写
			// 会产生损坏文件。
			closeAndDrain(body)
			setFailureKind(failureSink, models.DerivativeFailureRemoteUnavail)
			return nil, int(written), nil
		}
		remainingBudget := maxSourceBytes - written
		if contentLength != nil && *contentLength > remainingBudget {
			closeAndDrain(body)
			setFailureKind(failureSink, sourceLimitKindForMime(file.MimeType == "video/quicktime"))
			return nil, int(written), nil
		}

		if !registered {
			RegisterTemporaryPath(absPath(temporaryPath))
			registered = true
		}

		flags := os.O_WRONLY | os.O_CREATE
		if written > 0 {
			flags |= os.O_APPEND
		} else {
			flags |= os.O_TRUNC
		}
		output, openErr := os.OpenFile(temporaryPath, flags, 0o644)
		if openErr != nil {
			closeAndDrain(body)
			if shouldResumeDownload(cancelCtx, deadline, resumeAttempts, written) {
				resumeAttempts++
				client.InvalidateDownloadURL(remoteID)
				continue
			}
			setFailureKind(failureSink, classifyRemoteError(openErr))
			return nil, int(written), nil
		}

		terminal := false
		var streamErr error
		buf := make([]byte, 64*1024)
		for {
			if cancelCtx != nil && cancelCtx.Err() != nil {
				setFailureKind(failureSink, models.DerivativeFailureCancelled)
				terminal = true
				break
			}
			if time.Now().After(deadline) {
				setFailureKind(failureSink, models.DerivativeFailureTimeout)
				terminal = true
				break
			}
			n, readErr := body.Read(buf)
			if n > 0 {
				if _, writeErr := output.Write(buf[:n]); writeErr != nil {
					streamErr = writeErr
					break
				}
				written += int64(n)
				if written >= maxSourceBytes {
					setFailureKind(failureSink, sourceLimitKindForMime(file.MimeType == "video/quicktime"))
					terminal = true
					break
				}
			}
			if readErr == io.EOF {
				break
			}
			if readErr != nil {
				streamErr = readErr
				break
			}
		}
		_ = output.Close()
		closeAndDrain(body)
		if terminal {
			return nil, int(written), nil
		}
		if streamErr != nil {
			if shouldResumeDownload(cancelCtx, deadline, resumeAttempts, written) {
				resumeAttempts++
				client.InvalidateDownloadURL(remoteID)
				continue
			}
			setFailureKind(failureSink, classifyRemoteError(streamErr))
			return nil, int(written), nil
		}

		info, statErr := os.Stat(temporaryPath)
		if statErr != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			setFailureKind(failureSink, models.DerivativeFailureTemporaryEmpty)
			return nil, int(written), nil
		}
		cleanup = false
		return &temporaryPath, int(written), nil
	}
}

// preheatWorkerClient 每个 worker goroutine 惰性共享一个远端客户端
// (对齐 Python 线程本地客户端);remote_auth 自愈时 reset。
type preheatWorkerClient struct {
	mu     sync.Mutex
	client *BaiduPanClient
}

func (h *preheatWorkerClient) provider(settings *config.Settings) func() (*BaiduPanClient, error) {
	return func() (*BaiduPanClient, error) {
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.client == nil {
			client, err := NewBaiduPanClient(settings)
			if err != nil {
				return nil, err
			}
			h.client = client
		}
		return h.client, nil
	}
}

func (h *preheatWorkerClient) reset() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.client = nil
}

// processPairSizes 对齐 _process_pair_sizes:对账已产出尺寸 → 必要时
// 下载远端源 → 批量派生缺失尺寸 → 回写缓存行与文件状态。全程单事务。
func processPairSizes(
	ctx context.Context,
	pool *pgxpool.Pool,
	settings *config.Settings,
	derivatives *DerivativeTasks,
	memoryID, memoryFileID uuid.UUID,
	sizes []int,
	cancelCtx context.Context,
	clientProvider func() (*BaiduPanClient, error),
) (*PreheatCandidateResult, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("开启候选事务失败: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	memory, err := loadMemoryByID(ctx, tx, memoryID)
	if err != nil {
		return nil, err
	}
	file, err := loadMemoryFileByID(ctx, tx, memoryFileID)
	if err != nil {
		return nil, err
	}
	if memory == nil || file == nil || file.RemoteID == nil || *file.RemoteID == "" {
		return &PreheatCandidateResult{
			Outcomes:    allFailedOutcomes(sizes),
			FailureKind: "unknown",
		}, nil
	}
	if cancelCtx != nil && cancelCtx.Err() != nil {
		return &PreheatCandidateResult{
			Outcomes:    allCancelledOutcomes(sizes),
			FailureKind: string(models.DerivativeFailureCancelled),
		}, nil
	}

	mediaRoot, err := filepath.Abs(settings.MediaRoot)
	if err != nil {
		return nil, fmt.Errorf("解析 media_root 失败: %w", err)
	}
	outcomes := make(map[int]string, len(sizes))
	failureKind := ""
	sourceBytesDownloaded := 0
	derivativeDurationMS := 0
	memoryThumbnailChanged := false

	// 本地源文件先解析一次:对账行回填真实 source_bytes,避免 0 失真。
	sourcePath := ResolveMediaPath(mediaRoot, file.SourcePath)
	if sourcePath != nil {
		info, statErr := os.Stat(*sourcePath)
		if statErr != nil || !info.Mode().IsRegular() {
			sourcePath = nil
		}
	}
	localSourceBytes := 0
	if sourcePath != nil {
		if info, statErr := os.Stat(*sourcePath); statErr == nil {
			localSourceBytes = int(info.Size())
		}
	}

	// Reconcile files already produced by an earlier run before touching
	// Baidu: 旧 worker 可能已写盘但在记录状态前被杀。
	for _, maxSize := range sizes {
		targetPath := DerivativeCachePath(mediaRoot, memory.ID, maxSize, settings.MediaDerivativeVersion)
		if !fileExists(targetPath) {
			continue
		}
		if err := setDerivativeCacheState(ctx, tx, settings, memoryFileID, maxSize,
			models.DerivativeCacheStatusReady, targetPath, nil,
			intPtr(localSourceBytes), intPtr(0)); err != nil {
			return nil, err
		}
		outcomes[maxSize] = "cached"
		// 首页缩略图只认 240:detail 预热不得回填 thumbnail_path。
		if maxSize == repo.HomePreheatSize {
			rel, relErr := filepath.Rel(mediaRoot, targetPath)
			if relErr != nil {
				return nil, fmt.Errorf("计算相对路径失败: %w", relErr)
			}
			posix := filepath.ToSlash(rel)
			memory.ThumbnailPath = &posix
			memoryThumbnailChanged = true
		}
	}

	if len(outcomes) == len(sizes) {
		file.ThumbnailState = models.RemoteThumbnailStateReady
		file.ThumbnailFailureKind = nil
		if err := persistMemoryFile(ctx, tx, file); err != nil {
			return nil, err
		}
		if memoryThumbnailChanged {
			if err := persistMemoryThumbnailPath(ctx, tx, memory); err != nil {
				return nil, err
			}
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("提交对账事务失败: %w", err)
		}
		committed = true
		return &PreheatCandidateResult{Outcomes: outcomes}, nil
	}

	downloadedRemoteSource := ""
	if sourcePath == nil {
		if clientProvider == nil {
			return nil, errors.New("远端客户端不可用")
		}
		remoteClient, clientErr := clientProvider()
		if clientErr != nil {
			return nil, clientErr
		}
		remoteFailureSink := map[string]string{}
		downloadedPath, downloadedBytes, downloadErr := downloadRemoteSource(
			ctx, remoteClient, *file.RemoteID, mediaRoot, memory, file, settings,
			remoteFailureSink, cancelCtx)
		sourceBytesDownloaded = downloadedBytes
		if downloadErr != nil {
			return nil, downloadErr
		}
		failureKind = remoteFailureSink["kind"]
		if downloadedPath == nil {
			// 临时目录容量不足是环境问题,不是文件本身不可用:记 skipped
			// 并保留原状态,避免 retryable 冷却把全部候选挡在下一轮之外。
			if failureKind == string(models.DerivativeFailureDiskQuota) {
				return &PreheatCandidateResult{
					Outcomes:              allSkippedOutcomes(sizes),
					SourceBytesDownloaded: sourceBytesDownloaded,
					FailureKind:           failureKind,
				}, nil
			}
			file.ThumbnailState = repo.ClassifyThumbnailFailureState(strPtrOrNil(failureKind))
			if failureKind != "" {
				file.ThumbnailFailureKind = &failureKind
			} else {
				file.ThumbnailFailureKind = ptrString("unknown")
			}
			if err := persistMemoryFile(ctx, tx, file); err != nil {
				return nil, err
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, fmt.Errorf("提交下载失败状态失败: %w", err)
			}
			committed = true
			resultKind := failureKind
			if resultKind == "" {
				resultKind = "unknown"
			}
			return &PreheatCandidateResult{
				Outcomes:              allFailedOutcomes(sizes),
				SourceBytesDownloaded: sourceBytesDownloaded,
				FailureKind:           resultKind,
			}, nil
		}
		downloadedRemoteSource = *downloadedPath
		// 远程源下载后,派生必须使用本地临时文件(Python 版把下载路径
		// 重新赋给 source_path)。遗漏此步会导致后续 *sourcePath 空指针
		// panic,预热任务连同进程一起中断。
		sourcePath = downloadedPath
		RegisterTemporaryPath(absPath(downloadedRemoteSource))
		defer func() {
			_ = os.Remove(downloadedRemoteSource)
			UnregisterTemporaryPath(absPath(downloadedRemoteSource))
		}()
	}

	var missingSizes []int
	for _, maxSize := range sizes {
		if _, done := outcomes[maxSize]; done {
			continue
		}
		targetPath := DerivativeCachePath(mediaRoot, memory.ID, maxSize, settings.MediaDerivativeVersion)
		if fileExists(targetPath) {
			if err := setDerivativeCacheState(ctx, tx, settings, memoryFileID, maxSize,
				models.DerivativeCacheStatusReady, targetPath, nil,
				intPtr(localSourceBytes), intPtr(0)); err != nil {
				return nil, err
			}
			outcomes[maxSize] = "cached"
			continue
		}
		missingSizes = append(missingSizes, maxSize)
	}

	// 批量派生:缺失尺寸共用一次 DERIVATIVE 槽位,照片单次解码、
	// WebP/视频单次 ffmpeg 多输出;单尺寸缺失场景仍走原单尺寸路径。
	generatedPaths := make(map[int]*string, len(missingSizes))
	sink := map[string]string{}
	durationMS := 0
	if len(missingSizes) > 0 {
		if cancelCtx != nil && cancelCtx.Err() != nil {
			// 取消:不触碰派生执行体;per-size 循环按 sink 种类记失败
			//(对齐 Python 取消分支的 failure_sink 语义)。
			sink = map[string]string{"kind": string(models.DerivativeFailureCancelled)}
			for _, maxSize := range missingSizes {
				generatedPaths[maxSize] = nil
			}
		} else {
			sink = map[string]string{}
			startedAt := time.Now()
			if len(missingSizes) == 1 {
				generated, deriveErr := derivatives.RunLocalDerivative(
					ctx, *sourcePath, mediaRoot, memory, missingSizes[0], intPtr(60), sink)
				if deriveErr != nil {
					var rejected *TaskRejected
					var cancelled *TaskCancelled
					switch {
					case errors.As(deriveErr, &cancelled):
						derivatives.Governor.Metrics.RecordCancelled(TaskTypeDerivative)
					case errors.As(deriveErr, &rejected):
						derivatives.Governor.Metrics.RecordFailed(TaskTypeDerivative)
						setFailureKind(sink, models.DerivativeFailureQueueRejected)
						generatedPaths[missingSizes[0]] = nil
					default:
						// TaskCancelled 与未知错误上抛,由 processCandidate 分类。
						return nil, deriveErr
					}
				} else {
					generatedPaths[missingSizes[0]] = generated
				}
			} else {
				generatedPaths = derivatives.RunLocalDerivatives(
					ctx, *sourcePath, mediaRoot, memory, missingSizes, intPtr(60), sink)
				// Go 批量路径不区分取消:取消时对齐 Python 上抛语义。
				if cancelCtx.Err() != nil {
					return nil, &TaskCancelled{}
				}
				if sink["kind"] == string(models.DerivativeFailureQueueRejected) {
					derivatives.Governor.Metrics.RecordFailed(TaskTypeDerivative)
				}
			}
			durationMS = int(time.Since(startedAt).Milliseconds())
		}
		derivativeDurationMS += durationMS
	}

	for _, maxSize := range missingSizes {
		generatedPath := generatedPaths[maxSize]
		if generatedPath == nil || *generatedPath == "" {
			failureKind = failureSinkKind(sink)
			if err := setDerivativeCacheState(ctx, tx, settings, memoryFileID, maxSize,
				models.DerivativeCacheStatusFailed, "", strPtrOrNil(failureKind),
				intPtr(localSourceBytes), intPtr(durationMS)); err != nil {
				return nil, err
			}
			outcomes[maxSize] = "failed"
			continue
		}
		outputPath := *generatedPath
		if !filepath.IsAbs(outputPath) {
			outputPath = filepath.Join(mediaRoot, outputPath)
		}
		if err := setDerivativeCacheState(ctx, tx, settings, memoryFileID, maxSize,
			models.DerivativeCacheStatusReady, outputPath, nil,
			intPtr(localSourceBytes), intPtr(durationMS)); err != nil {
			return nil, err
		}
		outcomes[maxSize] = "generated"
		if maxSize == repo.HomePreheatSize {
			memory.ThumbnailPath = generatedPath
			memoryThumbnailChanged = true
		}
	}

	anySuccess := anyOutcome(outcomes, "generated") || anyOutcome(outcomes, "cached")
	if anySuccess {
		file.ThumbnailState = models.RemoteThumbnailStateReady
		file.ThumbnailFailureKind = nil
	} else {
		file.ThumbnailState = repo.ClassifyThumbnailFailureState(strPtrOrNil(failureKind))
		if failureKind != "" {
			file.ThumbnailFailureKind = &failureKind
		} else {
			file.ThumbnailFailureKind = ptrString("unknown")
		}
	}
	if err := persistMemoryFile(ctx, tx, file); err != nil {
		return nil, err
	}
	if memoryThumbnailChanged {
		if err := persistMemoryThumbnailPath(ctx, tx, memory); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("提交候选事务失败: %w", err)
	}
	committed = true

	resultKind := ""
	if allOutcomesFailed(outcomes) {
		resultKind = failureKind
	}
	return &PreheatCandidateResult{
		Outcomes:              outcomes,
		SourceBytesDownloaded: sourceBytesDownloaded,
		DerivativeDurationMS:  derivativeDurationMS,
		FailureKind:           resultKind,
	}, nil
}

// failureSinkKind 读取失败种类(空回退 unknown,对齐 sink.get("kind", "unknown"))。
func failureSinkKind(source map[string]string) string {
	if kind, ok := source["kind"]; ok && kind != "" {
		return kind
	}
	return "unknown"
}

func strPtrOrNil(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// persistMemoryThumbnailPath 仅回写 thumbnail_path(预热不改其余字段)。
func persistMemoryThumbnailPath(ctx context.Context, q dbtx, memory *models.Memory) error {
	_, err := q.Exec(ctx,
		`UPDATE memories SET thumbnail_path = $2, updated_at = now() WHERE id = $1`,
		memory.ID, memory.ThumbnailPath,
	)
	if err != nil {
		return fmt.Errorf("更新 memory 缩略图路径失败: %w", err)
	}
	return nil
}

// markPreheatFailure 对齐 _mark_failure:失败状态不中断整批任务。
func markPreheatFailure(pool *pgxpool.Pool, memoryFileID uuid.UUID, failureKind string) {
	state := repo.ClassifyThumbnailFailureState(&failureKind)
	if _, err := pool.Exec(context.Background(),
		`UPDATE memory_files SET thumbnail_state = $2, thumbnail_failure_kind = $3,
		 updated_at = now() WHERE id = $1`,
		memoryFileID, state, failureKind,
	); err != nil {
		slog.Debug("preheat failure state persistence failed", "error", err)
	}
}

// markUnexpectedCacheFailure 对齐 _mark_unexpected_cache_failure。
func markUnexpectedCacheFailure(pool *pgxpool.Pool, settings *config.Settings, memoryFileID uuid.UUID, sizes []int, failureKind string) {
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return
	}
	for _, maxSize := range sizes {
		if err := setDerivativeCacheState(ctx, tx, settings, memoryFileID, maxSize,
			models.DerivativeCacheStatusFailed, "", &failureKind, nil, nil); err != nil {
			_ = tx.Rollback(ctx)
			return
		}
	}
	_ = tx.Commit(ctx)
}

// processCandidate 对齐 _process_candidate:PREHEAT 槽位内处理候选,
// remote_auth 自愈重试一次,指标与失败状态按结果分类落盘。
func processCandidate(
	pool *pgxpool.Pool,
	settings *config.Settings,
	governor *TaskGovernor,
	derivatives *DerivativeTasks,
	holder *preheatWorkerClient,
	memoryID, memoryFileID uuid.UUID,
	sizes []int,
	cancelCtx context.Context,
) *PreheatCandidateResult {
	attempt := func() (*PreheatCandidateResult, error) {
		_, release, err := governor.Slot(cancelCtx, TaskTypePreheat, 60, nil)
		if err != nil {
			return nil, err
		}
		defer release()
		return processPairSizes(cancelCtx, pool, settings, derivatives,
			memoryID, memoryFileID, sizes, cancelCtx, holder.provider(settings))
	}

	result, err := attempt()
	if err == nil && allOutcomesFailed(result.Outcomes) &&
		result.FailureKind == string(models.DerivativeFailureRemoteAuth) {
		// token 失效自愈:worker 客户端固化了构造时的 access_token 快照,
		// 长预热中途 token 轮换会让该 worker 后续全部 remote_auth 失败。
		// 重置客户端(新客户端构造即自动 refresh)并重试一次;磁盘对账
		// 保证已写尺寸不重复派生。
		holder.reset()
		result, err = attempt()
	}

	if err != nil {
		var cancelled *TaskCancelled
		var rejected *TaskRejected
		switch {
		case errors.As(err, &cancelled):
			governor.Metrics.RecordCancelled(TaskTypePreheat)
			return &PreheatCandidateResult{
				Outcomes:    allCancelledOutcomes(sizes),
				FailureKind: string(models.DerivativeFailureCancelled),
			}
		case errors.As(err, &rejected):
			// 全局 PREHEAT 队列满:本轮跳过,不写失败状态与 FAILED 缓存行,
			// 候选条件基于缓存 NOT-EXISTS,下次预热会自然重选。
			governor.Metrics.RecordRejected(TaskTypePreheat)
			return &PreheatCandidateResult{Outcomes: allSkippedOutcomes(sizes)}
		default:
			slog.Error("thumbnail preheat candidate failed",
				"memory_id", memoryID, "file_id", memoryFileID, "error", err)
			// 先按远端错误分类(凭证/限流/不存在等),再回落到 ffmpeg
			// 等派生错误分类,避免凭证或 ID 问题只落成 unknown。
			kind := classifyRemoteError(err)
			if kind == models.DerivativeFailureUnknown {
				kind = ClassifyDerivativeException(err)
			}
			failureKind := string(kind)
			governor.Metrics.RecordFailed(TaskTypePreheat)
			markPreheatFailure(pool, memoryFileID, failureKind)
			markUnexpectedCacheFailure(pool, settings, memoryFileID, sizes, failureKind)
			return &PreheatCandidateResult{
				Outcomes:    allFailedOutcomes(sizes),
				FailureKind: failureKind,
			}
		}
	}

	switch {
	case allOutcomesFailed(result.Outcomes):
		governor.Metrics.RecordFailed(TaskTypePreheat)
		kind := result.FailureKind
		if kind == "" {
			kind = "unknown"
		}
		markPreheatFailure(pool, memoryFileID, kind)
	case anyOutcome(result.Outcomes, "cancelled"):
		governor.Metrics.RecordCancelled(TaskTypePreheat)
	default:
		governor.Metrics.RecordCompleted(TaskTypePreheat)
	}
	return result
}

// ThumbnailPreheatRunner 携带预热执行所需注入依赖(Pool/Settings/
// Governor/Derivatives 必备;Registry 为空时回退进程默认注册表)。
type ThumbnailPreheatRunner struct {
	Pool        *pgxpool.Pool
	Settings    *config.Settings
	Governor    *TaskGovernor
	Derivatives *DerivativeTasks
	Registry    *ThumbnailPreheatRegistry
}

func (r *ThumbnailPreheatRunner) registry() *ThumbnailPreheatRegistry {
	if r.Registry != nil {
		return r.Registry
	}
	return DefaultThumbnailPreheatRegistry
}

// Run 执行一次预热任务:枚举候选 → worker pool 结算 → 终态落盘历史。
func (r *ThumbnailPreheatRunner) Run(jobID uuid.UUID) {
	registry := r.registry()
	job := registry.Get(jobID)
	if job == nil {
		return
	}
	jobCtx := job.cancelCtx
	if jobCtx == nil {
		jobCtx = context.Background()
	}
	if registry.Cancelled(jobID) {
		registry.MarkCancelled(jobID, nil)
		return
	}

	pairs, err := CandidatePairs(jobCtx, r.Pool, r.Settings, job.Kind, job.Limit, job.Sizes, job.IncludeFailed)
	if err != nil {
		registry.MarkFailed(jobID, err.Error())
		registry.persistJob(jobID, r.Settings)
		return
	}
	registry.MarkRunning(jobID, len(pairs))
	// 枚举可能耗时(大库 × 多尺寸 NOT-EXISTS),期间用户可能已取消:
	// 进入处理循环前补一次取消检查,避免空跑。
	if registry.Cancelled(jobID) {
		registry.MarkCancelled(jobID, ptrString(fmt.Sprintf("processed=0;total=%d", len(pairs))))
		registry.persistJob(jobID, r.Settings)
		return
	}

	// worker pool:每个 worker 惰性持有远端客户端,拉取下一个候选前
	// 检查取消;全局 PREHEAT 槽位由 governor 限制(队列满 → skipped)。
	results := make(chan *PreheatCandidateResult, job.Concurrency*2)
	var next atomic.Int64
	var wg sync.WaitGroup
	for worker := 0; worker < job.Concurrency; worker++ {
		wg.Add(1)
		holder := &preheatWorkerClient{}
		go func() {
			defer wg.Done()
			for {
				if jobCtx.Err() != nil {
					return
				}
				index := int(next.Add(1)) - 1
				if index >= len(pairs) {
					return
				}
				pair := pairs[index]
				result := processCandidate(r.Pool, r.Settings, r.Governor, r.Derivatives,
					holder, pair.MemoryID, pair.FileID, job.Sizes, jobCtx)
				results <- result
			}
		}()
	}
	go func() {
		wg.Wait()
		close(results)
	}()

	cancelled := false
	exhausted := false
	failureKinds := map[string]int{}
	recordFailure := func(result *PreheatCandidateResult) {
		if result != nil && result.FailureKind != "" {
			failureKinds[result.FailureKind]++
		}
	}
	for !cancelled && !exhausted {
		if jobCtx.Err() != nil {
			cancelled = true
			break
		}
		select {
		case result, ok := <-results:
			if !ok {
				exhausted = true
				break
			}
			registry.MarkItemProcessed(jobID, result.Outcomes,
				result.SourceBytesDownloaded, result.DerivativeDurationMS)
			recordFailure(result)
			if anyOutcome(result.Outcomes, "cancelled") {
				cancelled = true
			}
		case <-time.After(200 * time.Millisecond):
			// 顶部的取消检查在下一轮迭代生效(对齐 wait(timeout=0.2))。
		}
	}

	if cancelled {
		// 结算已启动候选(worker 已随取消退出;未启动的不再计数,
		// 对齐 cancel_futures 语义),再按当前计数写取消终态。
		for result := range results {
			registry.MarkItemProcessed(jobID, result.Outcomes,
				result.SourceBytesDownloaded, result.DerivativeDurationMS)
		}
		processed, total, _ := registry.Counters(jobID)
		registry.MarkCancelled(jobID, ptrString(fmt.Sprintf("processed=%d;total=%d", processed, total)))
		registry.persistJob(jobID, r.Settings)
		return
	}

	// 有失败/环境性跳过时把原因写进任务消息,管理页不再只有计数。
	var message *string
	if snapshot := registry.Snapshot(jobID); snapshot != nil &&
		(snapshot.Failed > 0 || len(failureKinds) > 0) {
		reasons := make([]string, 0, len(failureKinds))
		for kind := range failureKinds {
			reasons = append(reasons, kind)
		}
		sort.Strings(reasons)
		if len(reasons) == 0 {
			reasons = []string{"unknown"}
		}
		retry := "check_remote_access_or_rescan"
		switch {
		case failureKinds[string(models.DerivativeFailureDiskQuota)] > 0:
			retry = "clean_tmp_or_raise_disk_quota"
		case failureKinds[string(models.DerivativeFailureRemoteAuth)] > 0:
			retry = "check_baidu_authorization"
		case failureKinds[string(models.DerivativeFailureRemoteNotFound)] > 0:
			retry = "rescan_remote_directory"
		}
		text := fmt.Sprintf("failed=%d;skipped=%d;reason=%s;retry=%s",
			snapshot.Failed, snapshot.Skipped, strings.Join(reasons, ","), retry)
		message = &text
	}
	registry.MarkCompleted(jobID, message)
	registry.persistJob(jobID, r.Settings)
	runtime.GC()
	r.Governor.Metrics.RecordGC(0)
}

// StartAutoPreheatAfterScan 扫描完成后自动预热首页 240 缩略图,消除
// 公开访客首次加载的慢窗口。单飞注册表保证与手动预热互斥:已有任务
// 在跑时静默跳过本次自动触发。
func StartAutoPreheatAfterScan(runner *ThumbnailPreheatRunner) *ThumbnailPreheatJob {
	if runner == nil || !runner.Settings.PreheatAutoAfterScan {
		return nil
	}
	registry := runner.registry()
	job, started := registry.Start(
		[]int{repo.HomePreheatSize},
		nil,
		0,
		runner.Settings.PreheatConcurrencyLimit,
		runner.Settings.PreheatQueueLimit,
		false,
	)
	if !started {
		return nil
	}
	go runner.Run(job.ID)
	return job
}
