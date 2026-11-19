// Package config 承载运行时配置:自环境变量(或 .env)加载,
// 逐字段对应原 app/core/config.py 的 Settings。
package config

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// Settings 运行时配置。所有默认值与范围约束均照抄 Python 版定义;
// 范围越界在 Load 时报错(fail-fast,等同 pydantic Field 的 ge/le)。
type Settings struct {
	ProjectName string
	Version     string

	DatabaseURL    string
	PostgresHost   string
	PostgresPort   int
	PostgresUser   string
	PostgresPass   string
	PostgresDB     string
	RedisURL       string
	CorsOrigins    string
	PublicBaseURL  string
	AdminToken     string
	AdminCookieName string

	AdminSessionTTLMinutes  int
	AdminLoginMaxAttempts   int
	AdminLoginBaseDelaySec  float64
	AdminLoginMaxDelaySec   float64
	AdminCookieSecure       *bool // nil=自动:public_base_url 为 https 时启用 Secure

	MediaRoot        string
	NginxCacheRoot   string
	ThumbnailMaxSize int
	ThumbnailQuality int

	MediaDerivativeVersion             string
	VideoFrameOffsetSeconds            float64
	RemoteThumbnailSourceMaxBytes      int64
	RemoteThumbnailVideoSourceMaxBytes int64
	SourceDownloadTimeoutSec           float64
	RemoteThumbnailDiskQuotaBytes      int64
	RemoteThumbnailMaxTempFiles        int
	BrowserProbeMaxBytes               int64
	BrowserProbeTimeoutSec             float64

	ScanConcurrencyLimit        int
	ScanQueueLimit              int
	ScanWaitTimeoutSec          float64
	DirectProbeConcurrencyLimit int
	DirectProbeQueueLimit       int
	DirectProbeWaitTimeoutSec   float64
	DerivativeConcurrencyLimit  int
	DerivativeQueueLimit        int
	DerivativeWaitTimeoutSec    float64
	PreheatConcurrencyLimit     int
	PreheatQueueLimit           int
	PreheatWaitTimeoutSec       float64
	PreheatAutoAfterScan        bool
	PreheatRetryCooldownSec     int

	StreamGlobalConcurrencyLimit int
	StreamUserConcurrencyLimit   int
	StreamQueueLimit             int
	StreamWaitTimeoutSec         float64

	// Python 版以 anyio 线程池上限约束同步阻塞调用;Go 为 goroutine 模型,
	// 该字段仅保留配置兼容,不再调节运行时。
	TaskThreadPoolSize int

	BackendMemoryLimitBytes int64

	DatabasePoolSize          int
	DatabasePoolMaxOverflow   int
	DatabasePoolTimeoutSec    int

	BaiduAPIBaseURL        string
	BaiduAccessToken       string
	BaiduOAuthClientID     string
	BaiduOAuthClientSecret string
	BaiduOAuthRedirectURI  string
	BaiduOAuthScope        string
	BaiduOAuthAuthorizeURL string
	BaiduOAuthTokenURL     string
	BaiduCredentialsPath   string
	BaiduSyncDir           string
	BaiduSyncPageSize      int
	BaiduSyncMaxBytes      int64
	BaiduScanMaxDepth      int
	BaiduScanMaxItems      int
	BaiduRequestIntervalSec float64
	BaiduRetryAttempts     int
	BaiduRetryBaseDelaySec float64
	BaiduRetryMaxDelaySec  float64
	BaiduDownloadURLTTLSec int
	BaiduDownloadURLCacheSize int
	BaiduThumbnailSize     string
}

// Load 从环境变量构建 Settings。找不到 .env 文件时仅依赖进程环境
// (容器部署的常态);.env 解析交给入口的 dotenv 加载器。
func Load() (*Settings, error) {
	s := &Settings{
		ProjectName:    envString("PROJECT_NAME", "Li&Media"),
		Version:        envString("VERSION", "0.1.0"),
		DatabaseURL:    envString("DATABASE_URL", ""),
		PostgresHost:   envString("POSTGRES_HOST", ""),
		PostgresPort:   envInt("POSTGRES_PORT", 5432),
		PostgresUser:   envString("POSTGRES_USER", "media"),
		PostgresPass:   envString("POSTGRES_PASSWORD", "change-me"),
		PostgresDB:     envString("POSTGRES_DB", "media"),
		RedisURL:       envString("REDIS_URL", "redis://localhost:6379/0"),
		CorsOrigins:    envString("CORS_ORIGINS", "http://localhost:5173,http://localhost:8080"),
		PublicBaseURL:  envString("PUBLIC_BASE_URL", "http://127.0.0.1:8080"),
		AdminToken:     envString("ADMIN_TOKEN", ""),
		AdminCookieName: envString("ADMIN_SESSION_COOKIE_NAME", "limedia_admin_session"),

		AdminSessionTTLMinutes: envInt("ADMIN_SESSION_TTL_MINUTES", 120),
		AdminLoginMaxAttempts:  envInt("ADMIN_LOGIN_MAX_ATTEMPTS", 5),
		AdminLoginBaseDelaySec: envFloat("ADMIN_LOGIN_BASE_DELAY", 0.2),
		AdminLoginMaxDelaySec:  envFloat("ADMIN_LOGIN_MAX_DELAY", 2.0),
		AdminCookieSecure:      envOptBool("ADMIN_COOKIE_SECURE"),

		MediaRoot:        envString("MEDIA_ROOT", "./data/media"),
		NginxCacheRoot:   envString("NGINX_CACHE_ROOT", "./data/nginx_cache"),
		ThumbnailMaxSize: envInt("THUMBNAIL_MAX_SIZE", 1280),
		ThumbnailQuality: envInt("THUMBNAIL_QUALITY", 82),

		MediaDerivativeVersion:             envString("MEDIA_DERIVATIVE_VERSION", "20260906-ratio-v1"),
		VideoFrameOffsetSeconds:            envFloat("VIDEO_FRAME_OFFSET_SECONDS", 0),
		RemoteThumbnailSourceMaxBytes:      envInt64("REMOTE_THUMBNAIL_SOURCE_MAX_BYTES", 16*1024*1024),
		RemoteThumbnailVideoSourceMaxBytes: envInt64("REMOTE_THUMBNAIL_VIDEO_SOURCE_MAX_BYTES", 64*1024*1024),
		SourceDownloadTimeoutSec:           envFloat("SOURCE_DOWNLOAD_TIMEOUT_SECONDS", 600),
		RemoteThumbnailDiskQuotaBytes:      envInt64("REMOTE_THUMBNAIL_DISK_QUOTA_BYTES", 4*1024*1024*1024),
		RemoteThumbnailMaxTempFiles:        envInt("REMOTE_THUMBNAIL_MAX_TEMP_FILES", 8),
		BrowserProbeMaxBytes:               envInt64("BROWSER_PROBE_MAX_BYTES", 2*1024*1024),
		BrowserProbeTimeoutSec:             envFloat("BROWSER_PROBE_TIMEOUT_SECONDS", 12.0),

		ScanConcurrencyLimit:        envInt("SCAN_CONCURRENCY_LIMIT", 1),
		ScanQueueLimit:              envInt("SCAN_QUEUE_LIMIT", 1),
		ScanWaitTimeoutSec:          envFloat("SCAN_WAIT_TIMEOUT_SECONDS", 0),
		DirectProbeConcurrencyLimit: envInt("DIRECT_PROBE_CONCURRENCY_LIMIT", 4),
		DirectProbeQueueLimit:       envInt("DIRECT_PROBE_QUEUE_LIMIT", 16),
		DirectProbeWaitTimeoutSec:   envFloat("DIRECT_PROBE_WAIT_TIMEOUT_SECONDS", 3.0),
		DerivativeConcurrencyLimit:  envInt("DERIVATIVE_CONCURRENCY_LIMIT", 2),
		DerivativeQueueLimit:        envInt("DERIVATIVE_QUEUE_LIMIT", 32),
		DerivativeWaitTimeoutSec:    envFloat("DERIVATIVE_WAIT_TIMEOUT_SECONDS", 15.0),
		PreheatConcurrencyLimit:     envInt("PREHEAT_CONCURRENCY_LIMIT", 3),
		PreheatQueueLimit:           envInt("PREHEAT_QUEUE_LIMIT", 64),
		PreheatWaitTimeoutSec:       envFloat("PREHEAT_WAIT_TIMEOUT_SECONDS", 2.0),
		PreheatAutoAfterScan:        envBool("PREHEAT_AUTO_AFTER_SCAN", true),
		PreheatRetryCooldownSec:     envInt("PREHEAT_RETRY_COOLDOWN_SECONDS", 3600),

		StreamGlobalConcurrencyLimit: envInt("STREAM_GLOBAL_CONCURRENCY_LIMIT", 16),
		StreamUserConcurrencyLimit:   envInt("STREAM_USER_CONCURRENCY_LIMIT", 3),
		StreamQueueLimit:             envInt("STREAM_QUEUE_LIMIT", 32),
		StreamWaitTimeoutSec:         envFloat("STREAM_WAIT_TIMEOUT_SECONDS", 1.0),

		TaskThreadPoolSize: envInt("TASK_THREAD_POOL_SIZE", 24),

		BackendMemoryLimitBytes: envInt64("BACKEND_MEMORY_LIMIT_BYTES", 256*1024*1024),

		DatabasePoolSize:        envInt("DATABASE_POOL_SIZE", 8),
		DatabasePoolMaxOverflow: envInt("DATABASE_POOL_MAX_OVERFLOW", 8),
		DatabasePoolTimeoutSec:  envInt("DATABASE_POOL_TIMEOUT_SECONDS", 30),

		BaiduAPIBaseURL:        envString("BAIDU_API_BASE_URL", "https://pan.baidu.com/rest/2.0/xpan"),
		BaiduAccessToken:       envString("BAIDU_ACCESS_TOKEN", ""),
		BaiduOAuthClientID:     envString("BAIDU_OAUTH_CLIENT_ID", ""),
		BaiduOAuthClientSecret: envString("BAIDU_OAUTH_CLIENT_SECRET", ""),
		BaiduOAuthRedirectURI:  envString("BAIDU_OAUTH_REDIRECT_URI", ""),
		BaiduOAuthScope:        envString("BAIDU_OAUTH_SCOPE", "basic,netdisk"),
		BaiduOAuthAuthorizeURL: envString("BAIDU_OAUTH_AUTHORIZE_URL", "https://openapi.baidu.com/oauth/2.0/authorize"),
		BaiduOAuthTokenURL:     envString("BAIDU_OAUTH_TOKEN_URL", "https://openapi.baidu.com/oauth/2.0/token"),
		BaiduCredentialsPath:   envString("BAIDU_CREDENTIALS_PATH", "./data/config/baidu_token.json"),
		BaiduSyncDir:           envString("BAIDU_SYNC_DIR", "/apps/Li&Media"),
		BaiduSyncPageSize:      envInt("BAIDU_SYNC_PAGE_SIZE", 1000),
		BaiduSyncMaxBytes:      envInt64("BAIDU_SYNC_MAX_BYTES", 2*1024*1024*1024),
		BaiduScanMaxDepth:      envInt("BAIDU_SCAN_MAX_DEPTH", 8),
		BaiduScanMaxItems:      envInt("BAIDU_SCAN_MAX_ITEMS", 5000),
		BaiduRequestIntervalSec: envFloat("BAIDU_REQUEST_INTERVAL_SECONDS", 0.2),
		BaiduRetryAttempts:     envInt("BAIDU_RETRY_ATTEMPTS", 3),
		BaiduRetryBaseDelaySec: envFloat("BAIDU_RETRY_BASE_DELAY", 0.5),
		BaiduRetryMaxDelaySec:  envFloat("BAIDU_RETRY_MAX_DELAY", 8.0),
		BaiduDownloadURLTTLSec: envInt("BAIDU_DOWNLOAD_URL_TTL_SECONDS", 300),
		BaiduDownloadURLCacheSize: envInt("BAIDU_DOWNLOAD_URL_CACHE_SIZE", 256),
		BaiduThumbnailSize:     envString("BAIDU_THUMBNAIL_SIZE", "c1600_u1600"),
	}
	if err := s.validate(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Settings) validate() error {
	// 弱管理令牌直接拒绝启动:ADMIN_TOKEN 是唯一管理凭证入口,
	// 照抄示例值上线等于无锁。空值合法(登录 fail-closed)。
	if strings.TrimSpace(s.AdminToken) == "change-me" {
		return errors.New("ADMIN_TOKEN 仍为示例值 change-me;请设置强随机值后再启动")
	}

	if err := checkRange("ADMIN_SESSION_TTL_MINUTES", s.AdminSessionTTLMinutes, 1, 10080); err != nil {
		return err
	}
	if err := checkRange("ADMIN_LOGIN_MAX_ATTEMPTS", s.AdminLoginMaxAttempts, 1, 20); err != nil {
		return err
	}
	if err := checkRangeFloat("ADMIN_LOGIN_BASE_DELAY", s.AdminLoginBaseDelaySec, 0, 10); err != nil {
		return err
	}
	if err := checkRangeFloat("ADMIN_LOGIN_MAX_DELAY", s.AdminLoginMaxDelaySec, 0, 60); err != nil {
		return err
	}
	if err := checkRange("THUMBNAIL_MAX_SIZE", s.ThumbnailMaxSize, 240, 4096); err != nil {
		return err
	}
	if err := checkRange("THUMBNAIL_QUALITY", s.ThumbnailQuality, 1, 100); err != nil {
		return err
	}
	if err := checkRangeFloat("SOURCE_DOWNLOAD_TIMEOUT_SECONDS", s.SourceDownloadTimeoutSec, 30, 3600); err != nil {
		return err
	}
	if err := checkRangeInt64("REMOTE_THUMBNAIL_DISK_QUOTA_BYTES", s.RemoteThumbnailDiskQuotaBytes, 0, 64*1024*1024*1024); err != nil {
		return err
	}
	if err := checkRange("REMOTE_THUMBNAIL_MAX_TEMP_FILES", s.RemoteThumbnailMaxTempFiles, 0, 64); err != nil {
		return err
	}
	if err := checkRange("SCAN_CONCURRENCY_LIMIT", s.ScanConcurrencyLimit, 1, 4); err != nil {
		return err
	}
	if err := checkRange("SCAN_QUEUE_LIMIT", s.ScanQueueLimit, 0, 100); err != nil {
		return err
	}
	if err := checkRangeFloat("SCAN_WAIT_TIMEOUT_SECONDS", s.ScanWaitTimeoutSec, 0, 30); err != nil {
		return err
	}
	if err := checkRange("DIRECT_PROBE_CONCURRENCY_LIMIT", s.DirectProbeConcurrencyLimit, 1, 16); err != nil {
		return err
	}
	if err := checkRange("DIRECT_PROBE_QUEUE_LIMIT", s.DirectProbeQueueLimit, 0, 1000); err != nil {
		return err
	}
	if err := checkRangeFloat("DIRECT_PROBE_WAIT_TIMEOUT_SECONDS", s.DirectProbeWaitTimeoutSec, 0, 30); err != nil {
		return err
	}
	if err := checkRange("DERIVATIVE_CONCURRENCY_LIMIT", s.DerivativeConcurrencyLimit, 1, 4); err != nil {
		return err
	}
	if err := checkRange("DERIVATIVE_QUEUE_LIMIT", s.DerivativeQueueLimit, 0, 1000); err != nil {
		return err
	}
	if err := checkRangeFloat("DERIVATIVE_WAIT_TIMEOUT_SECONDS", s.DerivativeWaitTimeoutSec, 0, 60); err != nil {
		return err
	}
	if err := checkRange("PREHEAT_CONCURRENCY_LIMIT", s.PreheatConcurrencyLimit, 1, 8); err != nil {
		return err
	}
	if err := checkRange("PREHEAT_QUEUE_LIMIT", s.PreheatQueueLimit, 0, 1000); err != nil {
		return err
	}
	if err := checkRangeFloat("PREHEAT_WAIT_TIMEOUT_SECONDS", s.PreheatWaitTimeoutSec, 0, 30); err != nil {
		return err
	}
	if err := checkRange("PREHEAT_RETRY_COOLDOWN_SECONDS", s.PreheatRetryCooldownSec, 0, 604800); err != nil {
		return err
	}
	if err := checkRange("STREAM_GLOBAL_CONCURRENCY_LIMIT", s.StreamGlobalConcurrencyLimit, 1, 64); err != nil {
		return err
	}
	if err := checkRange("STREAM_USER_CONCURRENCY_LIMIT", s.StreamUserConcurrencyLimit, 1, 16); err != nil {
		return err
	}
	if err := checkRange("STREAM_QUEUE_LIMIT", s.StreamQueueLimit, 0, 1000); err != nil {
		return err
	}
	if err := checkRangeFloat("STREAM_WAIT_TIMEOUT_SECONDS", s.StreamWaitTimeoutSec, 0, 30); err != nil {
		return err
	}
	if err := checkRange("TASK_THREAD_POOL_SIZE", s.TaskThreadPoolSize, 1, 128); err != nil {
		return err
	}
	if err := checkRangeInt64("BACKEND_MEMORY_LIMIT_BYTES", s.BackendMemoryLimitBytes, 0, 8*1024*1024*1024); err != nil {
		return err
	}
	if err := checkRange("DATABASE_POOL_SIZE", s.DatabasePoolSize, 1, 100); err != nil {
		return err
	}
	if err := checkRange("DATABASE_POOL_MAX_OVERFLOW", s.DatabasePoolMaxOverflow, 0, 100); err != nil {
		return err
	}
	if err := checkRange("DATABASE_POOL_TIMEOUT_SECONDS", s.DatabasePoolTimeoutSec, 1, 300); err != nil {
		return err
	}
	if err := checkRange("BAIDU_SYNC_PAGE_SIZE", s.BaiduSyncPageSize, 1, 1000); err != nil {
		return err
	}
	if err := checkRange("BAIDU_SCAN_MAX_DEPTH", s.BaiduScanMaxDepth, 1, 32); err != nil {
		return err
	}
	if err := checkRange("BAIDU_SCAN_MAX_ITEMS", s.BaiduScanMaxItems, 1, 100000); err != nil {
		return err
	}
	if err := checkRangeFloat("BAIDU_REQUEST_INTERVAL_SECONDS", s.BaiduRequestIntervalSec, 0, 30); err != nil {
		return err
	}
	if err := checkRange("BAIDU_RETRY_ATTEMPTS", s.BaiduRetryAttempts, 1, 10); err != nil {
		return err
	}
	if err := checkRangeFloat("BAIDU_RETRY_BASE_DELAY", s.BaiduRetryBaseDelaySec, 0, 60); err != nil {
		return err
	}
	if err := checkRangeFloat("BAIDU_RETRY_MAX_DELAY", s.BaiduRetryMaxDelaySec, 0, 600); err != nil {
		return err
	}
	if err := checkRange("BAIDU_DOWNLOAD_URL_CACHE_SIZE", s.BaiduDownloadURLCacheSize, 16, 4096); err != nil {
		return err
	}

	return s.resolveDatabaseURL()
}

// resolveDatabaseURL 对应 Python 版 model_validator:显式 DATABASE_URL 优先,
// 否则由 POSTGRES_* 拼接。Go 侧无 sqlite 测试路径,缺省回退 localhost postgres
// (sqlite 仅是 Python 测试便利;Go 测试一律使用容器 Postgres)。
func (s *Settings) resolveDatabaseURL() error {
	explicit := strings.TrimSpace(s.DatabaseURL)
	if explicit != "" {
		normalized, err := normalizeDatabaseURL(explicit)
		if err != nil {
			return fmt.Errorf("DATABASE_URL 无效: %w", err)
		}
		s.DatabaseURL = normalized
		return nil
	}

	host, embeddedPort := resolvePostgresHost(s.PostgresHost)
	port := s.PostgresPort
	if embeddedPort != nil {
		port = *embeddedPort
	}
	if host == "" {
		host = "localhost"
	}

	u := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(s.PostgresUser, s.PostgresPass),
		Host:   fmt.Sprintf("%s:%d", host, port),
		Path:   "/" + s.PostgresDB,
	}
	s.DatabaseURL = u.String()
	return nil
}

// normalizeDatabaseURL 归一 SQLAlchemy 方言前缀,pgx 只认标准 scheme。
func normalizeDatabaseURL(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "postgres", "postgresql":
		return raw, nil
	case "postgresql+psycopg", "postgresql+psycopg2":
		return "postgres://" + strings.TrimPrefix(raw, parsed.Scheme+"://"), nil
	default:
		return "", fmt.Errorf("不支持的连接前缀 %q", parsed.Scheme)
	}
}

// resolvePostgresHost 兼容误写的 host:port、IPv6 和连接 URL,同时保留显式端口。
// 逐行对应 Python 版 resolve_postgres_host。
func resolvePostgresHost(value string) (string, *int) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}

	if strings.Contains(value, "://") {
		parsed, err := url.Parse(value)
		if err != nil {
			return value, nil
		}
		host := parsed.Hostname()
		if parsed.Port() != "" {
			port, err := strconv.Atoi(parsed.Port())
			if err == nil {
				return host, &port
			}
		}
		return host, nil
	}

	if strings.HasPrefix(value, "[") {
		host, tail, found := strings.Cut(strings.TrimPrefix(value, "["), "]")
		if found && strings.HasPrefix(tail, ":") && isDigits(tail[1:]) {
			port, _ := strconv.Atoi(tail[1:])
			return host, &port
		}
		if found && tail == "" {
			return host, nil
		}
		return value, nil
	}

	if strings.Count(value, ":") == 1 {
		host, tail, _ := strings.Cut(value, ":")
		if host != "" && isDigits(tail) {
			port, _ := strconv.Atoi(tail)
			return host, &port
		}
	}

	return value, nil
}

// CookieSecureEffective 会话 cookie 是否带 Secure:显式配置优先,
// 未配置按部署 URL 自动推导(https 启用,本地 http 保持关闭)。
func (s *Settings) CookieSecureEffective() bool {
	if s.AdminCookieSecure != nil {
		return *s.AdminCookieSecure
	}
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(s.PublicBaseURL)), "https://")
}

// CredentialWarnings 启动期需要运维关注的弱凭证提示(不阻止启动)。
func (s *Settings) CredentialWarnings() []string {
	var warnings []string
	if strings.TrimSpace(s.PostgresHost) != "" &&
		(s.PostgresPass == "" || s.PostgresPass == "change-me") {
		warnings = append(warnings,
			"POSTGRES_PASSWORD 为空或示例值 change-me:数据库未对外暴露时风险可控,但生产部署前必须更换为强随机值")
	}
	if s.AdminToken != "" && !s.CookieSecureEffective() {
		base := strings.ToLower(strings.TrimSpace(s.PublicBaseURL))
		if strings.HasPrefix(base, "https://") {
			warnings = append(warnings,
				"public_base_url 为 https 但会话 cookie 未启用 Secure:请设置 ADMIN_COOKIE_SECURE=true 或移除该变量以自动推导")
		}
	}
	return warnings
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func checkRange(key string, val, min, max int) error {
	if val < min || val > max {
		return fmt.Errorf("%s=%d 超出允许范围 [%d, %d]", key, val, min, max)
	}
	return nil
}

func checkRangeInt64(key string, val, min, max int64) error {
	if val < min || val > max {
		return fmt.Errorf("%s=%d 超出允许范围 [%d, %d]", key, val, min, max)
	}
	return nil
}

func checkRangeFloat(key string, val, min, max float64) error {
	if val < min || val > max {
		return fmt.Errorf("%s=%v 超出允许范围 [%v, %v]", key, val, min, max)
	}
	return nil
}
