package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSecurityHeadersAppliedToEveryResponse(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusNotFound, http.StatusUnauthorized} {
		handler := SecurityHeaders(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(status)
		}))
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/anything", nil))

		if got := recorder.Code; got != status {
			t.Fatalf("status = %d, want %d", got, status)
		}
		headers := recorder.Header()
		checks := map[string]string{
			"X-Content-Type-Options":  "nosniff",
			"Referrer-Policy":         "no-referrer",
			"Content-Security-Policy": ContentSecurityPolicy,
			"Permissions-Policy":      "camera=(), microphone=(), geolocation=()",
		}
		for name, want := range checks {
			if got := headers.Get(name); got != want {
				t.Fatalf("%s = %q, want %q", name, got, want)
			}
		}
	}
}

func TestHSTSOnlyForHTTPS(t *testing.T) {
	handler := SecurityHeaders(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	plain := httptest.NewRecorder()
	handler.ServeHTTP(plain, httptest.NewRequest(http.MethodGet, "/", nil))
	if got := plain.Header().Get("Strict-Transport-Security"); got != "" {
		t.Fatalf("明码 http 不应发 HSTS, got %q", got)
	}

	proxied := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	handler.ServeHTTP(proxied, req)
	if got := proxied.Header().Get("Strict-Transport-Security"); got == "" {
		t.Fatal("https 透传时缺少 HSTS")
	}
}
