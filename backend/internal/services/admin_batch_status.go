// admin_batch_status.go 对齐原 app/services/admin_batch_status.py:
// 后台媒体列表的有界、可恢复批量状态变更任务。
//
// admin_background_jobs / admin_operation_logs 直接用 pgx 写 SQL
// (models.AdminBackgroundJob 已定义列序)。
package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"limedia/backend/internal/config"
	"limedia/backend/internal/models"
)

// AdminBatchStatusSize 每批处理的 memory 数量(对齐 BATCH_SIZE)。
const AdminBatchStatusSize = 100

// rowScanner 显式列扫描接口(pgx.Row/pgx.Rows 共同子集)。
type rowScanner interface{ Scan(dest ...any) error }

// ---- 取消登记表(对齐模块级 _cancel_requested) ----

var (
	batchStatusCancelMu        sync.Mutex
	batchStatusCancelRequested = make(map[uuid.UUID]bool)
)

// RequestBatchStatusCancel 请求取消批量状态任务。
func RequestBatchStatusCancel(jobID uuid.UUID) bool {
	batchStatusCancelMu.Lock()
	defer batchStatusCancelMu.Unlock()
	batchStatusCancelRequested[jobID] = true
	return true
}

// ClearBatchStatusCancel 清除取消标记(任务收尾必调)。
func ClearBatchStatusCancel(jobID uuid.UUID) {
	batchStatusCancelMu.Lock()
	defer batchStatusCancelMu.Unlock()
	delete(batchStatusCancelRequested, jobID)
}

func batchStatusCancelPending(jobID uuid.UUID) bool {
	batchStatusCancelMu.Lock()
	defer batchStatusCancelMu.Unlock()
	return batchStatusCancelRequested[jobID]
}

// ---- 后台任务行访问(两个 admin 后台任务共用) ----

const adminBackgroundJobColumns = `id, action, status, filter_snapshot, resource_ids,
total, processed, changed, skipped, failed, error_message, created_by_session,
created_at, started_at, completed_at`

func scanAdminBackgroundJob(row rowScanner) (*models.AdminBackgroundJob, error) {
	job := &models.AdminBackgroundJob{}
	err := row.Scan(
		&job.ID, &job.Action, &job.Status, &job.FilterSnapshot, &job.ResourceIDs,
		&job.Total, &job.Processed, &job.Changed, &job.Skipped, &job.Failed,
		&job.ErrorMessage, &job.CreatedBySession, &job.CreatedAt,
		&job.StartedAt, &job.CompletedAt,
	)
	if err != nil {
		return nil, err
	}
	return job, nil
}

// getAdminBackgroundJob 主键读取;不存在返回 (nil, nil)。
func getAdminBackgroundJob(ctx context.Context, pool *pgxpool.Pool, jobID uuid.UUID) (*models.AdminBackgroundJob, error) {
	row := pool.QueryRow(ctx,
		"SELECT "+adminBackgroundJobColumns+" FROM admin_background_jobs WHERE id = $1", jobID)
	job, err := scanAdminBackgroundJob(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return job, nil
}

// ---- Python 风格 JSON 序列化(审计日志 detail 契约) ----

// pythonSortedJSON 对齐 json.dumps(payload, ensure_ascii=False, sort_keys=True):
// 键排序、默认分隔符 ", "/": "、非 ASCII 原样保留、数字保真。
func pythonSortedJSON(value any) string {
	return writePythonJSON(value, ", ", ": ")
}

// pythonCompactJSON 对齐 json.dumps(payload, separators=(',', ':'))。
func pythonCompactJSON(value any) string {
	return writePythonJSON(value, ",", ":")
}

func writePythonJSON(value any, itemSep, kvSep string) string {
	var sb strings.Builder
	writePythonValue(&sb, value, itemSep, kvSep)
	return sb.String()
}

func writePythonValue(sb *strings.Builder, value any, itemSep, kvSep string) {
	switch v := value.(type) {
	case nil:
		sb.WriteString("null")
	case bool:
		if v {
			sb.WriteString("true")
		} else {
			sb.WriteString("false")
		}
	case json.Number:
		sb.WriteString(v.String())
	case float64:
		// Python repr 风格最短表示;整值浮点写成整数形式。
		if v == float64(int64(v)) && v < 1e15 && v > -1e15 {
			sb.WriteString(fmt.Sprintf("%d", int64(v)))
		} else {
			sb.WriteString(fmt.Sprintf("%v", v))
		}
	case string:
		writePythonString(sb, v)
	case []any:
		sb.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				sb.WriteString(itemSep)
			}
			writePythonValue(sb, item, itemSep, kvSep)
		}
		sb.WriteByte(']')
	case []string:
		sb.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				sb.WriteString(itemSep)
			}
			writePythonValue(sb, item, itemSep, kvSep)
		}
		sb.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		sb.WriteByte('{')
		for i, key := range keys {
			if i > 0 {
				sb.WriteString(itemSep)
			}
			writePythonString(sb, key)
			sb.WriteString(kvSep)
			writePythonValue(sb, v[key], itemSep, kvSep)
		}
		sb.WriteByte('}')
	default:
		writePythonString(sb, fmt.Sprintf("%v", value))
	}
}

// writePythonString ensure_ascii=False 的转义口径:
// 引号/反斜杠与控制字符转义,其余(含非 ASCII)原样。
func writePythonString(sb *strings.Builder, s string) {
	sb.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			sb.WriteString(`\"`)
		case '\\':
			sb.WriteString(`\\`)
		case '\n':
			sb.WriteString(`\n`)
		case '\r':
			sb.WriteString(`\r`)
		case '\t':
			sb.WriteString(`\t`)
		case '\b':
			sb.WriteString(`\b`)
		case '\f':
			sb.WriteString(`\f`)
		default:
			if r < 0x20 {
				sb.WriteString(fmt.Sprintf(`\u%04x`, r))
			} else {
				sb.WriteRune(r)
			}
		}
	}
	sb.WriteByte('"')
}

// decodeJSONWithNumbers 以 json.Number 保真解析(json 列内容)。
func decodeJSONWithNumbers(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil
	}
	return value
}

// ---- 批量状态任务 ----

// BatchStatusJobDeps 批量任务依赖注入。
type BatchStatusJobDeps struct {
	Pool     *pgxpool.Pool
	Settings *config.Settings
}

// RunBatchStatusJob 执行批量状态变更:分块扫描、失败计数、
// 完成后失效 nginx 缓存并写审计日志(对齐 run_batch_status_job)。
// 异常路径等价 Python except 分支:job 置 failed、error_message 取
// err.Error()、completed_at 落库、写 invalidated=0 的审计日志。
func RunBatchStatusJob(
	ctx context.Context,
	deps *BatchStatusJobDeps,
	jobID uuid.UUID,
	targetStatus models.MemoryStatus,
	operatorSessionID *uuid.UUID,
) {
	pool := deps.Pool
	invalidatedCacheFiles := 0

	job, err := getAdminBackgroundJob(ctx, pool, jobID)
	if err != nil || job == nil {
		return
	}

	if _, err := pool.Exec(ctx,
		`UPDATE admin_background_jobs SET status = 'running', started_at = $1 WHERE id = $2`,
		time.Now().UTC(), jobID); err != nil {
		return
	}

	defer ClearBatchStatusCancel(jobID)

	// 异常收尾:置 failed、写审计日志(对齐 except 分支)。
	finishFailed := func(errText string) {
		_, _ = pool.Exec(ctx,
			`UPDATE admin_background_jobs SET status = 'failed', error_message = $1,
			 completed_at = $2 WHERE id = $3`,
			errText, time.Now().UTC(), jobID)
		if fresh, err := getAdminBackgroundJob(ctx, pool, jobID); err == nil && fresh != nil {
			recordBatchJobLog(ctx, pool, fresh, operatorSessionID, 0)
		}
	}

	// resource_ids → uuid 列表。
	resourceIDs, err := decodeResourceIDs(job.ResourceIDs)
	if err != nil {
		finishFailed(err.Error())
		return
	}
	if _, err := pool.Exec(ctx,
		`UPDATE admin_background_jobs SET total = $1 WHERE id = $2`,
		len(resourceIDs), jobID); err != nil {
		finishFailed(err.Error())
		return
	}

	counters := struct{ processed, changed, skipped, failed int }{}
	persistCounters := func() error {
		_, err := pool.Exec(ctx,
			`UPDATE admin_background_jobs
			 SET processed = $1, changed = $2, skipped = $3, failed = $4
			 WHERE id = $5`,
			counters.processed, counters.changed, counters.skipped, counters.failed, jobID)
		return err
	}

	var runErr error
loop:
	for offset := 0; offset < len(resourceIDs); offset += AdminBatchStatusSize {
		if batchStatusCancelPending(jobID) {
			_, execErr := pool.Exec(ctx,
				`UPDATE admin_background_jobs SET status = 'cancelled', completed_at = $1 WHERE id = $2`,
				time.Now().UTC(), jobID)
			if execErr != nil {
				finishFailed(execErr.Error())
				return
			}
			invalidatedCacheFiles = InvalidateNginxProxyCache(deps.Settings, "")
			ClearBatchStatusCancel(jobID)
			if fresh, err := getAdminBackgroundJob(ctx, pool, jobID); err == nil && fresh != nil {
				recordBatchJobLog(ctx, pool, fresh, operatorSessionID, invalidatedCacheFiles)
			}
			return
		}

		chunk := resourceIDs[offset:]
		if len(chunk) > AdminBatchStatusSize {
			chunk = chunk[:AdminBatchStatusSize]
		}

		// 取本块 memories 与其 baidupan 源文件存在性。
		memories, remoteFlags, err := fetchMemoriesForBatch(ctx, pool, chunk)
		if err != nil {
			runErr = err
			break loop
		}

		for _, memoryID := range chunk {
			counters.processed++
			memory, ok := memories[memoryID]
			if !ok || !remoteFlags[memoryID] {
				counters.failed++
				continue
			}
			if memory.Status == targetStatus {
				counters.skipped++
				continue
			}
			if _, err := pool.Exec(ctx,
				`UPDATE memories SET status = $1, updated_at = now() WHERE id = $2`,
				targetStatus, memoryID); err != nil {
				runErr = err
				break loop
			}
			counters.changed++
		}
		if err := persistCounters(); err != nil {
			runErr = err
			break loop
		}
	}

	if runErr != nil {
		finishFailed(runErr.Error())
		return
	}

	errorMessage := (*string)(nil)
	if counters.failed > 0 {
		message := fmt.Sprintf(
			"failed=%d;reason=memory_or_remote_index_missing;retry=rescan_remote_directory",
			counters.failed)
		errorMessage = &message
	}
	if _, err := pool.Exec(ctx,
		`UPDATE admin_background_jobs SET status = 'completed', completed_at = $1, error_message = $2,
		 processed = $3, changed = $4, skipped = $5, failed = $6
		 WHERE id = $7`,
		time.Now().UTC(), errorMessage,
		counters.processed, counters.changed, counters.skipped, counters.failed,
		jobID); err != nil {
		finishFailed(err.Error())
		return
	}
	invalidatedCacheFiles = InvalidateNginxProxyCache(deps.Settings, "")
	if fresh, err := getAdminBackgroundJob(ctx, pool, jobID); err == nil && fresh != nil {
		recordBatchJobLog(ctx, pool, fresh, operatorSessionID, invalidatedCacheFiles)
	}
}

// decodeResourceIDs resource_ids JSON 数组 → uuid 列表。
func decodeResourceIDs(raw json.RawMessage) ([]uuid.UUID, error) {
	value := decodeJSONWithNumbers(raw)
	list, _ := value.([]any)
	ids := make([]uuid.UUID, 0, len(list))
	for _, item := range list {
		text, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("resource_ids 含非字符串项")
		}
		id, err := uuid.Parse(text)
		if err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, nil
}

// fetchMemoriesForBatch 批量取 memory 主行与其 baidupan 文件存在性。
// (Python 端经 ORM relationship 加载 memory.files 后 any() 判断;
//  Go 用一次 join 聚合等价判定,文件名等细节不进内存。)
func fetchMemoriesForBatch(ctx context.Context, pool *pgxpool.Pool, ids []uuid.UUID) (map[uuid.UUID]*models.Memory, map[uuid.UUID]bool, error) {
	rows, err := pool.Query(ctx,
		`SELECT id, title, description, kind, status, captured_at, location,
		 thumbnail_path, duration_seconds, width, height, created_at, updated_at
		 FROM memories WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, nil, err
	}
	out := make(map[uuid.UUID]*models.Memory, len(ids))
	for rows.Next() {
		memory, err := scanMemoryLite(rows)
		if err != nil {
			rows.Close()
			return nil, nil, err
		}
		out[memory.ID] = memory
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, err
	}
	rows.Close()

	remoteFlags := make(map[uuid.UUID]bool, len(ids))
	flagRows, err := pool.Query(ctx,
		`SELECT DISTINCT memory_id FROM memory_files
		 WHERE memory_id = ANY($1) AND source = $2`, ids, "baidupan")
	if err != nil {
		return nil, nil, err
	}
	defer flagRows.Close()
	for flagRows.Next() {
		var memoryID *uuid.UUID
		if err := flagRows.Scan(&memoryID); err != nil {
			return nil, nil, err
		}
		if memoryID != nil {
			remoteFlags[*memoryID] = true
		}
	}
	return out, remoteFlags, flagRows.Err()
}

func scanMemoryLite(row rowScanner) (*models.Memory, error) {
	memory := &models.Memory{}
	if err := row.Scan(
		&memory.ID, &memory.Title, &memory.Description, &memory.Kind, &memory.Status,
		&memory.CapturedAt, &memory.Location, &memory.ThumbnailPath,
		&memory.DurationSeconds, &memory.Width, &memory.Height,
		&memory.CreatedAt, &memory.UpdatedAt,
	); err != nil {
		return nil, err
	}
	return memory, nil
}

// recordBatchJobLog 写入批量任务审计日志(对齐 _record_job_log:
// action 按 job.action 关键词映射并截断 32 字符)。
func recordBatchJobLog(
	ctx context.Context,
	pool *pgxpool.Pool,
	job *models.AdminBackgroundJob,
	operatorSessionID *uuid.UUID,
	invalidatedCacheFiles int,
) {
	session := "unknown"
	if operatorSessionID != nil {
		session = operatorSessionID.String()
	}
	var action string
	switch {
	case strings.Contains(job.Action, "publish"):
		action = "batch_publish"
	case strings.Contains(job.Action, "hidden") || strings.Contains(job.Action, "hide"):
		action = "batch_hide"
	default:
		action = job.Action
	}
	runes := []rune(action)
	if len(runes) > 32 {
		action = string(runes[:32])
	}
	detail := fmt.Sprintf(
		"job=%s;status=%s;total=%d;session=%s;processed=%d;changed=%d;skipped=%d;failed=%d;nginx_cache_files=%d;filters=%s;resource_ids=%s",
		job.ID.String(), job.Status, job.Total, session,
		job.Processed, job.Changed, job.Skipped, job.Failed,
		invalidatedCacheFiles,
		pythonSortedJSON(decodeJSONWithNumbers(job.FilterSnapshot)),
		pythonCompactJSON(decodeJSONWithNumbers(job.ResourceIDs)),
	)
	_, _ = pool.Exec(ctx,
		`INSERT INTO admin_operation_logs (id, action, target_type, target_id, client_ip, detail)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		uuid.New(), action, "memory_batch_job", nil, nil, detail)
}
