package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestHandler(t *testing.T) *Handler {
	t.Helper()
	handler, err := New()
	if err != nil {
		t.Fatalf("初始化静态处理器失败: %v", err)
	}
	return handler
}

func TestServeSPAFallbackNeverLeaksFilesystem(t *testing.T) {
	handler := newTestHandler(t)

	for _, path := range []string{
		"/",
		"/../../etc/passwd",
		"/%2e%2e/%2e%2e/etc/passwd",
		"/assets/missing.js",
	} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s 状态 = %d, want 200(SPA fallback)", path, recorder.Code)
		}
		if body := recorder.Body.String(); strings.Contains(body, "root:x:") {
			t.Fatalf("%s 泄露了文件系统内容", path)
		}
		if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Fatalf("%s 缺少安全头, got %q", path, got)
		}
		if got := recorder.Header().Get("Content-Security-Policy"); got == "" {
			t.Fatalf("%s 缺少 CSP", path)
		}
	}
}

func TestServeRejectsNonReadMethods(t *testing.T) {
	handler := newTestHandler(t)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/", nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST 状态 = %d, want 405", recorder.Code)
	}
	if got := recorder.Header().Get("Allow"); got != "GET, HEAD" {
		t.Fatalf("Allow = %q", got)
	}
}

func TestServeIndexConditionalRequest(t *testing.T) {
	handler := newTestHandler(t)
	first := httptest.NewRecorder()
	handler.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/", nil))
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("index 响应缺少 ETag")
	}

	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("If-None-Match", etag)
	second := httptest.NewRecorder()
	handler.ServeHTTP(second, request)
	if second.Code != http.StatusNotModified {
		t.Fatalf("协商缓存状态 = %d, want 304", second.Code)
	}
}
