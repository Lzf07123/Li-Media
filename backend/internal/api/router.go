package api

import "net/http"

// Router 装配 /api/v1 下全部路由。Admin 由 M4 后半接入。
type Router struct {
	Health   *HealthHandler
	Memories *MemoriesHandler
	Admin    http.Handler
}

func (rt *Router) Handler() http.Handler {
	mux := http.NewServeMux()

	// {$} 精确匹配尾斜杠,避免前缀兜底吞掉未注册的 /api/v1/* 子路径。
	mux.HandleFunc("GET /api/v1/{$}", rt.Health.Root)
	mux.HandleFunc("GET /api/v1/healthz", rt.Health.Healthz)
	mux.HandleFunc("GET /api/v1/readyz", rt.Health.Readyz)

	if rt.Memories != nil {
		rt.Memories.Register(mux)
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
