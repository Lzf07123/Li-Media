// server 入口:加载配置 → 连接池 → 迁移 → HTTP 服务,对应原 app/main.py
// 的 create_app + lifespan(预热历史恢复、source_zero 审计在 M3 接入)。
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"limedia/backend/internal/api"
	"limedia/backend/internal/config"
	"limedia/backend/internal/httpx"
	"limedia/backend/internal/repo"
	"limedia/backend/internal/services"
	"limedia/backend/internal/web"
	"limedia/backend/internal/db"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	settings, err := loadSettings()
	if err != nil {
		logger.Error("配置加载失败", "error", err)
		os.Exit(1)
	}
	for _, warning := range settings.CredentialWarnings() {
		logger.Warn("credential check: " + warning)
	}
	// 进程被杀/崩溃留下的临时文件会占满 tmp 的文件数上限,让后续
	// 预热与远程缩略图全部误报 disk_quota。启动时先清理僵尸文件。
	if removed := services.CleanupStaleRemoteTemporaryFiles(settings.MediaRoot); removed > 0 {
		logger.Info("清理孤儿临时文件", "count", removed)
	}

	ctx := context.Background()

	pool, err := db.Open(ctx, settings.DatabaseURL, settings.DatabasePoolSize, settings.DatabasePoolMaxOverflow)
	if err != nil {
		logger.Error("数据库连接失败", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	if err := db.MigrateUp(settings.DatabaseURL); err != nil {
		logger.Error("数据库迁移失败", "error", err)
		os.Exit(1)
	}

	redisOpts, err := redis.ParseURL(settings.RedisURL)
	if err != nil {
		logger.Error("REDIS_URL 无效", "error", err)
		os.Exit(1)
	}
	redisClient := redis.NewClient(redisOpts)
	defer redisClient.Close()
	if err := redisClient.Ping(ctx).Err(); err != nil {
		logger.Warn("redis 连接失败(健康检查将 503)", "error", err)
	}

	governor := services.NewTaskGovernor(settings)
	services.ChildPeakRecorder = governor.Metrics.RecordChildPeakKbytes
	inFlight := services.NewInFlightRegistry(governor.Metrics)
	services.DownloadURLCache = services.NewDownloadUrlCache(settings.BaiduDownloadURLTTLSec, settings.BaiduDownloadURLCacheSize)

	memories := api.NewMemoriesHandler(
		settings, pool,
		&repo.MemoryQuery{Pool: pool, DerivativeVersion: settings.MediaDerivativeVersion},
		governor,
		&services.DerivativeTasks{Settings: settings, Governor: governor, InFlight: inFlight},
	)

	admin := &api.AdminHandler{
		Settings:    settings,
		Pool:        pool,
		Query:       memories.Query,
		Governor:    governor,
		Sessions:    &services.AdminSessions{Pool: pool},
		Limiter:     services.NewAdminLoginRateLimiter(settings.AdminLoginMaxAttempts, settings.AdminLoginBaseDelaySec, settings.AdminLoginMaxDelaySec),
		Baidu:       &services.BaiduPanClientFactory{Settings: settings},
		Derivatives: memories.Derivatives,
	}

	staticHandler, staticErr := web.New()
	if staticErr != nil {
		logger.Warn("前端产物不可用(仅 API 模式)", "error", staticErr)
	}

	handler := (&api.Router{
		Health:   &api.HealthHandler{Pool: pool, Redis: redisClient},
		Memories: memories,
		Admin:    admin,
		Static:   staticHandler,
		Cache:    api.NewTTLResponseCache(15 * time.Second),
	}).Handler()
	httpServer := &http.Server{
		Addr:              ":8000",
		// 安全头最外层:API 4xx/5xx、CORS 预检与静态资源共用同一套策略。
		Handler:           httpx.SecurityHeaders(api.NewCORS(settings.CorsOrigins).Middleware(handler)),
		ReadHeaderTimeout: 10 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelError),
	}

	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		logger.Info("服务启动", "addr", httpServer.Addr, "version", settings.Version)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("HTTP 服务异常退出", "error", err)
			os.Exit(1)
		}
	}()

	<-shutdown
	logger.Info("收到退出信号,开始优雅停机")
	graceCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(graceCtx); err != nil {
		logger.Error("优雅停机失败", "error", err)
	}
	logger.Info("服务已停止")
}

// loadSettings 加载配置;若工作目录或其上级存在 .env 则先并入环境
// (与 Python 版 pydantic-settings 的 env_file=(.env, ../.env) 对齐;
// 已显式设置的环境变量优先,不被 .env 覆盖)。
func loadSettings() (*config.Settings, error) {
	for _, candidate := range []string{".env", "../.env"} {
		if _, err := os.Stat(candidate); err == nil {
			if err := loadDotenv(candidate); err != nil {
				return nil, err
			}
			break
		}
	}
	return config.Load()
}

// loadDotenv 极简 KEY=VALUE 解析:仅填充进程环境中尚不存在的变量。
func loadDotenv(path string) error {
	data, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if trimmed == "" || trimmed[0] == '#' {
			continue
		}
		key, value, found := strings.Cut(trimmed, "=")
		if !found {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		if key != "" {
			if _, exists := os.LookupEnv(key); !exists {
				_ = os.Setenv(key, value)
			}
		}
	}
	return nil
}
