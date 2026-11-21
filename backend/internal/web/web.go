// Package web 内嵌前端构建产物,单容器部署时由 Go 直接托管静态资源。
//
// 与 nginx 版(双容器)的职责对齐:SPA fallback、安全头、gzip、
// 逐资源缓存策略;proxy_cache(派生缩略图磁盘缓存)不做进程内复刻——
// 缩略图响应本身带 immutable 一年缓存,浏览器侧已命中,服务端缓存
// 收益仅在首次并发,性能对比见 docs/rewrite-performance.md。
package web

import (
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

// dist 由构建期注入(Docker 多阶段:trunk 产物复制到本目录);
// 仓库只保留 .gitkeep 占位,保证开发机 go build 可用。
//
//go:embed all:dist
var distFS embed.FS

// securityHeaders 与 frontend/security-headers.conf 逐项对齐。
// CSP 的 'wasm-unsafe-eval' 是 WebAssembly 编译必需;'unsafe-inline'
// 用于 trunk 的内联启动脚本与主题初始化。
const contentSecurityPolicy = "default-src 'self'; img-src 'self' data:; media-src 'self'; " +
	"connect-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'; " +
	"frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

var compressibleExt = map[string]bool{
	".html": true, ".js": true, ".css": true, ".wasm": true,
	".json": true, ".svg": true, ".txt": true, ".map": true,
}

// Handler 返回静态资源处理器;根路由兜底到 SPA。
type Handler struct {
	files fs.FS
	// indexHTML 预读,SPA fallback 与 / 共用。
	indexHTML []byte
	// indexETag 基于内容哈希,配合 no-cache 做协商缓存。
	indexETag string
}

func New() (*Handler, error) {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		return nil, err
	}
	index, err := fs.ReadFile(sub, "index.html")
	if err != nil {
		// 占位构建(仓库 .gitkeep)时给可读提示,而不是 500。
		index = []byte("<!doctype html><meta charset=utf-8><title>Li&Media</title>" +
			"<p>前端产物未嵌入:请用 Docker 构建,或在 frontend 下运行 trunk build 后复制 dist。</p>")
	}
	sum := sha256.Sum256(index)
	return &Handler{
		files:     sub,
		indexHTML: index,
		indexETag: `"` + hex.EncodeToString(sum[:8]) + `"`,
	}, nil
}

// setSecurityHeaders 每个响应都带,对齐 nginx 的 always 语义。
func setSecurityHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Content-Security-Policy", contentSecurityPolicy)
	h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
	// 仅 https 部署发 HSTS(与 nginx 的 $limedia_hsts 同义;此处按请求推断)。
}

func applyHSTS(w http.ResponseWriter, r *http.Request) {
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
	}
}

// ServeHTTP 满足 http.Handler;路径不存在时回退 index.html(SPA 路由)。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.Serve(w, r)
}

// Serve 处理静态文件请求;路径不存在时回退 index.html(SPA 路由)。
func (h *Handler) Serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	setSecurityHeaders(w)
	applyHSTS(w, r)

	clean := path.Clean("/" + r.URL.Path)
	rel := strings.TrimPrefix(clean, "/")

	if rel == "" || rel == "index.html" {
		h.serveIndex(w, r)
		return
	}

	info, err := fs.Stat(h.files, rel)
	if err != nil || info.IsDir() {
		// SPA fallback:前端路由(/admin、/memories/:id)交给 index.html。
		h.serveIndex(w, r)
		return
	}

	data, err := fs.ReadFile(h.files, rel)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	// 带内容哈希的构建产物可长期缓存;其余(如 favicon)一天。
	if hashedAsset(rel) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=86400")
	}
	w.Header().Set("Content-Type", contentTypeFor(rel))
	writeMaybeGzip(w, r, data)
}

func (h *Handler) serveIndex(w http.ResponseWriter, r *http.Request) {
	// index 必须每次协商,发布新版本立即生效。
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("ETag", h.indexETag)
	if r.Header.Get("If-None-Match") == h.indexETag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	writeMaybeGzip(w, r, h.indexHTML)
}

// hashedAsset trunk 的输出文件名含 16 位十六进制哈希(-<hash>.)。
func hashedAsset(rel string) bool {
	base := path.Base(rel)
	dot := strings.LastIndex(base, ".")
	if dot < 0 {
		return false
	}
	stem := base[:dot]
	dash := strings.LastIndex(stem, "-")
	if dash < 0 || len(stem)-dash-1 != 16 {
		return false
	}
	_, err := hex.DecodeString(stem[dash+1:])
	return err == nil
}

func contentTypeFor(rel string) string {
	switch path.Ext(rel) {
	case ".html":
		return "text/html; charset=utf-8"
	case ".js":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".wasm":
		return "application/wasm"
	case ".json", ".map":
		return "application/json"
	case ".svg":
		return "image/svg+xml"
	case ".webp":
		return "image/webp"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".ico":
		return "image/x-icon"
	default:
		return http.DetectContentType(relBytes(rel))
	}
}

// relBytes 仅用于 DetecContentType 的兜底(无意义的短串即可)。
func relBytes(rel string) []byte { return []byte(rel) }

// writeMaybeGzip 对可压缩类型且 >1KB 的响应做 gzip;Vary 保证缓存正确分键。
func writeMaybeGzip(w http.ResponseWriter, r *http.Request, data []byte) {
	ext := path.Ext(r.URL.Path)
	if ext == "" {
		ext = ".html"
	}
	canGzip := compressibleExt[ext] && len(data) > 1024 &&
		strings.Contains(r.Header.Get("Accept-Encoding"), "gzip")
	w.Header().Add("Vary", "Accept-Encoding")
	if !canGzip {
		w.Header().Set("Content-Length", itoa(len(data)))
		_, _ = w.Write(data)
		return
	}
	gz := gzip.NewWriter(w)
	gz.Reset(w)
	w.Header().Set("Content-Encoding", "gzip")
	_, err := gz.Write(data)
	if err == nil {
		err = gz.Close()
	}
	if err != nil {
		// 头已发出,只能中断;记录由 http.Server.ErrorLog 兜底。
		return
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

var _ = time.Now
var _ io.Writer
