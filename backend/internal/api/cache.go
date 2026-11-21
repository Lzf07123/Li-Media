// cache.go 进程内 TTL 缓存,替代双容器方案的 nginx proxy_cache。
//
// 对齐语义:仅缓存匿名 GET 的公开读端点;带 Cookie/Authorization 与
// random 排序一律绕过(与 nginx 的 proxy_cache_bypass 同义);TTL 15s
// 与 proxy_cache_valid 200 15s 一致。缓存体量很小(页面级 JSON),
// 用 map + 互斥锁即可,不需要 LRU 淘汰——条目数受页面参数组合约束。
package api

import (
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// cacheablePath 判定是否进入缓存白名单(与 nginx location 对齐)。
func cacheablePath(path string) bool {
	if path == "/api/v1/memories" {
		return true
	}
	if path == "/api/v1/memories/public-counts" {
		return true
	}
	// 详情:/api/v1/memories/{uuid},不匹配 /thumbnail、/file、/stream 等子路径。
	if strings.HasPrefix(path, "/api/v1/memories/") {
		rest := strings.TrimPrefix(path, "/api/v1/memories/")
		return rest != "" && !strings.Contains(rest, "/")
	}
	return false
}

type cacheEntry struct {
	status  int
	body    []byte
	header  http.Header
	expires time.Time
}

// TTLResponseCache 公开读端点的短期响应缓存。
type TTLResponseCache struct {
	TTL time.Duration

	mu      sync.Mutex
	entries map[string]cacheEntry
}

func NewTTLResponseCache(ttl time.Duration) *TTLResponseCache {
	return &TTLResponseCache{TTL: ttl, entries: make(map[string]cacheEntry)}
}

// Middleware 包装下游处理器。缓存键 = path + query。
func (c *TTLResponseCache) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !c.cacheable(r) {
			next.ServeHTTP(w, r)
			return
		}
		key := r.URL.Path + "?" + r.URL.RawQuery

		c.mu.Lock()
		entry, ok := c.entries[key]
		if ok && time.Now().After(entry.expires) {
			delete(c.entries, key)
			ok = false
		}
		c.mu.Unlock()
		if ok {
			w.Header().Set("X-Cache", "HIT")
			for name, values := range entry.header {
				for _, value := range values {
					w.Header().Add(name, value)
				}
			}
			w.WriteHeader(entry.status)
			_, _ = w.Write(entry.body)
			return
		}

		// MISS 必须先于下游 WriteHeader,否则诊断头被丢弃。
		w.Header().Set("X-Cache", "MISS")
		recorder := &cacheRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, r)

		// 只缓存成功的匿名响应;Vary/Cache-Control 已由业务层设置。
		if recorder.status == http.StatusOK && len(recorder.body) <= 256*1024 {
			header := recorder.Header().Clone()
			header.Del("X-Cache")
			c.mu.Lock()
			c.entries[key] = cacheEntry{
				status:  recorder.status,
				body:    recorder.body,
				header:  header,
				expires: time.Now().Add(c.TTL),
			}
			c.mu.Unlock()
		}
	})
}

// cacheable 与 nginx 的 bypass 条件对齐。
func (c *TTLResponseCache) cacheable(r *http.Request) bool {
	if r.Method != http.MethodGet {
		return false
	}
	if !cacheablePath(r.URL.Path) {
		return false
	}
	if r.Header.Get("Authorization") != "" || len(r.Cookies()) > 0 {
		return false
	}
	// random 排序按访问种子返回不同顺序,缓存只会浪费空间。
	if r.URL.Query().Get("sort") == "random" {
		return false
	}
	return true
}

// cacheRecorder 记录状态码与响应体;不拦截 Flush/Stream 语义,
// 因为白名单端点都是小 JSON。
type cacheRecorder struct {
	http.ResponseWriter
	status int
	body   []byte
}

func (r *cacheRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *cacheRecorder) Write(p []byte) (int, error) {
	r.body = append(r.body, p...)
	return r.ResponseWriter.Write(p)
}

var _ = strconv.Itoa
