// admin_ops2.go 对齐 admin.py 的远程操作与状态类端点。
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"

	"limedia/backend/internal/models"
	"limedia/backend/internal/repo"
	"limedia/backend/internal/services"
)

// RemoteConfig 百度网盘配置状态(不含凭证值)。
func (h *AdminHandler) RemoteConfig(w http.ResponseWriter, r *http.Request) {
	credentials := services.LoadBaiduCredentials(h.Settings)
	var tokenExpires *time.Time
	if credentials != nil {
		tokenExpires = credentials.ExpiresAt
	}
	authorized := credentials != nil || h.Settings.BaiduAccessToken != ""
	redirectURI := h.Settings.BaiduOAuthRedirectURI
	if redirectURI == "" {
		redirectURI = trimSuffix(h.Settings.PublicBaseURL, "/") + "/admin/baidu/callback"
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"configured":       authorized,
		"oauth_configured": h.Settings.BaiduOAuthClientID != "" && h.Settings.BaiduOAuthClientSecret != "",
		"authorized":       authorized,
		"scan_dir":         h.Settings.BaiduSyncDir,
		"redirect_uri":     redirectURI,
		"docs_url":         "https://pan.baidu.com/union/doc",
		"token_expires_at": apiTimeString(tokenExpires),
	})
}

func trimSuffix(s, suffix string) string {
	for len(s) >= len(suffix) && s[len(s)-len(suffix):] == suffix {
		s = s[:len(s)-len(suffix)]
	}
	return s
}

// TasksMetrics 任务限流与指标快照。
func (h *AdminHandler) TasksMetrics(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, http.StatusOK, h.Governor.Metrics.Snapshot())
}

func (h *AdminHandler) latestScanTask(ctx context.Context) (*models.RemoteScanTask, error) {
	row := h.Pool.QueryRow(ctx,
		`SELECT id, remote_dir, status, cursor, max_depth, max_items, delete_missing,
		 processed_items, scanned_files, scanned_directories, discovered, refreshed, skipped,
		 failure_reason, started_at, completed_at, created_at, updated_at
		 FROM remote_scan_tasks ORDER BY created_at DESC LIMIT 1`)
	return scanRemoteTask(row)
}

// LatestRemoteScan 最近一次扫描任务(无则 null,契约样本 23)。
func (h *AdminHandler) LatestRemoteScan(w http.ResponseWriter, r *http.Request) {
	task, err := h.latestScanTask(r.Context())
	if err != nil {
		WriteJSON(w, http.StatusOK, nil)
		return
	}
	WriteJSON(w, http.StatusOK, toRemoteScanTaskPayload(task))
}

func toRemoteScanTaskPayload(t *models.RemoteScanTask) map[string]any {
	return map[string]any{
		"id":                  t.ID,
		"remote_dir":          t.RemoteDir,
		"status":              string(t.Status),
		"max_depth":           t.MaxDepth,
		"max_items":           t.MaxItems,
		"delete_missing":      t.DeleteMissing,
		"processed_items":     t.ProcessedItems,
		"scanned_files":       t.ScannedFiles,
		"scanned_directories": t.ScannedDirectories,
		"discovered":          t.Discovered,
		"refreshed":           t.Refreshed,
		"skipped":             t.Skipped,
		"limit_reached":       false,
		"failure_reason":      t.FailureReason,
		"started_at":          apiTimeString(&t.StartedAt),
		"completed_at":        apiTimeString(t.CompletedAt),
	}
}

// TriggerSync 触发网盘同步(同步阻塞执行)。
func (h *AdminHandler) TriggerSync(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		MaxFiles      *int    `json:"max_files"`
		MaxDepth      *int    `json:"max_depth"`
		MaxItems      *int    `json:"max_items"`
		DeleteMissing *bool   `json:"delete_missing"`
		ResumeTaskID  *string `json:"resume_task_id"`
	}
	body, _ := readBody(r)
	_ = json.Unmarshal(body, &payload)

	client, clientErr := h.Baidu.New()
	if clientErr != nil {
		ErrorDetail(w, http.StatusBadGateway, clientErr.Error())
		return
	}

	opts := services.ScanRemoteOptions{
		RemoteDir:     h.Settings.BaiduSyncDir,
		MaxDepth:      h.Settings.BaiduScanMaxDepth,
		MaxItems:      h.Settings.BaiduScanMaxItems,
		DeleteMissing: true,
	}
	if payload.MaxDepth != nil {
		opts.MaxDepth = *payload.MaxDepth
	}
	if payload.MaxItems != nil {
		opts.MaxItems = *payload.MaxItems
	}
	if payload.DeleteMissing != nil {
		opts.DeleteMissing = *payload.DeleteMissing
	}
	if payload.ResumeTaskID != nil {
		if id, err := uuid.Parse(*payload.ResumeTaskID); err == nil {
			opts.ResumeTaskID = &id
		}
	}

	_, release, slotErr := h.Governor.Slot(r.Context(), services.TaskTypeScan, 50, nil)
	if slotErr != nil {
		taskHTTPError(w, slotErr)
		return
	}
	summary, err := services.ScanRemoteDirectory(r.Context(), h.Pool, client, opts)
	release()
	if err != nil {
		ErrorDetail(w, http.StatusBadGateway, err.Error())
		return
	}

	// matched/failed 对齐 Python:matched=refreshed,failed=0(异步删除策略)。
	latest, _ := h.latestScanTask(r.Context())
	WriteJSON(w, http.StatusOK, map[string]any{
		"discovered": summary.Discovered,
		"matched":    summary.Refreshed,
		"deleted":    0,
		"failed":     0,
		"scan_task":  toRemoteScanTaskPayload(latest),
	})
}

// SystemStatus 系统状态大聚合。
func (h *AdminHandler) SystemStatus(w http.ResponseWriter, r *http.Request) {
	deps := &services.SystemStatusDeps{
		Pool:     h.Pool,
		Settings: h.Settings,
		Governor: h.Governor,
	}
	status, err := services.CollectSystemStatus(r.Context(), deps, nil)
	if err != nil {
		ErrorDetail(w, http.StatusInternalServerError, "database error")
		return
	}
	WriteJSON(w, http.StatusOK, status)
}

// Cleanup 本地媒体清理(dry-run 语义对齐)。
func (h *AdminHandler) Cleanup(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Confirm *bool `json:"confirm"`
	}
	body, _ := readBody(r)
	_ = json.Unmarshal(body, &payload)
	dryRun := payload.Confirm == nil || !*payload.Confirm

	mediaCount := services.CleanupCountsDB(r.Context(), h.Pool)
	derivedFiles, derivedBytes := services.ScanDerivedMedia(h.Settings.MediaRoot)
	started := time.Now()
	if !dryRun {
		services.RemoveDerivedMediaFiles(h.Settings.MediaRoot)
	}
	completedAt := time.Now().UTC()
	detail := map[string]any{
		"dry_run":                 dryRun,
		"memories":                mediaCount.Memories,
		"remote_file_indexes":     mediaCount.RemoteFileIndexes,
		"scan_tasks":              mediaCount.ScanTasks,
		"thumbnail_files":         derivedFiles,
		"nginx_cache_files":       0,
		"estimated_bytes_to_free": derivedBytes,
		"duration_seconds":        completedAt.Sub(started).Seconds(),
		"completed_at":            apiTimeString(&completedAt),
		"file_cleanup_error":      nil,
	}
	if !dryRun {
		_ = services.RecordAdminOperation(h.Pool, "cleanup", nil, nil, adminClientIP(r), nil)
	}
	WriteJSON(w, http.StatusOK, detail)
}

// BaiduAuthorize 生成授权跳转地址。
func (h *AdminHandler) BaiduAuthorize(w http.ResponseWriter, r *http.Request) {
	state, err := services.CreateBaiduOAuthState(h.Settings, 600)
	if err != nil {
		ErrorDetail(w, http.StatusBadRequest, err.Error())
		return
	}
	authorizeURL, err := services.BuildBaiduAuthorizeURL(h.Settings, state)
	if err != nil {
		ErrorDetail(w, http.StatusBadRequest, err.Error())
		return
	}
	expiresAt := time.Now().UTC().Add(10 * time.Minute)
	WriteJSON(w, http.StatusOK, map[string]any{
		"authorize_url": authorizeURL,
		"expires_at":    apiTimeString(&expiresAt),
	})
}

// BaiduCallback 完成授权(code 换凭据落盘)。
func (h *AdminHandler) BaiduCallback(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Code  string `json:"code"`
		State string `json:"state"`
	}
	body, _ := readBody(r)
	if json.Unmarshal(body, &payload) != nil || payload.Code == "" || payload.State == "" {
		ErrorDetail(w, http.StatusUnprocessableEntity, "输入校验失败")
		return
	}
	if err := services.VerifyBaiduOAuthState(h.Settings, payload.State); err != nil {
		ErrorDetail(w, http.StatusBadRequest, err.Error())
		return
	}
	credentials, err := services.ExchangeBaiduCode(r.Context(), h.Settings, payload.Code)
	if err != nil {
		ErrorDetail(w, http.StatusBadGateway, err.Error())
		return
	}
	if err := services.SaveBaiduCredentials(h.Settings, credentials); err != nil {
		ErrorDetail(w, http.StatusInternalServerError, "凭据保存失败")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"authorized": true,
		"expires_at": apiTimeString(credentials.ExpiresAt),
	})
}

// ---- 预热 ----

// PreheatStart 启动预热任务(202;已有任务 409)。
func (h *AdminHandler) PreheatStart(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Sizes         []string `json:"sizes"`
		Kind          *string  `json:"kind"`
		Limit         *int     `json:"limit"`
		IncludeFailed *bool    `json:"include_failed"`
	}
	body, _ := readBody(r)
	if json.Unmarshal(body, &payload) != nil {
		ErrorDetail(w, http.StatusUnprocessableEntity, "输入校验失败")
		return
	}
	if len(payload.Sizes) == 0 {
		payload.Sizes = []string{"240"}
	}
	sizes := make([]int, 0, len(payload.Sizes))
	for _, raw := range payload.Sizes {
		switch raw {
		case "240", "480", "768", "1280":
			size, _ := strconv.Atoi(raw)
			sizes = append(sizes, size)
		default:
			ErrorDetail(w, http.StatusUnprocessableEntity, "输入校验失败")
			return
		}
	}
	var kind *models.MemoryKind
	if payload.Kind != nil && *payload.Kind != "" {
		k := models.MemoryKind(*payload.Kind)
		kind = &k
	}
	limit := 0
	if payload.Limit != nil {
		limit = *payload.Limit
	}
	includeFailed := payload.IncludeFailed != nil && *payload.IncludeFailed

	registry := services.DefaultThumbnailPreheatRegistry
	job, started := registry.Start(sizes, kind, limit,
		h.Settings.PreheatConcurrencyLimit, h.Settings.PreheatQueueLimit, includeFailed)
	if !started {
		ErrorDetail(w, http.StatusConflict, "预热任务已在执行")
		return
	}
	runner := &services.ThumbnailPreheatRunner{
		Pool:        h.Pool,
		Settings:    h.Settings,
		Governor:    h.Governor,
		Derivatives: h.Derivatives,
		Registry:    registry,
	}
	go runner.Run(job.ID)
	w.WriteHeader(http.StatusAccepted)
	WriteJSON(w, http.StatusAccepted, toPreheatJobPayload(job))
}

// PreheatLatest 最近一次预热任务(无则 404,契约样本 30)。
func (h *AdminHandler) PreheatLatest(w http.ResponseWriter, r *http.Request) {
	job := services.DefaultThumbnailPreheatRegistry.GetLatest()
	if job == nil {
		ErrorDetail(w, http.StatusNotFound, "not preheated")
		return
	}
	WriteJSON(w, http.StatusOK, toPreheatJobPayload(job))
}

// PreheatPreview 预热候选数。
func (h *AdminHandler) PreheatPreview(w http.ResponseWriter, r *http.Request) {
	count, err := services.CountPreheatCandidates(r.Context(), h.Pool, h.Settings, nil, []int{240}, false)
	if err != nil {
		ErrorDetail(w, http.StatusInternalServerError, "database error")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"total": count})
}

// PreheatCancel 取消预热任务。
func (h *AdminHandler) PreheatCancel(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		ErrorDetail(w, http.StatusNotFound, "预热任务不存在")
		return
	}
	if !services.DefaultThumbnailPreheatRegistry.RequestCancel(id) {
		ErrorDetail(w, http.StatusConflict, "预热任务已结束，不能取消")
		return
	}
	job := services.DefaultThumbnailPreheatRegistry.Get(id)
	WriteJSON(w, http.StatusOK, toPreheatJobPayload(job))
}

func toPreheatJobPayload(job *services.ThumbnailPreheatJob) map[string]any {
	if job == nil {
		return nil
	}
	var kind any
	if job.Kind != nil {
		kind = string(*job.Kind)
	}
	sizes := make([]int, len(job.Sizes))
	copy(sizes, job.Sizes)
	return map[string]any{
		"id":                      job.ID,
		"sizes":                   sizes,
		"kind":                    kind,
		"limit":                   job.Limit,
		"concurrency":             job.Concurrency,
		"queue_limit":             job.QueueLimit,
		"include_failed":          job.IncludeFailed,
		"status":                  job.Status,
		"total":                   job.Total,
		"processed":               job.Processed,
		"generated":               job.Generated,
		"cached":                  job.Cached,
		"failed":                  job.Failed,
		"skipped":                 job.Skipped,
		"source_bytes_downloaded": job.SourceBytesDownloaded,
		"derivative_duration_ms":  job.DerivativeDurationMS,
		"size_results":            job.SizeResults,
		"message":                 job.Message,
		"created_at":              apiTimeString(&job.CreatedAt),
		"started_at":              apiTimeString(job.StartedAt),
		"completed_at":            apiTimeString(job.CompletedAt),
	}
}

// ---- 浏览器兼容探测 ----

// CompatProbeStart 启动批量探测(202)。
func (h *AdminHandler) CompatProbeStart(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Limit *int `json:"limit"`
	}
	body, _ := readBody(r)
	_ = json.Unmarshal(body, &payload)
	limit := 25
	if payload.Limit != nil {
		limit = *payload.Limit
	}

	job := &models.AdminBackgroundJob{
		ID:             uuid.New(),
		Action:         "browser_probe_batch",
		Status:         "queued",
		FilterSnapshot: []byte(`{"limit": ` + strconv.Itoa(limit) + `}`),
		ResourceIDs:    []byte(`[]`),
		Total:          limit,
	}
	if _, err := h.Pool.Exec(r.Context(),
		`INSERT INTO admin_background_jobs (id, action, status, filter_snapshot, resource_ids, total, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, now(), now())`,
		job.ID, job.Action, job.Status, job.FilterSnapshot, job.ResourceIDs, job.Total); err != nil {
		ErrorDetail(w, http.StatusInternalServerError, "database error")
		return
	}

	deps := &services.BrowserProbeJobDeps{Pool: h.Pool, Settings: h.Settings, Governor: h.Governor}
	jobCopy := job.ID
	operator := uuid.Nil
	go func() {
		ctx := context.Background()
		services.RunBrowserCompatibilityProbe(ctx, deps, jobCopy, &operator)
	}()

	fresh, _ := h.getAdminJob(r.Context(), job.ID)
	if fresh == nil {
		fresh = job
	}
	w.WriteHeader(http.StatusAccepted)
	WriteJSON(w, http.StatusAccepted, h.jobToRead(fresh))
}

// CompatProbeLatest 最近一次探测任务(无则 404,契约样本 31)。
func (h *AdminHandler) CompatProbeLatest(w http.ResponseWriter, r *http.Request) {
	row := h.Pool.QueryRow(r.Context(),
		`SELECT id FROM admin_background_jobs WHERE action = 'browser_probe_batch'
		 ORDER BY created_at DESC LIMIT 1`)
	var id uuid.UUID
	if err := row.Scan(&id); err != nil {
		ErrorDetail(w, http.StatusNotFound, "no probe job")
		return
	}
	job, err := h.getAdminJob(r.Context(), id)
	if err != nil {
		ErrorDetail(w, http.StatusNotFound, "no probe job")
		return
	}
	WriteJSON(w, http.StatusOK, h.jobToRead(job))
}

// CompatProbeCancel 取消探测任务。
func (h *AdminHandler) CompatProbeCancel(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		ErrorDetail(w, http.StatusNotFound, "探测任务不存在")
		return
	}
	job, jerr := h.getAdminJob(r.Context(), id)
	if jerr != nil || job == nil {
		ErrorDetail(w, http.StatusNotFound, "探测任务不存在")
		return
	}
	if job.Status != "queued" && job.Status != "running" {
		ErrorDetail(w, http.StatusConflict, "探测任务已结束，不能取消")
		return
	}
	services.RequestBrowserProbeCancel(id)
	WriteJSON(w, http.StatusOK, h.jobToRead(job))
}

// RetryRemoteEntry 重试远程条目(状态复位待核验)。
func (h *AdminHandler) RetryRemoteEntry(w http.ResponseWriter, r *http.Request) {
	fileID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		ErrorDetail(w, http.StatusNotFound, "回忆不存在")
		return
	}
	row := h.Pool.QueryRow(r.Context(), `SELECT memory_id FROM memory_files WHERE id = $1`, fileID)
	var memoryID *uuid.UUID
	if err := row.Scan(&memoryID); err != nil || memoryID == nil {
		ErrorDetail(w, http.StatusNotFound, "回忆不存在")
		return
	}
	if _, err := h.Pool.Exec(r.Context(),
		`UPDATE memory_files SET remote_state = 'unverified', stream_state = 'unavailable',
		 updated_at = now() WHERE id = $1`, fileID); err != nil {
		ErrorDetail(w, http.StatusInternalServerError, "database error")
		return
	}
	memory, merr := repo.GetAdminByID(r.Context(), h.Pool, *memoryID)
	if merr != nil || memory == nil {
		ErrorDetail(w, http.StatusNotFound, "回忆不存在")
		return
	}
	WriteJSON(w, http.StatusOK, toMemoryRead(memory))
}
