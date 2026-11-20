// Package api 提供 HTTP 层:路由装配、响应助手与中间件。
// 错误结构对齐 FastAPI:`{"detail": "..."}`;校验错误为 detail 列表。
package api

import (
	"encoding/json"
	"net/http"
)

// WriteJSON 以标准 Content-Type 输出 JSON 响应。
func WriteJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if payload == nil {
		// FastAPI 对 None 响应输出字面量 null(契约样本 30)。
		_, _ = w.Write([]byte("null"))
		return
	}
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		// 头已发出,仅能记入日志;上层用 http.Server.ErrorLog 兜底。
		_ = err
	}
}

// ErrorDetail 按 FastAPI 契约输出 {"detail": "..."}。
func ErrorDetail(w http.ResponseWriter, status int, detail string) {
	WriteJSON(w, status, map[string]any{"detail": detail})
}

// ValidationError 按 FastAPI 422 契约输出结构化错误列表。
func ValidationError(w http.ResponseWriter, items []ValidationErrorItem) {
	WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": items})
}

type ValidationErrorItem struct {
	Type  string `json:"type"`
	Loc   []any  `json:"loc"`
	Msg   string `json:"msg"`
	Input any    `json:"input"`
}
