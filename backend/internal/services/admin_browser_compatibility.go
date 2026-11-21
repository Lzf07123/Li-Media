// admin_browser_compatibility.go 对齐原
// app/services/admin_browser_compatibility.py:
// 有界后台批量探测浏览器播放兼容(写 admin_background_jobs 审计)。
package services

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"limedia/backend/internal/config"
	"limedia/backend/internal/models"
)

// ---- 取消登记表(独立于批量状态任务的模块级 _cancel_requested) ----

var (
	browserProbeCancelMu        sync.Mutex
	browserProbeCancelRequested = make(map[uuid.UUID]bool)
)

// RequestBrowserProbeCancel 请求取消兼容探测批量任务。
func RequestBrowserProbeCancel(jobID uuid.UUID) bool {
	browserProbeCancelMu.Lock()
	defer browserProbeCancelMu.Unlock()
	browserProbeCancelRequested[jobID] = true
	return true
}

// ClearBrowserProbeCancel 清除取消标记(任务收尾必调)。
func ClearBrowserProbeCancel(jobID uuid.UUID) {
	browserProbeCancelMu.Lock()
	defer browserProbeCancelMu.Unlock()
	delete(browserProbeCancelRequested, jobID)
}

func browserProbeCancelPending(jobID uuid.UUID) bool {
	browserProbeCancelMu.Lock()
	defer browserProbeCancelMu.Unlock()
	return browserProbeCancelRequested[jobID]
}

// BrowserProbeJobDeps 批量探测任务依赖注入。
type BrowserProbeJobDeps struct {
	Pool     *pgxpool.Pool
	Settings *config.Settings
	Governor *TaskGovernor
}

// RunBrowserCompatibilityProbe 执行有界批量探测(对齐
// run_browser_compatibility_probe)。同步运行,由装配层决定 goroutine。
func RunBrowserCompatibilityProbe(
	ctx context.Context,
	deps *BrowserProbeJobDeps,
	jobID uuid.UUID,
	operatorSessionID *uuid.UUID,
) {
	pool := deps.Pool

	job, err := getAdminBackgroundJob(ctx, pool, jobID)
	if err != nil || job == nil {
		return
	}

	limit := job.Total
	if _, err := pool.Exec(ctx,
		`UPDATE admin_background_jobs SET status = 'running', started_at = $1 WHERE id = $2`,
		time.Now().UTC(), jobID); err != nil {
		return
	}

	finishFailed := func(errText string) {
		_, _ = pool.Exec(ctx,
			`UPDATE admin_background_jobs SET status = 'failed', error_message = $1,
			 completed_at = $2 WHERE id = $3`,
			errText, time.Now().UTC(), jobID)
		if fresh, err := getAdminBackgroundJob(ctx, pool, jobID); err == nil && fresh != nil {
			recordBrowserProbeJobLog(ctx, pool, fresh, operatorSessionID)
		}
	}

	defer ClearBrowserProbeCancel(jobID)

	// 候选:source=baidupan 且 video 且兼容状态 unknown,按创建时间倒序,
	// 上限为任务创建时请求的 total。
	candidates, err := fetchProbeCandidates(ctx, pool, limit)
	if err != nil {
		finishFailed(err.Error())
		return
	}

	if _, err := pool.Exec(ctx,
		`UPDATE admin_background_jobs SET total = $1, resource_ids = $2 WHERE id = $3`,
		len(candidates), marshalResourceIDs(candidates), jobID); err != nil {
		finishFailed(err.Error())
		return
	}

	// 客户端在 try 内创建:凭证缺失走异常路径(job failed)。
	client, clientErr := NewBaiduPanClient(deps.Settings)
	if clientErr != nil {
		finishFailed(clientErr.Error())
		return
	}

	probeDeps := &BrowserProbeDeps{
		Settings: deps.Settings,
		Governor: deps.Governor,
		Pool:     pool,
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
	for i := range candidates {
		memoryFile := &candidates[i]
		if browserProbeCancelPending(jobID) {
			if _, execErr := pool.Exec(ctx,
				`UPDATE admin_background_jobs SET status = 'cancelled', completed_at = $1 WHERE id = $2`,
				time.Now().UTC(), jobID); execErr != nil {
				runErr = execErr
				break loop
			}
			ClearBrowserProbeCancel(jobID)
			if fresh, err := getAdminBackgroundJob(ctx, pool, jobID); err == nil && fresh != nil {
				recordBrowserProbeJobLog(ctx, pool, fresh, operatorSessionID)
			}
			return
		}

		counters.processed++
		probeErr := ProbeMemoryFileCompatibility(ctx, probeDeps, client, memoryFile, deps.Settings.MediaRoot)
		if probeErr != nil {
			counters.failed++
			if err := persistCounters(); err != nil {
				runErr = err
				break loop
			}
			continue
		}

		if memoryFile.BrowserCompatibility == models.BrowserCompatibilityStateUnknown {
			counters.skipped++
		} else {
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
			"failed=%d;reason=bounded_probe_unavailable;retry=later_or_refresh_remote_entry",
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
	if fresh, err := getAdminBackgroundJob(ctx, pool, jobID); err == nil && fresh != nil {
		recordBrowserProbeJobLog(ctx, pool, fresh, operatorSessionID)
	}
}

// joinedMemoryFileColumns join 场景下的文件列清单(带别名前缀,防 id 歧义)。
const joinedMemoryFileColumns = `f.id, f.memory_id, f.source, f.remote_path, f.remote_id, f.source_path,
f.mime_type, f.size_bytes, f.remote_md5, f.parent_path, f.filename, f.extension, f.modified_at,
f.remote_state, f.thumbnail_state, f.thumbnail_failure_kind, f.stream_state,
f.browser_compatibility, f.browser_compatibility_version, f.browser_format_summary,
f.browser_compatibility_error, f.browser_compatibility_checked_at,
f.raw_metadata_summary, f.last_scan_task_id, f.content_hash, f.status,
f.last_synced_at, f.sync_error, f.created_at, f.updated_at`

// fetchProbeCandidates 取批量探测候选行(对齐 candidates 查询)。
func fetchProbeCandidates(ctx context.Context, pool *pgxpool.Pool, limit int) ([]models.MemoryFile, error) {
	if limit < 0 {
		limit = 0
	}
	rows, err := pool.Query(ctx,
		`SELECT `+joinedMemoryFileColumns+`
		 FROM memory_files f
		 JOIN memories m ON f.memory_id = m.id
		 WHERE f.source = $1
		   AND m.kind = $2
		   AND f.browser_compatibility = $3
		 ORDER BY m.created_at DESC, m.id DESC
		 LIMIT $4`,
		"baidupan", models.MemoryKindVideo, models.BrowserCompatibilityStateUnknown, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]models.MemoryFile, 0, limit)
	for rows.Next() {
		file, err := scanProbeMemoryFile(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, file)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// scanProbeMemoryFile 按显式列清单扫描候选行(列序 = MemoryFilesColumns)。
func scanProbeMemoryFile(row rowScanner) (models.MemoryFile, error) {
	file := models.MemoryFile{}
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
		return file, err
	}
	file.CreatedAt = createdAt
	file.UpdatedAt = updatedAt
	return file, nil
}

// marshalResourceIDs candidates 的 id 列表 → json 数组列载荷。
// 列内容与 Python json 列默认序列化一致(默认分隔符带空格)。
func marshalResourceIDs(candidates []models.MemoryFile) []byte {
	ids := make([]string, len(candidates))
	for i, file := range candidates {
		ids[i] = file.ID.String()
	}
	return []byte(pythonSortedJSON(ids))
}

// recordBrowserProbeJobLog 写入探测任务审计日志(对齐 _record_job_log,
// action 固定 browser_probe)。
func recordBrowserProbeJobLog(
	ctx context.Context,
	pool *pgxpool.Pool,
	job *models.AdminBackgroundJob,
	operatorSessionID *uuid.UUID,
) {
	session := "unknown"
	if operatorSessionID != nil {
		session = operatorSessionID.String()
	}
	detail := fmt.Sprintf(
		"job=%s;status=%s;total=%d;session=%s;processed=%d;changed=%d;skipped=%d;failed=%d;filters=%s;resource_ids=%s",
		job.ID.String(), job.Status, job.Total, session,
		job.Processed, job.Changed, job.Skipped, job.Failed,
		pythonSortedJSON(decodeJSONWithNumbers(job.FilterSnapshot)),
		pythonCompactJSON(decodeJSONWithNumbers(job.ResourceIDs)),
	)
	_, _ = pool.Exec(ctx,
		`INSERT INTO admin_operation_logs (id, action, target_type, target_id, client_ip, detail)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		uuid.New(), "browser_probe", "memory_batch_job", nil, nil, detail)
}
