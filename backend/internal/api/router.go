package api

import "net/http"

// Router 装配 /api/v1 下全部路由。M1 仅 health;memories 与 admin
// 由后续里程碑注册(MemoriesHandler / AdminHandler 挂到同一结构)。
type Router struct {
	Health  *HealthHandler
	Memories http.Handler // M4 接入
	Admin    http.Handler // M4 接入
}

func (rt *Router) Handler() http.Handler {
	mux := http.NewServeMux()

	// {$} 精确匹配尾斜杠,避免前缀兜底吞掉未注册的 /api/v1/* 子路径。
	mux.HandleFunc("GET /api/v1/{$}", rt.Health.Root)
	mux.HandleFunc("GET /api/v1/healthz", rt.Health.Healthz)
	mux.HandleFunc("GET /api/v1/readyz", rt.Health.Readyz)

	// 占位:子路由注册后由各自 ServeHTTP 处理前缀。
	if rt.Memories != nil {
		mux.Handle("GET /api/v1/memories", rt.Memories)
		mux.Handle("GET /api/v1/memories/", rt.Memories)
		mux.Handle("POST /api/v1/memories", rt.Memories)
	}
	if rt.Admin != nil {
		mux.Handle("/api/v1/admin", rt.Admin)
		mux.Handle("/api/v1/admin/", rt.Admin)
	}

	// FastAPI 对未匹配路径返回 {"detail": "Not Found"}。
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		ErrorDetail(w, http.StatusNotFound, "Not Found")
	})
	return mux
}
