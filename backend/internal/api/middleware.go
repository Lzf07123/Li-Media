package api

import (
	"net/http"
	"strings"
)

// CORS 中间件,对齐 Starlette CORSMiddleware 行为:
// 命中 allowlist 时回显 Origin 并携带 credentials,预检返回 200。
type CORS struct {
	AllowedOrigins map[string]bool
}

func NewCORS(origins string) *CORS {
	allowed := make(map[string]bool)
	for _, origin := range strings.Split(origins, ",") {
		if trimmed := strings.TrimSpace(origin); trimmed != "" {
			allowed[trimmed] = true
		}
	}
	return &CORS{AllowedOrigins: allowed}
}

func (c *CORS) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && c.AllowedOrigins[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			// Starlette 对简单请求按方法回显,预检统一全方法。
			if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE")
				w.Header().Set("Access-Control-Allow-Headers", "*")
				w.WriteHeader(http.StatusOK)
				return
			}
			w.Header().Add("Vary", "Origin")
		}
		next.ServeHTTP(w, r)
	})
}
