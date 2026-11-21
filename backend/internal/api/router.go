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

	// 兜底:API 前缀先区分「路径存在但方法不支持(405)」与「路径不存在
	// (404)」,对齐 FastAPI;其余路径交给内嵌前端(SPA fallback)。
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			if allow := allowedMethods(mux, r); len(allow) > 0 {
				w.Header().Set("Allow", strings.Join(allow, ", "))
				ErrorDetail(w, http.StatusMethodNotAllowed, "Method Not Allowed")
				return
			}
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

// allowedMethods 用路由表本身探测同一路径支持的方法:逐一以候选方法
// 调用 ServeMux.Handler,命中真实路由(pattern 不是 "/" 兜底)即支持。
// 这样新增路由无需同步维护一份方法清单,也不会误报未注册路径。
func allowedMethods(mux *http.ServeMux, r *http.Request) []string {
	candidates := []string{
		http.MethodGet, http.MethodPost, http.MethodPatch,
		http.MethodDelete, http.MethodPut,
	}
	allowed := make([]string, 0, len(candidates)+1)
	hasGet := false
	for _, method := range candidates {
		probe := r.Clone(r.Context())
		probe.Method = method
		if _, pattern := mux.Handler(probe); pattern != "/" {
			allowed = append(allowed, method)
			if method == http.MethodGet {
				hasGet = true
			}
		}
	}
	// GET 支持的路径同时允许 HEAD(Go ServeMux 语义),Allow 显式列出。
	if hasGet {
		allowed = append(allowed, http.MethodHead)
	}
	return allowed
}
