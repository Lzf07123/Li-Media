package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"limedia/backend/internal/config"
	"limedia/backend/internal/db"
	"limedia/backend/internal/httpx"
	"limedia/backend/internal/repo"
	"limedia/backend/internal/services"
)

// apiTestPool 对容器 Postgres 建独立测试库:迁移后使用,测试完即弃。
// 与 services/repo 包的测试助手同模式(包内独立维护,避免导出测试代码)。
func apiTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	base := os.Getenv("GO_TEST_DATABASE_URL")
	if base == "" {
		base = "postgres://media:media@limedia-baseline-db:5432/media"
	}

	adminURL := base
	testDB := "limedia_api_test_" + uuid.NewString()[:8]
	admin, err := pgxpool.New(context.Background(), adminURL)
	if err != nil {
		t.Fatalf("连接测试宿主失败: %v", err)
	}
	defer admin.Close()
	if _, err := admin.Exec(context.Background(), "CREATE DATABASE "+testDB); err != nil {
		t.Fatalf("创建测试库失败: %v", err)
	}

	parsed, err := url.Parse(base)
	if err != nil {
		t.Fatalf("解析测试库地址失败: %v", err)
	}
	parsed.Path = "/" + testDB
	testURL := parsed.String()

	pool, err := pgxpool.New(context.Background(), testURL)
	if err != nil {
		t.Fatalf("连接测试库失败: %v", err)
	}
	if err := db.MigrateUp(testURL); err != nil {
		t.Fatalf("迁移测试库失败: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		drop, _ := pgxpool.New(context.Background(), adminURL)
		defer drop.Close()
		_, _ = drop.Exec(context.Background(), "DROP DATABASE "+testDB+" WITH (FORCE)")
	})
	return pool
}

func apiTestSettings(t *testing.T, overrides map[string]string) *config.Settings {
	t.Helper()
	base := map[string]string{
		"ADMIN_TOKEN":            "test-admin-token",
		"DATABASE_URL":           "postgres://media:media@limedia-baseline-db:5432/media",
		"TRUSTED_PROXY_CIDRS":    "",
		"PUBLIC_BASE_URL":        "http://127.0.0.1:8080",
		"CORS_ORIGINS":           "http://allowed.example",
		"ADMIN_LOGIN_BASE_DELAY": "0",
		"ADMIN_LOGIN_MAX_DELAY":  "0",
	}
	for key, value := range base {
		t.Setenv(key, value)
	}
	for key, value := range overrides {
		t.Setenv(key, value)
	}
	settings, err := config.Load()
	if err != nil {
		t.Fatalf("配置加载失败: %v", err)
	}
	return settings
}

func adminRouter(t *testing.T, settings *config.Settings, pool *pgxpool.Pool, maxAttempts int) http.Handler {
	t.Helper()
	admin := &AdminHandler{
		Settings: settings,
		Pool:     pool,
		Query:    &repo.MemoryQuery{Pool: pool, DerivativeVersion: settings.MediaDerivativeVersion},
		Governor: services.NewTaskGovernor(settings),
		Sessions: &services.AdminSessions{Pool: pool},
		Limiter:  services.NewAdminLoginRateLimiter(maxAttempts, 0, 0),
	}
	return httpx.SecurityHeaders((&Router{Admin: admin}).Handler())
}

func postLogin(t *testing.T, handler http.Handler, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/login", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	return recorder
}

func decodeDetail(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var payload struct {
		Detail any `json:"detail"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是 JSON: %v (%s)", err, recorder.Body.String())
	}
	switch detail := payload.Detail.(type) {
	case string:
		return detail
	case []any:
		if len(detail) == 0 {
			return ""
		}
		if item, ok := detail[0].(map[string]any); ok {
			return fmt.Sprint(item["msg"])
		}
	}
	return ""
}

func TestAdminEndpointsRequireSession(t *testing.T) {
	pool := apiTestPool(t)
	settings := apiTestSettings(t, nil)
	handler := adminRouter(t, settings, pool, 5)

	for _, path := range []string{
		"/api/v1/admin/memories",
		"/api/v1/admin/tasks/metrics",
		"/api/v1/admin/system/status",
	} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("%s 未认证状态 = %d, want 401", path, recorder.Code)
		}
		if got := decodeDetail(t, recorder); got != "管理会话缺失或已过期" {
			t.Fatalf("%s detail = %q", path, got)
		}
		if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Fatalf("%s 缺少安全头, got %q", path, got)
		}
	}
}

func TestAdminLoginSessionLifecycle(t *testing.T) {
	pool := apiTestPool(t)
	settings := apiTestSettings(t, nil)
	handler := adminRouter(t, settings, pool, 5)

	wrong := postLogin(t, handler, `{"token":"wrong"}`, nil)
	if wrong.Code != http.StatusUnauthorized {
		t.Fatalf("错误令牌状态 = %d, want 401", wrong.Code)
	}

	ok := postLogin(t, handler, `{"token":"test-admin-token"}`, nil)
	if ok.Code != http.StatusNoContent {
		t.Fatalf("正确令牌状态 = %d, want 204", ok.Code)
	}
	cookies := ok.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("应返回 1 个会话 cookie, got %d", len(cookies))
	}
	sessionCookie := cookies[0]
	if sessionCookie.Name != settings.AdminCookieName || !sessionCookie.HttpOnly ||
		sessionCookie.SameSite != http.SameSiteLaxMode || sessionCookie.Path != "/" {
		t.Fatalf("cookie 属性不符合安全要求: %+v", sessionCookie)
	}

	list := httptest.NewRecorder()
	listReq := httptest.NewRequest(http.MethodGet, "/api/v1/admin/memories", nil)
	listReq.AddCookie(sessionCookie)
	handler.ServeHTTP(list, listReq)
	if list.Code != http.StatusOK {
		t.Fatalf("带会话访问状态 = %d, want 200", list.Code)
	}

	// 数据库只保存哈希,原始令牌不得落库。
	var stored string
	if err := pool.QueryRow(context.Background(),
		`SELECT token_hash FROM admin_sessions ORDER BY created_at DESC LIMIT 1`).Scan(&stored); err != nil {
		t.Fatalf("读取会话失败: %v", err)
	}
	if stored == sessionCookie.Value || len(stored) != 64 {
		t.Fatal("会话令牌必须以 64 位 sha256 哈希落库")
	}

	logout := httptest.NewRecorder()
	logoutReq := httptest.NewRequest(http.MethodPost, "/api/v1/admin/logout", nil)
	logoutReq.AddCookie(sessionCookie)
	handler.ServeHTTP(logout, logoutReq)
	if logout.Code != http.StatusNoContent {
		t.Fatalf("登出状态 = %d, want 204", logout.Code)
	}

	reuse := httptest.NewRecorder()
	reuseReq := httptest.NewRequest(http.MethodGet, "/api/v1/admin/memories", nil)
	reuseReq.AddCookie(sessionCookie)
	handler.ServeHTTP(reuse, reuseReq)
	if reuse.Code != http.StatusUnauthorized {
		t.Fatalf("登出后复用旧 cookie 状态 = %d, want 401", reuse.Code)
	}
}

func TestLoginLockoutIgnoresSpoofedForwardedFor(t *testing.T) {
	pool := apiTestPool(t)
	settings := apiTestSettings(t, map[string]string{"TRUSTED_PROXY_CIDRS": ""})
	handler := adminRouter(t, settings, pool, 2)

	remote := "198.51.100.9:5555"
	codes := make([]int, 0, 3)
	for i := 1; i <= 3; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/login", strings.NewReader(`{"token":"wrong"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Forwarded-For", fmt.Sprintf("203.0.113.%d", i))
		req.RemoteAddr = remote
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		codes = append(codes, recorder.Code)
	}
	want := []int{http.StatusUnauthorized, http.StatusUnauthorized, http.StatusTooManyRequests}
	for i := range want {
		if codes[i] != want[i] {
			t.Fatalf("轮换伪造 XFF 的第 %d 次状态 = %d, want %d(全部 %v)", i+1, codes[i], want[i], codes)
		}
	}
}

func TestLoginTrustsForwardedForOnlyFromProxy(t *testing.T) {
	pool := apiTestPool(t)
	settings := apiTestSettings(t, map[string]string{"TRUSTED_PROXY_CIDRS": "172.30.0.0/24"})
	handler := adminRouter(t, settings, pool, 2)

	remote := "172.30.0.2:41000"
	codes := make([]int, 0, 4)
	for _, forwarded := range []string{"203.0.113.5", "203.0.113.6", "203.0.113.5", "203.0.113.5"} {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/login", strings.NewReader(`{"token":"wrong"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Forwarded-For", forwarded)
		req.RemoteAddr = remote
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		codes = append(codes, recorder.Code)
	}
	want := []int{http.StatusUnauthorized, http.StatusUnauthorized, http.StatusUnauthorized, http.StatusTooManyRequests}
	for i := range want {
		if codes[i] != want[i] {
			t.Fatalf("受信代理透传的第 %d 次状态 = %d, want %d(全部 %v)", i+1, codes[i], want[i], codes)
		}
	}
}

func seedMemory(t *testing.T, pool *pgxpool.Pool, memoryID uuid.UUID, status string, derivativeVersion string) {
	t.Helper()
	ctx := context.Background()
	fileID := uuid.New()
	_, err := pool.Exec(ctx,
		`INSERT INTO memories (id, title, description, kind, status, captured_at, width, height)
		 VALUES ($1, '测试回忆', '', 'photo', $2, now(), 4000, 3000)`,
		memoryID, status)
	if err != nil {
		t.Fatalf("写入 memory 失败: %v", err)
	}
	_, err = pool.Exec(ctx,
		`INSERT INTO memory_files (id, memory_id, source, remote_path, remote_id, source_path, parent_path, filename, mime_type, remote_state, thumbnail_state, stream_state, browser_compatibility, status)
		 VALUES ($1, $2, 'baidupan', '/photos/test.jpg', 'remote-1', '', '/photos', 'test.jpg', 'image/jpeg', 'ready', 'ready', 'unavailable', 'unknown', 'matched')`,
		fileID, memoryID)
	if err != nil {
		t.Fatalf("写入 memory_file 失败: %v", err)
	}
	_, err = pool.Exec(ctx,
		`INSERT INTO memory_derivative_caches (id, memory_file_id, max_size, derivative_version, status)
		 VALUES ($1, $2, 240, $3, 'ready')`, uuid.New(), fileID, derivativeVersion)
	if err != nil {
		t.Fatalf("写入派生缓存失败: %v", err)
	}
}

func TestPublicListDefaultsAndDraftVisibility(t *testing.T) {
	pool := apiTestPool(t)
	settings := apiTestSettings(t, nil)
	published := uuid.MustParse("00000000-0000-4000-8000-0000000000aa")
	draft := uuid.MustParse("00000000-0000-4000-8000-0000000000bb")
	seedMemory(t, pool, published, "published", settings.MediaDerivativeVersion)
	seedMemory(t, pool, draft, "draft", settings.MediaDerivativeVersion)

	governor := services.NewTaskGovernor(settings)
	memories := NewMemoriesHandler(settings, pool,
		&repo.MemoryQuery{Pool: pool, DerivativeVersion: settings.MediaDerivativeVersion},
		governor,
		&services.DerivativeTasks{Settings: settings, Governor: governor},
	)
	handler := httpx.SecurityHeaders((&Router{Memories: memories}).Handler())

	// 缺省 page/page_size 必须等同于 page=1&page_size=24(FastAPI 默认值)。
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/memories", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("缺省列表状态 = %d, want 200(%s)", recorder.Code, recorder.Body.String())
	}
	var list MemorySummaryListResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &list); err != nil {
		t.Fatalf("列表响应解析失败: %v", err)
	}
	if list.Page != 1 || list.PageSize != 24 {
		t.Fatalf("默认分页 = %d/%d, want 1/24", list.Page, list.PageSize)
	}
	if list.Total != 1 || len(list.Items) != 1 || list.Items[0].ID != published.String() {
		t.Fatalf("公开列表应只含 published 记忆, got total=%d items=%d", list.Total, len(list.Items))
	}

	// 上限校验文案与 FastAPI 一致,不能把 101 误报为「大于等于 1」。
	tooLarge := httptest.NewRecorder()
	handler.ServeHTTP(tooLarge, httptest.NewRequest(http.MethodGet, "/api/v1/memories?page_size=101", nil))
	if tooLarge.Code != http.StatusUnprocessableEntity {
		t.Fatalf("page_size=101 状态 = %d, want 422", tooLarge.Code)
	}
	if detail := decodeDetail(t, tooLarge); detail != "Input should be less than or equal to 100" {
		t.Fatalf("page_size=101 detail = %q", detail)
	}

	// 草稿详情必须 404,避免公开面泄露未发布内容。
	detailRecorder := httptest.NewRecorder()
	handler.ServeHTTP(detailRecorder, httptest.NewRequest(http.MethodGet, "/api/v1/memories/"+draft.String(), nil))
	if detailRecorder.Code != http.StatusNotFound {
		t.Fatalf("草稿详情状态 = %d, want 404", detailRecorder.Code)
	}
	if got := decodeDetail(t, detailRecorder); got != "memory not found" {
		t.Fatalf("草稿详情 detail = %q", got)
	}
}

func TestCORSPreflightAllowlist(t *testing.T) {
	cors := NewCORS("http://allowed.example")

	allowed := httptest.NewRequest(http.MethodOptions, "/api/v1/admin/login", nil)
	allowed.Header.Set("Origin", "http://allowed.example")
	allowed.Header.Set("Access-Control-Request-Method", "POST")
	recorder := httptest.NewRecorder()
	cors.Middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("预检不应进入下游")
	})).ServeHTTP(recorder, allowed)
	if recorder.Code != http.StatusOK {
		t.Fatalf("预检状态 = %d, want 200", recorder.Code)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "http://allowed.example" {
		t.Fatalf("允许来源 = %q", got)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("凭证头 = %q", got)
	}

	denied := httptest.NewRequest(http.MethodOptions, "/api/v1/admin/login", nil)
	denied.Header.Set("Origin", "http://evil.example")
	denied.Header.Set("Access-Control-Request-Method", "POST")
	deniedRecorder := httptest.NewRecorder()
	cors.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})).ServeHTTP(deniedRecorder, denied)
	if got := deniedRecorder.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("非白名单来源不得回显, got %q", got)
	}
}

func TestUnsupportedMethodReturns405WithAllow(t *testing.T) {
	// 只做路由匹配,不进入业务处理器,因此无需数据库。
	handler := (&Router{
		Health:   &HealthHandler{},
		Memories: &MemoriesHandler{},
		Admin:    &AdminHandler{},
	}).Handler()

	cases := []struct {
		method    string
		path      string
		wantAllow string
	}{
		{http.MethodPost, "/api/v1/memories", "GET, HEAD"},
		{http.MethodPatch, "/api/v1/admin/memories", "GET, HEAD"},
		{http.MethodGet, "/api/v1/admin/login", "POST"},
	}
	for _, tc := range cases {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(tc.method, tc.path, nil))
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s %s 状态 = %d, want 405", tc.method, tc.path, recorder.Code)
		}
		if got := recorder.Header().Get("Allow"); got != tc.wantAllow {
			t.Fatalf("%s %s Allow = %q, want %q", tc.method, tc.path, got, tc.wantAllow)
		}
		if got := decodeDetail(t, recorder); got != "Method Not Allowed" {
			t.Fatalf("%s %s detail = %q", tc.method, tc.path, got)
		}
	}

	// 未注册路径仍是 404,不能被 405 探测误伤。
	missing := httptest.NewRecorder()
	handler.ServeHTTP(missing, httptest.NewRequest(http.MethodPost, "/api/v1/does-not-exist", nil))
	if missing.Code != http.StatusNotFound {
		t.Fatalf("未注册路径状态 = %d, want 404", missing.Code)
	}
}

func TestAdminCleanupReturnsNestedStats(t *testing.T) {
	pool := apiTestPool(t)
	settings := apiTestSettings(t, nil)
	handler := adminRouter(t, settings, pool, 5)

	login := postLogin(t, handler, `{"token":"test-admin-token"}`, nil)
	if login.Code != http.StatusNoContent {
		t.Fatalf("登录状态 = %d", login.Code)
	}
	cookies := login.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("会话 cookie 数量 = %d", len(cookies))
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/cleanup", strings.NewReader(`{"confirm":false}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookies[0])
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("清理 dry-run 状态 = %d, want 200(%s)", recorder.Code, recorder.Body.String())
	}

	var payload struct {
		DryRun       bool           `json:"dry_run"`
		Stats        map[string]any `json:"stats"`
		Duration     *float64       `json:"duration_seconds"`
		CompletedAt  *string        `json:"completed_at"`
		FileCleanErr any            `json:"file_cleanup_error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("清理响应解析失败: %v", err)
	}
	if !payload.DryRun {
		t.Fatal("dry_run 应为 true")
	}
	for _, key := range []string{
		"memories", "remote_file_indexes", "scan_tasks",
		"thumbnail_files", "estimated_bytes_to_free",
	} {
		if _, ok := payload.Stats[key]; !ok {
			t.Fatalf("stats 缺少 %q, got %v", key, payload.Stats)
		}
	}
	if _, ok := payload.Stats["nginx_cache_files"]; ok {
		t.Fatal("stats 不应再包含 nginx_cache_files")
	}
	if payload.Duration == nil || *payload.Duration != 0 {
		t.Fatalf("dry-run duration = %v, want 0", payload.Duration)
	}
	if payload.CompletedAt != nil {
		t.Fatalf("dry-run completed_at = %v, want null", *payload.CompletedAt)
	}
}

func TestAdminBackgroundJobsCanBeCreated(t *testing.T) {
	pool := apiTestPool(t)
	settings := apiTestSettings(t, nil)
	handler := adminRouter(t, settings, pool, 5)

	login := postLogin(t, handler, `{"token":"test-admin-token"}`, nil)
	if login.Code != http.StatusNoContent {
		t.Fatalf("登录状态 = %d, want 204", login.Code)
	}
	cookies := login.Result().Cookies()

	post := func(path, body string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		for _, cookie := range cookies {
			req.AddCookie(cookie)
		}
		handler.ServeHTTP(recorder, req)
		return recorder
	}

	// 两个后台任务创建路径都必须能写入 admin_background_jobs。
	if recorder := post("/api/v1/admin/memories/batch-status",
		`{"target_status":"published","confirm":true}`); recorder.Code != http.StatusAccepted {
		t.Fatalf("批量状态任务状态 = %d, want 202 (%s)", recorder.Code, recorder.Body.String())
	}
	if recorder := post("/api/v1/admin/browser-compatibility/probe",
		`{"limit":5}`); recorder.Code != http.StatusAccepted {
		t.Fatalf("兼容探测任务状态 = %d, want 202 (%s)", recorder.Code, recorder.Body.String())
	}

	var count int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM admin_background_jobs
		 WHERE action IN ('batch_status_published', 'browser_compatibility_probe')`).Scan(&count); err != nil {
		t.Fatalf("读取后台任务失败: %v", err)
	}
	if count != 2 {
		t.Fatalf("后台任务数 = %d, want 2", count)
	}

	// latest 查询的 action 必须与创建时一致,否则管理页永远看不到任务。
	get := func(path string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		for _, cookie := range cookies {
			req.AddCookie(cookie)
		}
		handler.ServeHTTP(recorder, req)
		return recorder
	}
	for _, path := range []string{
		"/api/v1/admin/memories/batch-status/latest",
		"/api/v1/admin/browser-compatibility/probe/latest",
	} {
		if recorder := get(path); recorder.Code != http.StatusOK {
			t.Fatalf("%s 状态 = %d, want 200 (%s)", path, recorder.Code, recorder.Body.String())
		}
	}
}

func TestAdminReadEndpointsReturnOK(t *testing.T) {
	pool := apiTestPool(t)
	// 无效 Redis 地址让健康探测立即返回 unavailable,避免测试等待连接超时。
	settings := apiTestSettings(t, map[string]string{"REDIS_URL": "::invalid::"})
	handler := adminRouter(t, settings, pool, 5)

	login := postLogin(t, handler, `{"token":"test-admin-token"}`, nil)
	if login.Code != http.StatusNoContent {
		t.Fatalf("登录状态 = %d, want 204", login.Code)
	}
	cookies := login.Result().Cookies()

	get := func(path string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		for _, cookie := range cookies {
			req.AddCookie(cookie)
		}
		handler.ServeHTTP(recorder, req)
		return recorder
	}

	// 后台管理读接口会直接走库/schema,逐一确认没有列名或表名漂移。
	for _, path := range []string{
		"/api/v1/admin/memories",
		"/api/v1/admin/remote-config",
		"/api/v1/admin/remote-scan/latest",
		"/api/v1/admin/memories/batch-status/latest",
		"/api/v1/admin/tasks/metrics",
		"/api/v1/admin/system/status",
		"/api/v1/admin/thumbnails/preheat/latest",
		"/api/v1/admin/thumbnails/preheat/preview",
	} {
		if recorder := get(path); recorder.Code != http.StatusOK {
			t.Fatalf("%s 状态 = %d, want 200 (%s)", path, recorder.Code, recorder.Body.String())
		}
	}

	// 无探测历史时按契约返回 404。
	if recorder := get("/api/v1/admin/browser-compatibility/latest"); recorder.Code != http.StatusNotFound {
		t.Fatalf("兼容探测历史状态 = %d, want 404 (%s)", recorder.Code, recorder.Body.String())
	}
}
