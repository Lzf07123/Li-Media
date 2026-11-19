package api

import (
	"context"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// HealthHandler 对应原 app/api/v1/health.py。
type HealthHandler struct {
	Pool  *pgxpool.Pool
	Redis *redis.Client
}

type rootResponse struct {
	Status  string `json:"status"`
	Service string `json:"service"`
}

type healthzResponse struct {
	Status string `json:"status"`
}

type readyzResponse struct {
	Status   string `json:"status"`
	Database string `json:"database"`
	Redis    string `json:"redis"`
}

// Root 服务标识。不暴露接口文档路径等内部信息。
func (h *HealthHandler) Root(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, rootResponse{Status: "ok", Service: "Li&Media API"})
}

func (h *HealthHandler) Healthz(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, healthzResponse{Status: "ok"})
}

// Readyz 依赖就绪探针:DB SELECT 1 + redis ping,任一失败 503。
func (h *HealthHandler) Readyz(w http.ResponseWriter, _ *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	if err := h.Pool.Ping(ctx); err != nil {
		ErrorDetail(w, http.StatusServiceUnavailable, "database unavailable")
		return
	}
	if err := h.Redis.Ping(ctx).Err(); err != nil {
		ErrorDetail(w, http.StatusServiceUnavailable, "redis unavailable")
		return
	}
	WriteJSON(w, http.StatusOK, readyzResponse{Status: "ready", Database: "ok", Redis: "ok"})
}
