package api

import (
	"net/http"
	"strings"
)

// Router 装配 /api/v1 下全部路由;非 API 路径由静态处理器兜底
// (单容器部署时 Go 直接托管内嵌前端产物)。
type Router struct {
	Health   *HealthHandler
	Memories *MemoriesHandler
	Admin    *AdminHandler
	Static   http.Handler
	// Cache 若设置,仅对匿名公开读端点生效(15s TTL,对齐 nginx
	// proxy_cache);nil 时纯直通。
	Cache *TTLResponseCache
}

func (rt *Router) Handler() http.Handler {
	handler := rt.mux()
	if rt.Cache != nil {
		return rt.Cache.Middleware(handler)
	}
	return handler
}

func (rt *Router) mux() http.Handler {
	mux := http.NewServeMux()

	// {$} 精确匹配尾斜杠,避免前缀兜底吞掉未注册的 /api/v1/* 子路径。
	mux.HandleFunc("GET /api/v1/{$}", rt.Health.Root)
	mux.HandleFunc("GET /api/v1/healthz", rt.Health.Healthz)
	mux.HandleFunc("GET /api/v1/readyz", rt.Health.Readyz)

	if rt.Memories != nil {
		rt.Memories.Register(mux)
	}
	if rt.Admin != nil {
		rt.Admin.Register(mux)
	}

	// 兜底:API 前缀继续返回 JSON 404;其余路径交给内嵌前端(SPA fallback)。
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			ErrorDetail(w, http.StatusNotFound, "Not Found")
			return
		}
		if rt.Static != nil {
			rt.Static.ServeHTTP(w, r)
			return
		}
		ErrorDetail(w, http.StatusNotFound, "Not Found")
	})
	return mux
}
