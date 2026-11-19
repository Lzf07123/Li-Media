package config

import (
	"os"
	"strconv"
	"strings"
)

// env 辅助函数:未设置或为空时回退默认值。字符串值保留原样(strip 前后空白由调用方语义决定)。

func envString(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && strings.TrimSpace(v) != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v, ok := os.LookupEnv(key); ok {
		if parsed, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return parsed
		}
	}
	return def
}

func envInt64(key string, def int64) int64 {
	if v, ok := os.LookupEnv(key); ok {
		if parsed, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
			return parsed
		}
	}
	return def
}

func envFloat(key string, def float64) float64 {
	if v, ok := os.LookupEnv(key); ok {
		if parsed, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil {
			return parsed
		}
	}
	return def
}

func envBool(key string, def bool) bool {
	if v, ok := os.LookupEnv(key); ok {
		if parsed, err := strconv.ParseBool(strings.TrimSpace(v)); err == nil {
			return parsed
		}
	}
	return def
}

// envOptBool 对应 Python 的 bool | None:未设置返回 nil,启用自动推导。
func envOptBool(key string) *bool {
	if v, ok := os.LookupEnv(key); ok {
		if parsed, err := strconv.ParseBool(strings.TrimSpace(v)); err == nil {
			return &parsed
		}
	}
	return nil
}
