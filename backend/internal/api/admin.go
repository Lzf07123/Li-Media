// admin.go 对齐原 app/api/v1/admin.py 的认证与列表/批量端点。
package api

import (
	"crypto/subtle"
	"io"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"limedia/backend/internal/config"
	"limedia/backend/internal/httpx"
	"limedia/backend/internal/models"
	"limedia/backend/internal/repo"
	"limedia/backend/internal/services"
)

// AdminHandler 后台端点(除 login 外全部要求有效会话 cookie)。
type AdminHandler struct {
	Settings    *config.Settings
	Pool        *pgxpool.Pool
	Query       *repo.MemoryQuery
	Governor    *services.TaskGovernor
	Sessions    *services.AdminSessions
	Limiter     *services.AdminLoginRateLimiter
	Baidu       *services.BaiduPanClientFactory
	Derivatives *services.DerivativeTasks
}

// Register 挂载 /api/v1/admin 路由。
func (h *AdminHandler) Register(mux *http.ServeMux) {
	auth := h.requireAdminSession

	mux.HandleFunc("POST /api/v1/admin/login", h.Login)
	mux.HandleFunc("POST /api/v1/admin/logout", auth(h.Logout))
	mux.HandleFunc("GET /api/v1/admin/memories", auth(h.ListMemories))
	mux.HandleFunc("POST /api/v1/admin/memories/batch-preview", auth(h.BatchPreview))
	mux.HandleFunc("POST /api/v1/admin/memories/batch-status", auth(h.BatchStatus))
	mux.HandleFunc("GET /api/v1/admin/memories/batch-status/latest", auth(h.BatchStatusLatest))
	mux.HandleFunc("POST /api/v1/admin/memories/batch-status/{id}/cancel", auth(h.BatchStatusCancel))
	mux.HandleFunc("POST /api/v1/admin/memories/export", auth(h.Export))
	mux.HandleFunc("PATCH /api/v1/admin/memories/batch", auth(h.BatchUpdate))
	mux.HandleFunc("PATCH /api/v1/admin/memories/{id}", auth(h.UpdateMemory))
	mux.HandleFunc("DELETE /api/v1/admin/memories/{id}", auth(h.DeleteMemory))
	mux.HandleFunc("GET /api/v1/admin/remote-config", auth(h.RemoteConfig))
	mux.HandleFunc("GET /api/v1/admin/tasks/metrics", auth(h.TasksMetrics))
	mux.HandleFunc("GET /api/v1/admin/remote-scan/latest", auth(h.LatestRemoteScan))
	mux.HandleFunc("POST /api/v1/admin/sync", auth(h.TriggerSync))
	mux.HandleFunc("GET /api/v1/admin/system/status", auth(h.SystemStatus))
	mux.HandleFunc("POST /api/v1/admin/cleanup", auth(h.Cleanup))
	mux.HandleFunc("GET /api/v1/admin/baidu/authorize", auth(h.BaiduAuthorize))
	mux.HandleFunc("POST /api/v1/admin/baidu/callback", auth(h.BaiduCallback))
	mux.HandleFunc("POST /api/v1/admin/thumbnails/preheat", auth(h.PreheatStart))
	mux.HandleFunc("GET /api/v1/admin/thumbnails/preheat/latest", auth(h.PreheatLatest))
	mux.HandleFunc("GET /api/v1/admin/thumbnails/preheat/preview", auth(h.PreheatPreview))
	mux.HandleFunc("POST /api/v1/admin/thumbnails/preheat/{id}/cancel", auth(h.PreheatCancel))
	mux.HandleFunc("POST /api/v1/admin/remote-entries/{id}/retry", auth(h.RetryRemoteEntry))
	mux.HandleFunc("POST /api/v1/admin/browser-compatibility/probe", auth(h.CompatProbeStart))
	mux.HandleFunc("GET /api/v1/admin/browser-compatibility/probe/latest", auth(h.CompatProbeLatest))
	mux.HandleFunc("POST /api/v1/admin/browser-compatibility/probe/{id}/cancel", auth(h.CompatProbeCancel))
	mux.HandleFunc("GET /api/v1/admin/browser-compatibility/latest", auth(h.CompatProbeLatest))
	mux.HandleFunc("POST /api/v1/admin/browser-compatibility/{id}/cancel", auth(h.CompatProbeCancel))
}

// requireAdminSession 鉴权中间件:cookie 会话缺失/过期 → 401。
func (h *AdminHandler) requireAdminSession(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(h.Settings.AdminCookieName)
		var token string
		if err == nil {
			token = cookie.Value
		}
		session, err := h.Sessions.GetValid(r.Context(), token)
		if err != nil || session == nil {
			ErrorDetail(w, http.StatusUnauthorized, "管理会话缺失或已过期")
			return
		}
		next(w, r)
	}
}

// adminClientIP 仅受信代理透传时才采信 X-Forwarded-For(见 httpx.ClientIP);
// 直连客户端伪造该头无法改变登录限流键与审计来源。
func (h *AdminHandler) adminClientIP(r *http.Request) *string {
	host := httpx.ClientIP(r, h.Settings.TrustedProxies)
	if host == "" || host == "unknown" {
		return nil
	}
	return &host
}

// Login 管理登录:限流 → 常量时间比对 → 会话 cookie(204)。
func (h *AdminHandler) Login(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Token string `json:"token"`
	}
	body, err := readBody(r)
	if err != nil || json.Unmarshal(body, &payload) != nil {
		ValidationError(w, []ValidationErrorItem{{
			Type: "json_invalid", Loc: []any{"body", 0}, Msg: "JSON decode error", Input: nil,
		}})
		return
	}
	clientIP := h.adminClientIP(r)
	clientKey := "unknown"
	if clientIP != nil {
		clientKey = *clientIP
	}

	if err := h.Limiter.Check(clientKey); err != nil {
		var limitErr *services.AdminLoginLimitError
		if errors.As(err, &limitErr) {
			w.Header().Set("Retry-After", strconv.Itoa(limitErr.RetryAfterSeconds))
			ErrorDetail(w, http.StatusTooManyRequests, limitErr.Error())
			return
		}
	}

	// 空 admin_token fail-closed;比对用常量时间。
	if h.Settings.AdminToken == "" ||
		subtle.ConstantTimeCompare([]byte(payload.Token), []byte(h.Settings.AdminToken)) != 1 {
		delay := h.Limiter.RecordFailure(clientKey)
		services.SleepForLoginDelay(delay)
		ErrorDetail(w, http.StatusUnauthorized, "管理令牌不正确")
		return
	}

	h.Limiter.Reset(clientKey)
	sessionToken, err := h.Sessions.Create(r.Context(), h.Settings.AdminSessionTTLMinutes, clientIP)
	if err != nil {
		ErrorDetail(w, http.StatusInternalServerError, "会话创建失败")
		return
	}
	_ = services.RecordAdminOperation(h.Pool, "login", nil, nil, clientIP, nil)

	// 会话 cookie:HttpOnly + SameSite Lax;Secure 按部署 URL 推导。
	http.SetCookie(w, &http.Cookie{
		Name:     h.Settings.AdminCookieName,
		Value:    sessionToken,
		Path:     "/",
		MaxAge:   h.Settings.AdminSessionTTLMinutes * 60,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.Settings.CookieSecureEffective(),
	})
	w.WriteHeader(http.StatusNoContent)
}

// Logout 撤销会话并清除 cookie(204)。
func (h *AdminHandler) Logout(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(h.Settings.AdminCookieName)
	var token string
	if err == nil {
		token = cookie.Value
	}
	_ = h.Sessions.Revoke(r.Context(), token)
	_ = services.RecordAdminOperation(h.Pool, "logout", nil, nil, h.adminClientIP(r), nil)
	http.SetCookie(w, &http.Cookie{
		Name:     h.Settings.AdminCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   h.Settings.CookieSecureEffective(),
	})
	w.WriteHeader(http.StatusNoContent)
}

// ---- MemoryRead 序列化(后台口径:首文件即 primary_file)----

func toMemoryFileRead(f *models.MemoryFile) *MemoryFileRead {
	var formatSummary any
	if len(f.BrowserFormatSummary) > 0 {
		_ = json.Unmarshal(f.BrowserFormatSummary, &formatSummary)
	}
	if formatSummary == nil {
		formatSummary = map[string]any{}
	}
	return &MemoryFileRead{
		ID:                            f.ID.String(),
		Source:                        f.Source,
		RemoteID:                      f.RemoteID,
		RemotePath:                    f.RemotePath,
		ParentPath:                    f.ParentPath,
		Filename:                      f.Filename,
		Extension:                     f.Extension,
		RemoteMD5:                     f.RemoteMD5,
		MimeType:                      f.MimeType,
		SizeBytes:                     f.SizeBytes,
		ModifiedAt:                    apiTimeString(f.ModifiedAt),
		Status:                        string(f.Status),
		RemoteState:                   string(f.RemoteState),
		ThumbnailState:                string(f.ThumbnailState),
		ThumbnailFailureKind:          f.ThumbnailFailureKind,
		StreamState:                   string(f.StreamState),
		BrowserCompatibility:          string(f.BrowserCompatibility),
		BrowserFormatSummary:          formatSummary,
		BrowserCompatibilityError:     f.BrowserCompatibilityError,
		BrowserCompatibilityCheckedAt: apiTimeString(f.BrowserCompatibilityCheckedAt),
		LastSyncedAt:                  apiTimeString(f.LastSyncedAt),
		SyncError:                     f.SyncError,
	}
}

func toMemoryRead(m *models.Memory) *MemoryRead {
	id := m.ID.String()
	read := &MemoryRead{
		ID:                id,
		Title:             m.Title,
		Description:       m.Description,
		Kind:              string(m.Kind),
		Status:            string(m.Status),
		MediaDisplayState: repo.GetMediaDisplayState(m),
		CapturedAt:        apiTimeString(m.CapturedAt),
		Location:          m.Location,
		ThumbnailPath:     m.ThumbnailPath,
		DurationSeconds:   m.DurationSeconds,
		Width:             m.Width,
		Height:            m.Height,
		CreatedAt:         apiTimeString(&m.CreatedAt),
		UpdatedAt:         apiTimeString(&m.UpdatedAt),
		FileURL:           "/api/v1/memories/" + id + "/file",
	}
	read.PublicDisplayState = "excluded"
	if repo.GetPublicVisibilityState(m) == "displayable" {
		read.PublicDisplayState = "displayable"
	}
	// 管理端诊断口径:始终展示第一个文件,失败副本对后台可见可重试。
	if len(m.Files) > 0 {
		read.PrimaryFile = toMemoryFileRead(&m.Files[0])
	}
	read.ThumbnailURL = thumbnailURLFor(m, &MemoryCardFile{
		ThumbnailState: func() string {
			if read.PrimaryFile != nil {
				return read.PrimaryFile.ThumbnailState
			}
			return string(models.RemoteThumbnailStateMissing)
		}(),
	})
	return read
}

// ---- admin memories 列表 ----

func (h *AdminHandler) parseAdminFilter(r *http.Request) (repo.AdminMemoryFilter, *apiError) {
	q := r.URL.Query()
	filter := repo.AdminMemoryFilter{
		Display:       "all",
		Compatibility: "all",
	}
	if raw := q.Get("kind"); raw != "" {
		if raw != "photo" && raw != "video" {
			return filter, &apiError{field: "kind", input: raw}
		}
		kind := models.MemoryKind(raw)
		filter.Kind = &kind
	}
	keyword := q.Get("keyword")
	if len(keyword) > 100 {
		return filter, &apiError{field: "keyword", input: keyword}
	}
	filter.Keyword = keyword
	if raw := q.Get("display"); raw != "" {
		if raw != "all" && raw != "displayable" && raw != "excluded" {
			return filter, &apiError{field: "display", input: raw}
		}
		filter.Display = raw
	}
	if raw := q.Get("compatibility"); raw != "" {
		if raw != "all" && raw != "supported" && raw != "unsupported" && raw != "unknown" {
			return filter, &apiError{field: "compatibility", input: raw}
		}
		filter.Compatibility = raw
	}
	if raw := q.Get("status"); raw != "" {
		switch models.MemoryStatus(raw) {
		case models.MemoryStatusPending, models.MemoryStatusDraft,
			models.MemoryStatusPublished, models.MemoryStatusHidden, models.MemoryStatusError:
			status := models.MemoryStatus(raw)
			filter.Status = &status
		default:
			return filter, &apiError{field: "status", input: raw}
		}
	}
	return filter, nil
}

type apiError struct {
	field string
	input string
}

// ListMemories 后台分页列表(全量计数 + 过滤计数双口径)。
func (h *AdminHandler) ListMemories(w http.ResponseWriter, r *http.Request) {
	filter, apiErr := h.parseAdminFilter(r)
	if apiErr != nil {
		h.validationError(w, apiErr.field, "输入值不在允许范围", apiErr.input)
		return
	}
	page, pageSize, perr := parsePageParams(r, 50)
	if perr != nil {
		h.validationError(w, perr.field, "输入值不在允许范围", perr.input)
		return
	}

	globalCounts, err := repo.CollectAdminCounts(r.Context(), h.Pool, repo.AdminMemoryFilter{})
	if err != nil {
		ErrorDetail(w, http.StatusInternalServerError, "database error")
		return
	}
	filteredCounts, err := repo.CollectAdminCounts(r.Context(), h.Pool, filter)
	if err != nil {
		ErrorDetail(w, http.StatusInternalServerError, "database error")
		return
	}
	pageData, err := repo.ListAdminMemories(r.Context(), h.Pool, repo.AdminListOptions{
		Filter: filter, Page: page, PageSize: pageSize,
	})
	if err != nil {
		ErrorDetail(w, http.StatusInternalServerError, "database error")
		return
	}

	items := make([]*MemoryRead, len(pageData.Items))
	for i, m := range pageData.Items {
		items[i] = toMemoryRead(m)
	}
	WriteJSON(w, http.StatusOK, AdminMemoryListResponse{
		Items:                 items,
		Total:                 pageData.Total,
		DisplayCounts:         globalCounts.DisplayCounts,
		FilteredDisplayCounts: filteredCounts.DisplayCounts,
		GlobalCounts:          globalCounts.Counts,
		StatusCounts:          globalCounts.StatusCounts,
		FilteredStatusCounts:  filteredCounts.StatusCounts,
		BrowserCounts:         globalCounts.BrowserCounts,
		FilteredBrowserCounts: filteredCounts.BrowserCounts,
		Page:                  page,
		PageSize:              pageSize,
		Counts:                filteredCounts.Counts,
	})
}

type pageParamError struct{ field, input string }

func parsePageParams(r *http.Request, defaultSize int) (int, int, *pageParamError) {
	q := r.URL.Query()
	page := 1
	if raw := q.Get("page"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 {
			return 0, 0, &pageParamError{field: "page", input: raw}
		}
		page = parsed
	}
	pageSize := defaultSize
	if raw := q.Get("page_size"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 100 {
			return 0, 0, &pageParamError{field: "page_size", input: raw}
		}
		pageSize = parsed
	}
	return page, pageSize, nil
}

func (h *AdminHandler) validationError(w http.ResponseWriter, field, msg, input string) {
	ValidationError(w, []ValidationErrorItem{{
		Type: "value_error", Loc: []any{"query", field}, Msg: msg, Input: input,
	}})
}

// readBody 读取请求体(上限 1MB,防滥用)。
func readBody(r *http.Request) ([]byte, error) {
	return io.ReadAll(io.LimitReader(r.Body, 1<<20))
}

var _ = strings.TrimSpace
var _ = time.Now
var _ = uuid.New
