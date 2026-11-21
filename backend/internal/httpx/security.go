// Package httpx 收拢 HTTP 层的通用安全策略:响应头与客户端地址解析。
// 单容器部署下 Go 直接面对浏览器,原本由 nginx 统一追加的安全头必须
// 在进程内对所有响应(静态资源与 API)生效。
package httpx

import (
	"net/http"
	"strings"
)

// ContentSecurityPolicy 与 frontend/security-headers.conf 逐项对齐。
// 'wasm-unsafe-eval' 是 WebAssembly 编译必需;'unsafe-inline' 用于
// trunk 的内联启动脚本与主题初始化。
const ContentSecurityPolicy = "default-src 'self'; img-src 'self' data:; media-src 'self'; " +
	"connect-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'; " +
	"frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

// SetSecurityHeaders 写入对所有响应都适用的安全头。
func SetSecurityHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Content-Security-Policy", ContentSecurityPolicy)
	h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
}

// ApplyHSTS 仅在 https 请求(含受信代理透传的 X-Forwarded-Proto)下发 HSTS。
func ApplyHSTS(w http.ResponseWriter, r *http.Request) {
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
	}
}

// SecurityHeaders 中间件:安全头先于下游 WriteHeader 写入,覆盖 API
// 的 4xx/5xx 与 CORS 预检响应。
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		SetSecurityHeaders(w)
		ApplyHSTS(w, r)
		next.ServeHTTP(w, r)
	})
}
