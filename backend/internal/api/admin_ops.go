// admin_ops.go 对齐原 admin.py 的操作类端点:批量状态/导出/更新/删除/
// 远程配置/同步/预热/浏览器探测/系统状态/清理。
package api

import (
	"context"
	"errors"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"

	"limedia/backend/internal/models"
	"limedia/backend/internal/repo"
	"limedia/backend/internal/services"
)

// ---- 批量预览 / 批量状态 ----

func (h *AdminHandler) filterFromBody(r *http.Request) (repo.AdminMemoryFilter, *bool, *models.MemoryStatus, error) {
	var payload struct {
		Kind          *string `json:"kind"`
		Keyword       *string `json:"keyword"`
		Display       *string `json:"display"`
		Compatibility *string `json:"compatibility"`
		Status        *string `json:"status"`
		TargetStatus  *string `json:"target_status"`
		Confirm       *bool   `json:"confirm"`
	}
	body, err := readBody(r)
	if err != nil || json.Unmarshal(body, &payload) != nil {
		return repo.AdminMemoryFilter{}, nil, nil, errors.New("invalid json")
	}
	filter := repo.AdminMemoryFilter{Display: "all", Compatibility: "all"}
	if payload.Display != nil {
		filter.Display = *payload.Display
	}
	if payload.Compatibility != nil {
		filter.Compatibility = *payload.Compatibility
	}
	if payload.Keyword != nil {
		filter.Keyword = *payload.Keyword
	}
	if payload.Kind != nil && *payload.Kind != "all" {
		kind := models.MemoryKind(*payload.Kind)
		filter.Kind = &kind
	}
	if payload.Status != nil && *payload.Status != "all" {
		status := models.MemoryStatus(*payload.Status)
		filter.Status = &status
	}
	var target *models.MemoryStatus
	if payload.TargetStatus != nil {
		target = (*models.MemoryStatus)(payload.TargetStatus)
	}
	return filter, payload.Confirm, target, nil
}

// BatchPreview 批量操作前的范围预览。
func (h *AdminHandler) BatchPreview(w http.ResponseWriter, r *http.Request) {
	filter, _, _, ferr := h.filterFromBody(r)
	if ferr != nil {
		ErrorDetail(w, http.StatusUnprocessableEntity, "输入校验失败")
		return
	}
	counts, err := repo.CollectAdminCounts(r.Context(), h.Pool, filter)
	if err != nil {
		ErrorDetail(w, http.StatusInternalServerError, "database error")
		return
	}
	snapshot := map[string]any{
		"kind":          "all",
		"keyword":       "all",
		"display":       filter.Display,
		"compatibility": filter.Compatibility,
		"status":        "all",
	}
	if filter.Kind != nil {
		snapshot["kind"] = string(*filter.Kind)
	}
	if filter.Keyword != "" {
		snapshot["keyword"] = filter.Keyword
	}
	if filter.Status != nil {
		snapshot["status"] = string(*filter.Status)
	}
	isFull := filter.Kind == nil && filter.Keyword == "" &&
		filter.Display == "all" && filter.Compatibility == "all" && filter.Status == nil
	WriteJSON(w, http.StatusOK, map[string]any{
		"filter_snapshot": snapshot,
		"total":           counts.Total,
		"counts":          counts.Counts,
		"status_counts":   counts.StatusCounts,
		"display_counts":  counts.DisplayCounts,
		"browser_counts":  counts.BrowserCounts,
		"is_full_library": isFull,
	})
}

// adminBackgroundJobRead 对齐 responses.AdminBackgroundJobRead。
type adminBackgroundJobRead struct {
	ID             uuid.UUID       `json:"id"`
	Action         string          `json:"action"`
	Status         string          `json:"status"`
	FilterSnapshot any             `json:"filter_snapshot"`
	ResourceIDs    []string        `json:"resource_ids"`
	Total          int             `json:"total"`
	Processed      int             `json:"processed"`
	Changed        int             `json:"changed"`
	Skipped        int             `json:"skipped"`
	Failed         int             `json:"failed"`
	ErrorMessage   *string         `json:"error_message"`
	CreatedAt      *string         `json:"created_at"`
	StartedAt      *string         `json:"started_at"`
	CompletedAt    *string         `json:"completed_at"`
}

func (h *AdminHandler) jobToRead(j *models.AdminBackgroundJob) *adminBackgroundJobRead {
	var snapshot any
	if len(j.FilterSnapshot) > 0 {
		_ = json.Unmarshal(j.FilterSnapshot, &snapshot)
	}
	var resourceIDs []string
	if len(j.ResourceIDs) > 0 {
		_ = json.Unmarshal(j.ResourceIDs, &resourceIDs)
	}
	if resourceIDs == nil {
		resourceIDs = []string{}
	}
	return &adminBackgroundJobRead{
		ID:             j.ID,
		Action:         j.Action,
		Status:         j.Status,
		FilterSnapshot: snapshot,
		ResourceIDs:    resourceIDs,
		Total:          j.Total,
		Processed:      j.Processed,
		Changed:        j.Changed,
		Skipped:        j.Skipped,
		Failed:         j.Failed,
		ErrorMessage:   j.ErrorMessage,
		CreatedAt:      apiTimeString(&j.CreatedAt),
		StartedAt:      apiTimeString(j.StartedAt),
		CompletedAt:    apiTimeString(j.CompletedAt),
	}
}

// collectFilteredIDs 按过滤口径收集 memory id(批量任务候选)。
func (h *AdminHandler) collectFilteredIDs(ctx context.Context, filter repo.AdminMemoryFilter) ([]uuid.UUID, error) {
	return repo.CollectFilteredIDs(ctx, h.Pool, filter)
}

// BatchStatus 创建批量状态任务(202)。
func (h *AdminHandler) BatchStatus(w http.ResponseWriter, r *http.Request) {
	filter, confirm, target, ferr := h.filterFromBody(r)
	if ferr != nil {
		ErrorDetail(w, http.StatusUnprocessableEntity, "输入校验失败")
		return
	}
	if target == nil || (*target != models.MemoryStatusPublished && *target != models.MemoryStatusHidden) {
		ErrorDetail(w, http.StatusBadRequest, "批量状态只支持发布或下线")
		return
	}
	if confirm == nil || !*confirm {
		ErrorDetail(w, http.StatusBadRequest, "批量操作缺少确认")
		return
	}

	ids, err := h.collectFilteredIDs(r.Context(), filter)
	if err != nil {
		ErrorDetail(w, http.StatusInternalServerError, "database error")
		return
	}
	resourceIDs, _ := json.Marshal(ids)
	snapshot, _ := json.Marshal(map[string]any{
		"kind":          stringOr(filter.Kind, "all"),
		"keyword":       filter.Keyword,
		"display":       filter.Display,
		"compatibility": filter.Compatibility,
		"status":        stringOr(filter.Status, "all"),
		"target_status": string(*target),
	})

	job := &models.AdminBackgroundJob{
		ID:             uuid.New(),
		Action:         "batch_status_" + string(*target),
		Status:         "queued",
		FilterSnapshot: snapshot,
		ResourceIDs:    resourceIDs,
		Total:          len(ids),
	}
	if _, err := h.Pool.Exec(r.Context(),
		`INSERT INTO admin_background_jobs (id, action, status, filter_snapshot, resource_ids, total, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, now(), now())`,
		job.ID, job.Action, job.Status, job.FilterSnapshot, job.ResourceIDs, job.Total); err != nil {
		ErrorDetail(w, http.StatusInternalServerError, "database error")
		return
	}

	// 后台执行(goroutine 取代 FastAPI BackgroundTasks)。
	deps := &services.BatchStatusJobDeps{Pool: h.Pool, Settings: h.Settings}
	targetStatus := *target
	jobCopy := job.ID
	sessionID := uuid.Nil
	go func() {
		ctx := context.Background()
		services.RunBatchStatusJob(ctx, deps, jobCopy, targetStatus, &sessionID)
	}()

	detail := "action=" + job.Action + ";total=" + strconv.Itoa(job.Total) + ";session=" + sessionID.String() + ";filters=" + string(snapshot)
	_ = services.RecordAdminOperation(h.Pool, "batch_status_queued", strPtr("memory_batch_job"), nil, h.adminClientIP(r), &detail)

	// 返回最新 job 行。
	fresh, _ := h.getAdminJob(r.Context(), job.ID)
	if fresh == nil {
		fresh = job
	}
	w.WriteHeader(http.StatusAccepted)
	WriteJSON(w, http.StatusAccepted, h.jobToRead(fresh))
}

func stringOr(v any, fallback string) string {
	switch value := v.(type) {
	case *models.MemoryKind:
		if value == nil {
			return fallback
		}
		return string(*value)
	case *models.MemoryStatus:
		if value == nil {
			return fallback
		}
		return string(*value)
	default:
		return fallback
	}
}

func (h *AdminHandler) getAdminJob(ctx context.Context, id uuid.UUID) (*models.AdminBackgroundJob, error) {
	row := h.Pool.QueryRow(ctx,
		`SELECT id, action, status, filter_snapshot, resource_ids, total, processed, changed,
		 skipped, failed, error_message, created_by_session, created_at, started_at, completed_at
		 FROM admin_background_jobs WHERE id = $1`, id)
	j := &models.AdminBackgroundJob{}
	err := row.Scan(&j.ID, &j.Action, &j.Status, &j.FilterSnapshot, &j.ResourceIDs,
		&j.Total, &j.Processed, &j.Changed, &j.Skipped, &j.Failed, &j.ErrorMessage,
		&j.CreatedBySession, &j.CreatedAt, &j.StartedAt, &j.CompletedAt)
	if err != nil {
		return nil, err
	}
	return j, nil
}

// BatchStatusLatest 最近一次批量状态任务。
func (h *AdminHandler) BatchStatusLatest(w http.ResponseWriter, r *http.Request) {
	row := h.Pool.QueryRow(r.Context(),
		`SELECT id FROM admin_background_jobs
		 WHERE action IN ('batch_status_published', 'batch_status_hidden')
		 ORDER BY created_at DESC LIMIT 1`)
	var id uuid.UUID
	if err := row.Scan(&id); err != nil {
		WriteJSON(w, http.StatusOK, nil)
		return
	}
	job, err := h.getAdminJob(r.Context(), id)
	if err != nil {
		WriteJSON(w, http.StatusOK, nil)
		return
	}
	WriteJSON(w, http.StatusOK, h.jobToRead(job))
}

// BatchStatusCancel 请求取消(queued/running 才可取消,409 否则)。
func (h *AdminHandler) BatchStatusCancel(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		ErrorDetail(w, http.StatusNotFound, "批量任务不存在")
		return
	}
	job, jerr := h.getAdminJob(r.Context(), id)
	if jerr != nil || job == nil {
		ErrorDetail(w, http.StatusNotFound, "批量任务不存在")
		return
	}
	if job.Status != "queued" && job.Status != "running" {
		ErrorDetail(w, http.StatusConflict, "批量任务已结束，不能取消")
		return
	}
	services.RequestBatchStatusCancel(id)
	WriteJSON(w, http.StatusOK, h.jobToRead(job))
}

// Export 按 ids 导出(全字段)。
func (h *AdminHandler) Export(w http.ResponseWriter, r *http.Request) {
	ids, apiErr := parseIDsFromBody(r)
	if apiErr != nil {
		ErrorDetail(w, http.StatusUnprocessableEntity, apiErr.Error())
		return
	}
	items, err := h.memoriesByIDs(r.Context(), ids, true)
	if err != nil {
		ErrorDetail(w, http.StatusInternalServerError, "database error")
		return
	}
	now := time.Now().UTC()
	WriteJSON(w, http.StatusOK, map[string]any{
		"exported_at": apiTimeString(&now),
		"items":       items,
		"total":       len(items),
	})
}

// parseIDsFromBody 校验 1..100 个 uuid。
func parseIDsFromBody(r *http.Request) ([]uuid.UUID, error) {
	var payload struct {
		IDs []string `json:"ids"`
	}
	body, err := readBody(r)
	if err != nil || json.Unmarshal(body, &payload) != nil {
		return nil, errInvalidPayload
	}
	if len(payload.IDs) < 1 || len(payload.IDs) > 100 {
		return nil, errInvalidPayload
	}
	ids := make([]uuid.UUID, 0, len(payload.IDs))
	seen := make(map[uuid.UUID]bool)
	for _, raw := range payload.IDs {
		id, err := uuid.Parse(raw)
		if err != nil {
			return nil, errInvalidPayload
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	return ids, nil
}

var errInvalidPayload = apiPayloadError{"输入校验失败"}

type apiPayloadError struct{ msg string }

func (e apiPayloadError) Error() string { return e.msg }

// memoriesByIDs 按 id 顺序取后台详情;ensureRemote 时校验 baidupan。
func (h *AdminHandler) memoriesByIDs(ctx context.Context, ids []uuid.UUID, ensureRemote bool) ([]*MemoryRead, error) {
	memories := make([]*models.Memory, 0, len(ids))
	for _, id := range ids {
		memory, err := repo.GetAdminByID(ctx, h.Pool, id)
		if err != nil {
			return nil, err
		}
		if memory == nil {
			return nil, errNotFoundBatch
		}
		if ensureRemote {
			hasBaidupan := false
			for i := range memory.Files {
				if memory.Files[i].Source == "baidupan" {
					hasBaidupan = true
					break
				}
			}
			if !hasBaidupan {
				return nil, errNotFoundBatch
			}
		}
		memories = append(memories, memory)
	}
	items := make([]*MemoryRead, len(memories))
	for i, m := range memories {
		items[i] = toMemoryRead(m)
	}
	return items, nil
}

var errNotFoundBatch = apiPayloadError{"部分回忆不存在"}

// BatchUpdate 批量修改字段(changed/skipped 计数)。
func (h *AdminHandler) BatchUpdate(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		IDs         []string `json:"ids"`
		Title       *string  `json:"title"`
		Description *string  `json:"description"`
		Location    *string  `json:"location"`
		CapturedAt  *string  `json:"captured_at"`
		Status      *string  `json:"status"`
	}
	body, err := readBody(r)
	if err != nil || json.Unmarshal(body, &payload) != nil {
		ErrorDetail(w, http.StatusUnprocessableEntity, "输入校验失败")
		return
	}
	if len(payload.IDs) < 1 || len(payload.IDs) > 100 {
		ErrorDetail(w, http.StatusUnprocessableEntity, "输入校验失败")
		return
	}

	changed, skipped := 0, 0
	var touched []string
	action := "batch_update"
	for _, raw := range payload.IDs {
		id, err := uuid.Parse(raw)
		if err != nil {
			ErrorDetail(w, http.StatusNotFound, "部分回忆不存在")
			return
		}
		memory, merr := repo.GetAdminByID(r.Context(), h.Pool, id)
		if merr != nil || memory == nil {
			ErrorDetail(w, http.StatusNotFound, "部分回忆不存在")
			return
		}
		updates := map[string]any{}
		if payload.Title != nil && memory.Title != *payload.Title {
			updates["title"] = *payload.Title
		}
		if payload.Description != nil && memory.Description != *payload.Description {
			updates["description"] = *payload.Description
		}
		if payload.Location != nil && ptrStr(memory.Location) != *payload.Location {
			updates["location"] = *payload.Location
		}
		if payload.CapturedAt != nil {
			if parsed, perr := time.Parse(time.RFC3339, *payload.CapturedAt); perr == nil {
				updates["captured_at"] = parsed
			}
		}
		if payload.Status != nil && memory.Status != models.MemoryStatus(*payload.Status) {
			switch models.MemoryStatus(*payload.Status) {
			case models.MemoryStatusPublished:
				action = "batch_publish"
			case models.MemoryStatusHidden:
				action = "batch_hide"
			}
			updates["status"] = string(*payload.Status)
		}
		if len(updates) == 0 {
			skipped++
			continue
		}
		changed++
		touched = append(touched, id.String())
		for field, value := range updates {
			if _, err := h.Pool.Exec(r.Context(),
				`UPDATE memories SET `+field+` = $1, updated_at = now() WHERE id = $2`,
				value, id); err != nil {
				ErrorDetail(w, http.StatusInternalServerError, "database error")
				return
			}
		}
	}
	detail := "changed=" + strconv.Itoa(changed) + ";skipped=" + strconv.Itoa(skipped) +
		";fields=;" + "resource_ids=" + joinStrings(touched, ",")
	_ = services.RecordAdminOperation(h.Pool, action, strPtr("memory_batch"), nil, h.adminClientIP(r), &detail)
	WriteJSON(w, http.StatusOK, map[string]any{
		"changed": changed,
		"skipped": skipped,
		"updated": changed,
	})
}

func ptrStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func joinStrings(items []string, sep string) string {
	out := ""
	for i, item := range items {
		if i > 0 {
			out += sep
		}
		out += item
	}
	return out
}

// UpdateMemory 单条修改(PATCH)。
func (h *AdminHandler) UpdateMemory(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		ErrorDetail(w, http.StatusNotFound, "回忆不存在")
		return
	}
	memory, merr := repo.GetAdminByID(r.Context(), h.Pool, id)
	if merr != nil || memory == nil {
		ErrorDetail(w, http.StatusNotFound, "回忆不存在")
		return
	}

	var payload struct {
		Title         *string `json:"title"`
		Description   *string `json:"description"`
		Kind          *string `json:"kind"`
		Status        *string `json:"status"`
		CapturedAt    *string `json:"captured_at"`
		Location      *string `json:"location"`
		ThumbnailPath *string `json:"thumbnail_path"`
	}
	body, _ := readBody(r)
	if json.Unmarshal(body, &payload) != nil {
		ErrorDetail(w, http.StatusUnprocessableEntity, "输入校验失败")
		return
	}

	previousStatus := memory.Status
	updates := map[string]any{}
	if payload.Title != nil {
		updates["title"] = *payload.Title
	}
	if payload.Description != nil {
		updates["description"] = *payload.Description
	}
	if payload.Kind != nil {
		updates["kind"] = *payload.Kind
	}
	if payload.Status != nil {
		updates["status"] = *payload.Status
	}
	if payload.CapturedAt != nil {
		if parsed, perr := time.Parse(time.RFC3339, *payload.CapturedAt); perr == nil {
			updates["captured_at"] = parsed
		}
	}
	if payload.Location != nil {
		updates["location"] = *payload.Location
	}
	if payload.ThumbnailPath != nil {
		updates["thumbnail_path"] = *payload.ThumbnailPath
	}
	for field, value := range updates {
		if _, err := h.Pool.Exec(r.Context(),
			`UPDATE memories SET `+field+` = $1, updated_at = now() WHERE id = $2`,
			value, id); err != nil {
			ErrorDetail(w, http.StatusInternalServerError, "database error")
			return
		}
	}

	fresh, _ := repo.GetAdminByID(r.Context(), h.Pool, id)
	if fresh == nil {
		fresh = memory
	}
	action := "update"
	if fresh.Status != previousStatus {
		if fresh.Status == models.MemoryStatusPublished {
			action = "publish"
		} else {
			action = "hide"
		}
	}
	detail := "fields=" + joinStrings(sortedKeys(updates), ",") + ";id=" + id.String()
	_ = services.RecordAdminOperation(h.Pool, action, strPtr("memory"), strPtr(id.String()), h.adminClientIP(r), &detail)
	WriteJSON(w, http.StatusOK, toMemoryRead(fresh))
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	// 排序对齐 Python sorted(changes)
	for i := 0; i < len(keys); i++ {
		for j := i + 1; j < len(keys); j++ {
			if keys[j] < keys[i] {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}
	return keys
}

// DeleteMemory 删除单条(级联文件)。
func (h *AdminHandler) DeleteMemory(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		ErrorDetail(w, http.StatusNotFound, "回忆不存在")
		return
	}
	memory, merr := repo.GetAdminByID(r.Context(), h.Pool, id)
	if merr != nil || memory == nil {
		ErrorDetail(w, http.StatusNotFound, "回忆不存在")
		return
	}
	if _, err := h.Pool.Exec(r.Context(), `DELETE FROM memories WHERE id = $1`, id); err != nil {
		ErrorDetail(w, http.StatusInternalServerError, "database error")
		return
	}
	detail := "title=" + memory.Title
	_ = services.RecordAdminOperation(h.Pool, "delete", strPtr("memory"), strPtr(id.String()), h.adminClientIP(r), &detail)
	w.WriteHeader(http.StatusNoContent)
}

// scanRemoteTask 扫描任务行扫描(列序与 SELECT 清单配对)。
func scanRemoteTask(row scannerRow) (*models.RemoteScanTask, error) {
	t := &models.RemoteScanTask{}
	var cursor, failureReason *string
	var completedAt *time.Time
	err := row.Scan(&t.ID, &t.RemoteDir, &t.Status, &cursor, &t.MaxDepth, &t.MaxItems,
		&t.DeleteMissing, &t.ProcessedItems, &t.ScannedFiles, &t.ScannedDirectories,
		&t.Discovered, &t.Refreshed, &t.Skipped, &failureReason, &t.StartedAt,
		&completedAt, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return nil, err
	}
	t.Cursor = cursor
	t.FailureReason = failureReason
	t.CompletedAt = completedAt
	return t, nil
}
