// memories.go 对齐原 app/api/v1/memories.py 的公开端点。
package api

import (
	"context"
	"errors"
	"mime"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"limedia/backend/internal/config"
	"limedia/backend/internal/models"
	"limedia/backend/internal/repo"
	"limedia/backend/internal/services"
)

// NewMemoriesHandler 构造并初始化内部状态。
func NewMemoriesHandler(settings *config.Settings, pool *pgxpool.Pool, query *repo.MemoryQuery, governor *services.TaskGovernor, derivatives *services.DerivativeTasks) *MemoriesHandler {
	return &MemoriesHandler{
		Settings:    settings,
		Pool:        pool,
		Query:       query,
		Governor:    governor,
		Derivatives: derivatives,
		Baidu:       &services.BaiduPanClientFactory{Settings: settings},
		streamUsers: make(map[string]int),
	}
}

// MemoriesHandler 公开 memories 端点。
type MemoriesHandler struct {
	Settings    *config.Settings
	Pool        *pgxpool.Pool
	Query       *repo.MemoryQuery
	Governor    *services.TaskGovernor
	Derivatives *services.DerivativeTasks
	Baidu       *services.BaiduPanClientFactory

	streamMu    sync.Mutex
	streamUsers map[string]int
}

var (
	sortPattern    = regexp.MustCompile(`^(captured_desc|captured_asc|updated_desc|random)$`)
	seedPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	sizePattern    = regexp.MustCompile(`^(240|480|768|1280)$`)
	keywordPattern = regexp.MustCompile(`^.{0,100}$`)
)

// Register 挂载路由(ServeMux)。
func (h *MemoriesHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/memories", h.List)
	mux.HandleFunc("GET /api/v1/memories/recommend", h.Recommend)
	mux.HandleFunc("GET /api/v1/memories/public-counts", h.PublicCounts)
	// 前端契约路径(FastAPI 版即此路径):预热状态对外只暴露这一个;
	// /public/ 前缀是历史别名,一并保留。
	mux.HandleFunc("GET /api/v1/memories/preheat-status", h.PreheatStatus)
	mux.HandleFunc("GET /api/v1/memories/public/preheat-status", h.PreheatStatus)
	mux.HandleFunc("GET /api/v1/memories/{id}", h.Detail)
	mux.HandleFunc("GET /api/v1/memories/{id}/direct-url", h.DirectURL)
	mux.HandleFunc("GET /api/v1/memories/{id}/file", h.Stream)
	mux.HandleFunc("GET /api/v1/memories/{id}/stream", h.Stream)
	mux.HandleFunc("GET /api/v1/memories/{id}/thumbnail", h.Thumbnail)
}

func (h *MemoriesHandler) clientIP(r *http.Request) string {
	host := r.RemoteAddr
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		host = fwd
	}
	if idx := indexByte(host, ':'); idx > 0 {
		return host[:idx]
	}
	if host == "" {
		return "unknown"
	}
	return host
}

func indexByte(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}

// validationError 按 FastAPI 422 结构输出 query 校验错误。
func (h *MemoriesHandler) validationError(w http.ResponseWriter, field, msg, input string) {
	ValidationError(w, []ValidationErrorItem{{
		Type: "value_error", Loc: []any{"query", field}, Msg: msg, Input: input,
	}})
}

// taskHTTPError 429 + Retry-After(对齐 _task_http_error)。
func taskHTTPError(w http.ResponseWriter, err error) {
	var rejected *services.TaskRejected
	if errors.As(err, &rejected) {
		w.Header().Set("Retry-After", strconv.Itoa(maxInt64(1, int(rejected.RetryAfter))))
		ErrorDetail(w, http.StatusTooManyRequests, rejected.Detail)
		return
	}
	ErrorDetail(w, http.StatusInternalServerError, "internal error")
}

func maxInt64(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// publicVisibilityCheck 详情/直链/流/缩略图共用的公开口径检查。
// 返回 memory 与 primary file;不可见时已写 404。
func (h *MemoriesHandler) publicVisibilityCheck(ctx context.Context, w http.ResponseWriter, id uuid.UUID) (*models.Memory, *models.MemoryFile, bool) {
	memory, err := h.Query.GetByID(ctx, id)
	if err != nil {
		ErrorDetail(w, http.StatusInternalServerError, "database error")
		return nil, nil, false
	}
	if memory == nil || memory.Status != models.MemoryStatusPublished {
		ErrorDetail(w, http.StatusNotFound, "memory not found")
		return nil, nil, false
	}
	hasBaidupan := false
	for i := range memory.Files {
		if memory.Files[i].Source == "baidupan" {
			hasBaidupan = true
			break
		}
	}
	if !hasBaidupan || repo.GetPublicVisibilityState(memory) == "excluded" {
		ErrorDetail(w, http.StatusNotFound, "memory not found")
		return nil, nil, false
	}
	return memory, repo.PrimaryPublicFile(memory), true
}

// List 公开分页列表。
func (h *MemoriesHandler) List(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	kind := q.Get("kind")
	if kind != "" && kind != "photo" && kind != "video" {
		h.validationError(w, "kind", "Input should be 'photo' or 'video'", kind)
		return
	}
	keyword := q.Get("keyword")
	if len(keyword) > 100 {
		h.validationError(w, "keyword", "String should have at most 100 characters", keyword)
		return
	}
	page, err := strconv.Atoi(q.Get("page"))
	if err != nil || page < 1 {
		h.validationError(w, "page", "Input should be greater than or equal to 1", q.Get("page"))
		return
	}
	pageSize := 24
	if raw := q.Get("page_size"); raw != "" {
		pageSize, err = strconv.Atoi(raw)
		if err != nil || pageSize < 1 || pageSize > 100 {
			h.validationError(w, "page_size", "Input should be greater than or equal to 1", raw)
			return
		}
	}
	sort := q.Get("sort")
	if sort == "" {
		sort = "captured_desc"
	}
	if !sortPattern.MatchString(sort) {
		h.validationError(w, "sort", "String should match pattern '"+sortPattern.String()+"'", sort)
		return
	}
	seed := q.Get("seed")
	if seed != "" && !seedPattern.MatchString(seed) {
		h.validationError(w, "seed", "String should match pattern '"+seedPattern.String()+"'", seed)
		return
	}

	// 匿名公开列表才可走网关短缓存;带 cookie/凭证或随机序一律 no-store。
	hasSessionOrCredentials := r.Header.Get("Authorization") != "" || len(r.Cookies()) > 0
	cacheControl := "public, max-age=15, stale-while-revalidate=30"
	if hasSessionOrCredentials || sort == "random" {
		cacheControl = "no-store"
	}
	w.Header().Set("Cache-Control", cacheControl)

	result, err := h.Query.ListPublic(r.Context(), repo.ListOptions{
		Kind:                  kind,
		Keyword:               keyword,
		Sort:                  sort,
		Seed:                  seed,
		Page:                  page,
		PageSize:              pageSize,
		RequireHomeDerivative: true,
	})
	if err != nil {
		ErrorDetail(w, http.StatusInternalServerError, "database error")
		return
	}

	items := make([]*MemorySummary, len(result.Items))
	for i, m := range result.Items {
		items[i] = toMemorySummary(m)
	}
	WriteJSON(w, http.StatusOK, MemorySummaryListResponse{
		Items:    items,
		Total:    result.Total,
		Page:     page,
		PageSize: pageSize,
		Counts: MemoryCounts{
			Photo: result.PhotoCount,
			Video: result.VideoCount,
		},
		PublicCounts: MemoryCounts{
			Photo: result.PublicPhotoCount,
			Video: result.PublicTotal - result.PublicPhotoCount,
		},
	})
}

// Recommend 访问级推荐(随机序,home 派生门槛)。
func (h *MemoriesHandler) Recommend(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	kind := q.Get("kind")
	if kind != "" && kind != "photo" && kind != "video" {
		h.validationError(w, "kind", "Input should be 'photo' or 'video'", kind)
		return
	}
	limit := 8
	if raw := q.Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 24 {
			h.validationError(w, "limit", "Input should be greater than or equal to 1", raw)
			return
		}
		limit = parsed
	}

	// 访问级推荐,不允许浏览器复用。
	w.Header().Set("Cache-Control", "no-store")

	result, err := h.Query.ListRecommend(r.Context(), kind, limit)
	if err != nil {
		ErrorDetail(w, http.StatusInternalServerError, "database error")
		return
	}
	items := make([]*MemorySummary, len(result))
	for i, m := range result {
		items[i] = toMemorySummary(m)
	}
	WriteJSON(w, http.StatusOK, items)
}

// PublicCounts 全站公开计数。
func (h *MemoriesHandler) PublicCounts(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "public, max-age=15")

	total, photo, err := h.Query.PublicCounts(r.Context())
	if err != nil {
		ErrorDetail(w, http.StatusInternalServerError, "database error")
		return
	}
	WriteJSON(w, http.StatusOK, PublicMediaCounts{
		Total: total,
		Photo: photo,
		Video: total - photo,
	})
}

// Detail 公开详情。
func (h *MemoriesHandler) Detail(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		ErrorDetail(w, http.StatusNotFound, "memory not found")
		return
	}
	memory, _, ok := h.publicVisibilityCheck(r.Context(), w, id)
	if !ok {
		return
	}
	WriteJSON(w, http.StatusOK, toMemorySummary(memory))
}

// DirectURL 短时直链签发(百度未配置时 502,契约样本 16)。
func (h *MemoriesHandler) DirectURL(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		ErrorDetail(w, http.StatusNotFound, "memory not found")
		return
	}
	purpose := r.URL.Query().Get("purpose")
	if purpose == "" {
		purpose = "play"
	}
	if purpose != "play" && purpose != "download" {
		h.validationError(w, "purpose", "Input should be 'play' or 'download'", purpose)
		return
	}

	memory, memoryFile, ok := h.publicVisibilityCheck(r.Context(), w, id)
	if !ok {
		return
	}
	if memoryFile == nil || memoryFile.RemoteID == nil {
		ErrorDetail(w, http.StatusNotFound, "memory file not found")
		return
	}

	client, err := h.Baidu.New()
	if err != nil {
		ErrorDetail(w, http.StatusBadGateway, err.Error())
		return
	}

	var directURL string
	ttlSeconds := 0
	slotErr := func() error {
		_, release, err := h.Governor.Slot(r.Context(), services.TaskTypeDirectProbe, 50, nil)
		if err != nil {
			return err
		}
		defer release()
		directURL, ttlSeconds, err = client.ResolveDirectURL(r.Context(), *memoryFile.RemoteID)
		return err
	}()
	if slotErr != nil {
		var baiduErr *services.BaiduPanError
		if errors.As(slotErr, &baiduErr) {
			if baiduErr.Error() == "百度网盘接口限流，请稍后重试" {
				h.Governor.Metrics.RecordRateLimited(services.TaskTypeDirectProbe)
			}
			h.Governor.Metrics.RecordFailed(services.TaskTypeDirectProbe)
			detail := baiduErr.Error()
			_ = services.RecordAdminOperation(h.Pool, "direct_url_failed",
				strPtr("memory"), strPtr(memory.ID.String()), nil, &detail)
			ErrorDetail(w, http.StatusBadGateway, detail)
			return
		}
		taskHTTPError(w, slotErr)
		return
	}
	h.Governor.Metrics.RecordCompleted(services.TaskTypeDirectProbe)

	// 直链签发是高频公开行为,不写管理审计;浏览器不得持久化。
	w.Header().Set("Cache-Control", "no-store")

	var expiresAt *string
	if ttlSeconds > 0 {
		at := time.Now().UTC().Add(time.Duration(ttlSeconds) * time.Second)
		expiresAt = apiTimeString(&at)
	}
	WriteJSON(w, http.StatusOK, MemoryDirectLinkResponse{
		DirectURL: directURL,
		ExpiresAt: expiresAt,
		MimeType:  memoryFile.MimeType,
		SizeBytes: memoryFile.SizeBytes,
	})
}

// Stream 本地文件优先,否则百度 Range 代理流(对齐 stream_memory)。
func (h *MemoriesHandler) Stream(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		ErrorDetail(w, http.StatusNotFound, "memory not found")
		return
	}
	memory, memoryFile, ok := h.publicVisibilityCheck(r.Context(), w, id)
	if !ok {
		return
	}
	if memoryFile == nil {
		ErrorDetail(w, http.StatusNotFound, "memory file not found")
		return
	}

	// 本地文件存在 → ServeContent 原生支持 Range/206。
	if target := services.ResolveMediaPath(h.Settings.MediaRoot, memoryFile.SourcePath); target != nil {
		if info, statErr := os.Stat(*target); statErr == nil && info.Mode().IsRegular() {
			file, openErr := os.Open(*target)
			if openErr == nil {
				defer file.Close()
				w.Header().Set("Content-Type", memoryFile.MimeType)
				w.Header().Set("Content-Disposition",
					`inline; filename="`+sanitizeDisposition(memoryFile.RemotePath)+`"`)
				http.ServeContent(w, r, memoryFile.RemotePath, info.ModTime(), file)
				return
			}
		}
	}

	// 远程代理流:全局槽位 + 每用户并发计数。
	timeout := durSec(h.Settings.StreamWaitTimeoutSec)
	_, releaseSlot, err := h.Governor.Slot(r.Context(), services.TaskTypeStream, 50, &timeout)
	if err != nil {
		taskHTTPError(w, err)
		return
	}

	userKey := h.clientIP(r)
	if !h.acquireUserSlot(userKey) {
		releaseSlot()
		h.Governor.Metrics.RecordRejected(services.TaskTypeStream)
		w.Header().Set("Retry-After", "1")
		ErrorDetail(w, http.StatusTooManyRequests, "同一用户的视频回退流已达上限")
		return
	}
	releaseUser := h.releaseUserSlot(userKey)

	client, err := h.Baidu.New()
	if err != nil {
		releaseSlot()
		releaseUser()
		ErrorDetail(w, http.StatusBadGateway, err.Error())
		return
	}

	statusCode, contentLength, contentRange, contentType, body, openErr :=
		client.OpenStream(r.Context(), deref(memoryFile.RemoteID), r.Header.Get("Range"))
	if openErr != nil {
		releaseSlot()
		releaseUser()
		var baiduErr *services.BaiduPanError
		if errors.As(openErr, &baiduErr) {
			h.Governor.Metrics.RecordFailed(services.TaskTypeStream)
			_ = h.updateStreamFailed(memoryFile.ID, baiduErr.Error())
			detail := baiduErr.Error()
			if detail == "" {
				detail = "远程媒体暂时无法播放"
			}
			_ = services.RecordAdminOperation(h.Pool, "stream_proxy_failed",
				strPtr("memory"), strPtr(memory.ID.String()), nil, &detail)
			ErrorDetail(w, http.StatusBadGateway, detail)
			return
		}
		taskHTTPError(w, openErr)
		return
	}

	h.Governor.Metrics.RecordCompleted(services.TaskTypeStream)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", "no-store")
	if contentRange != "" {
		w.Header().Set("Content-Range", contentRange)
	}
	if contentLength != nil {
		w.Header().Set("Content-Length", strconv.FormatInt(*contentLength, 10))
	}
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(statusOf(statusCode, contentRange))

	// 拷贝完成后释放槽位与用户计数;客户端断开也要保证释放。
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		defer body.Close()
		_, _ = copyBody(w, body, r)
		releaseSlot()
		releaseUser()
	}()
	_ = finished
}

func statusOf(statusCode int, contentRange string) int {
	if contentRange != "" {
		return http.StatusPartialContent
	}
	if statusCode == 0 {
		return http.StatusOK
	}
	return statusCode
}

func copyBody(w http.ResponseWriter, body ioReader, r *http.Request) (int64, error) {
	buf := make([]byte, 32*1024)
	var total int64
	flusher, _ := w.(http.Flusher)
	for {
		select {
		case <-r.Context().Done():
			return total, r.Context().Err()
		default:
		}
		n, err := body.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				return total, writeErr
			}
			if flusher != nil {
				flusher.Flush()
			}
			total += int64(n)
		}
		if err != nil {
			return total, err
		}
	}
}

func (h *MemoriesHandler) acquireUserSlot(userKey string) bool {
	h.streamMu.Lock()
	defer h.streamMu.Unlock()
	if h.streamUsers[userKey] >= h.Settings.StreamUserConcurrencyLimit {
		return false
	}
	h.streamUsers[userKey]++
	return true
}

func (h *MemoriesHandler) releaseUserSlot(userKey string) func() {
	return func() {
		h.streamMu.Lock()
		defer h.streamMu.Unlock()
		h.streamUsers[userKey]--
		if h.streamUsers[userKey] <= 0 {
			delete(h.streamUsers, userKey)
		}
	}
}

// updateStreamFailed 标记远程流失败(供重试治理)。
func (h *MemoriesHandler) updateStreamFailed(fileID uuid.UUID, errDetail string) error {
	_, execErr := h.Pool.Exec(context.Background(),
		`UPDATE memory_files SET stream_state = $1, sync_error = $2, updated_at = now() WHERE id = $3`,
		models.RemoteStreamStateFailed, errDetail, fileID)
	return execErr
}

func sanitizeDisposition(name string) string {
	out := make([]byte, 0, len(name))
	for i := 0; i < len(name); i++ {
		c := name[i]
		if c == '"' || c == '\\' || c < 0x20 {
			continue
		}
		out = append(out, c)
	}
	return string(out)
}

func strPtr(s string) *string { return &s }

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func durSec(seconds float64) time.Duration {
	return time.Duration(seconds * float64(time.Second))
}

func guessImageMime(name string) string {
	if t := mime.TypeByExtension(".webp"); t != "" {
		return t
	}
	return "image/webp"
}
