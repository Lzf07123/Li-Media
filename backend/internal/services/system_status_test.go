package services

import (
	"context"
	"testing"

	"limedia/backend/internal/config"
)

func systemStatusTestSettings(mediaRoot string) *config.Settings {
	return &config.Settings{
		ProjectName:                "Li&Media",
		Version:                    "0.1.0",
		MediaRoot:                  mediaRoot,
		NginxCacheRoot:             mediaRoot + "/nginx_cache",
		RedisURL:                   "redis://127.0.0.1:1/0", // 连接立即失败 → unavailable
		MediaDerivativeVersion:     "20260906-ratio-v1",
		BaiduSyncDir:               "/apps/Li&Media",
		BaiduAccessToken:           "test-token",
		PreheatConcurrencyLimit:    3,
		PreheatQueueLimit:          64,
		ScanQueueLimit:             1,
		PreheatWaitTimeoutSec:      2,
		PreheatRetryCooldownSec:    3600,
		SourceDownloadTimeoutSec:   600,
		DerivativeConcurrencyLimit: 2,
		DerivativeQueueLimit:       32,
		DerivativeWaitTimeoutSec:   15,
		DirectProbeConcurrencyLimit: 4,
		DirectProbeQueueLimit:       16,
		ScanConcurrencyLimit:        1,
		StreamGlobalConcurrencyLimit: 16,
		StreamUserConcurrencyLimit:   3,
		StreamQueueLimit:             32,
		StreamWaitTimeoutSec:         1,
		RemoteThumbnailMaxTempFiles:  8,
		RemoteThumbnailDiskQuotaBytes: 4 * 1024 * 1024 * 1024,
		BackendMemoryLimitBytes:       256 * 1024 * 1024,
		TaskThreadPoolSize:            24,
		BaiduOAuthClientID:            "test-key",
		BaiduOAuthClientSecret:        "test-secret",
	}
}

func TestCollectSystemStatusKeySubitems(t *testing.T) {
	pool := servicesTestPool(t)
	seedAdminMatrix(t, pool)
	ctx := context.Background()

	mediaRoot := t.TempDir()
	settings := systemStatusTestSettings(mediaRoot)
	governor := NewTaskGovernor(settings)
	governor.Metrics.RecordStarted(TaskTypeDerivative)
	governor.Metrics.RecordCompleted(TaskTypeDerivative)

	deps := &SystemStatusDeps{Pool: pool, Settings: settings, Governor: governor}
	status, err := CollectSystemStatus(ctx, deps, nil)
	if err != nil {
		t.Fatal(err)
	}

	// 后端运行时。
	if status.Backend.AppName != "Li&Media" || status.Backend.Version != "0.1.0" {
		t.Fatalf("backend 元信息 = (%q, %q)", status.Backend.AppName, status.Backend.Version)
	}
	if status.Backend.Pid <= 0 {
		t.Fatalf("pid = %d", status.Backend.Pid)
	}
	if status.Backend.StackGuard != "task thread pool + cgroup memory + pids limit" {
		t.Fatalf("stack_guard = %q", status.Backend.StackGuard)
	}
	if status.Backend.Database.Status != "ok" || status.Backend.Database.Dialect == nil ||
		*status.Backend.Database.Dialect != "postgresql" {
		t.Fatalf("database status = %+v", status.Backend.Database)
	}
	if status.Backend.Redis.Status != "unavailable" {
		t.Fatalf("不可达 redis 应 unavailable: %+v", status.Backend.Redis)
	}
	if status.Backend.Configuration.PreheatConcurrencyLimit != 3 ||
		status.Backend.Configuration.TempMaxFiles != 8 {
		t.Fatalf("configuration = %+v", status.Backend.Configuration)
	}

	// 远程存储计数(口径与 admin 矩阵一致)。
	counts := status.RemoteStorage.Counts
	if counts.Total != 7 || counts.RemoteReady != 6 {
		t.Fatalf("total/remote_ready = (%d, %d), want (7, 6)", counts.Total, counts.RemoteReady)
	}
	if counts.ThumbnailReady != 5 || counts.ThumbnailMissing != 1 ||
		counts.ThumbnailFailed != 1 || counts.ThumbnailRetryable != 0 {
		t.Fatalf("thumbnail 计数 = %+v", counts)
	}
	if counts.ThumbnailFailureKinds["source_truncated"] != 1 {
		t.Fatalf("failure_kinds = %v", counts.ThumbnailFailureKinds)
	}
	if counts.StreamReady != 2 || counts.StreamFailed != 0 {
		t.Fatalf("stream 计数 = (%d, %d)", counts.StreamReady, counts.StreamFailed)
	}
	// 公开口径:#1 #2 #3(派生就绪);#4 browser unsupported 被排除。
	if counts.DetailDerivativeTotal != 3 || counts.HomeDerivativeReady != 3 {
		t.Fatalf("derivative 计数 = (home=%d, detail_total=%d)",
			counts.HomeDerivativeReady, counts.DetailDerivativeTotal)
	}
	if counts.DetailDerivativeReady != 0 {
		t.Fatalf("detail_derivative_ready = %d, want 0(未种 480/768/1280)", counts.DetailDerivativeReady)
	}

	// 远程存储状态。
	if status.RemoteStorage.Provider != "baidupan" || status.RemoteStorage.ScanDir != "/apps/Li&Media" {
		t.Fatalf("provider/scan_dir = (%q, %q)", status.RemoteStorage.Provider, status.RemoteStorage.ScanDir)
	}
	if !status.RemoteStorage.Configured || !status.RemoteStorage.OauthConfigured {
		t.Fatalf("configured/oauth = (%v, %v)", status.RemoteStorage.Configured, status.RemoteStorage.OauthConfigured)
	}
	if status.RemoteStorage.LastScan != nil {
		t.Fatalf("无扫描任务时 last_scan 应为 nil")
	}

	// 源审计:media_root 为空 → 合规。
	if !status.SourceZero.Compliant {
		t.Fatalf("空 media_root 应合规: %+v", status.SourceZero)
	}

	// 任务队列:五类任务齐备,limit 来自配置。
	for _, taskType := range []string{"scan", "direct_probe", "derivative", "preheat", "stream"} {
		task, ok := status.Tasks[taskType]
		if !ok {
			t.Fatalf("缺任务类型 %s", taskType)
		}
		if task.Limit <= 0 || task.QueueLimit <= 0 {
			t.Fatalf("%s limit/queue_limit = (%d, %d)", taskType, task.Limit, task.QueueLimit)
		}
	}
	if status.Tasks["derivative"].Active != 0 {
		t.Fatalf("derivative active = %d, want 0", status.Tasks["derivative"].Active)
	}

	// 指标:仅 int 值进入 metrics。
	if status.Metrics["derivative.started"] != 1 || status.Metrics["derivative.completed"] != 1 {
		t.Fatalf("metrics = %v", status.Metrics)
	}

	// 资源指标:结构齐备。
	if status.Resources.Caches.Temporary.Status != "ok" {
		t.Fatalf("tmp 缓存状态 = %q", status.Resources.Caches.Temporary.Status)
	}
	if status.Resources.Limits.BackendMemoryBytes == nil ||
		*status.Resources.Limits.BackendMemoryBytes != settings.BackendMemoryLimitBytes {
		t.Fatalf("limits = %+v", status.Resources.Limits)
	}
}

func TestCollectPreheatHealth(t *testing.T) {
	// 无历史文件:中性默认值。
	empty := CollectPreheatHealth(systemStatusTestSettings(t.TempDir()))
	if empty.HistoryJobs != 0 || empty.RecentSuccessRate != 1.0 || empty.LastStatus != nil {
		t.Fatalf("无历史 = %+v", empty)
	}

	// 正常历史:聚合 + 最近一次终态。
	dir := t.TempDir()
	history := `[
		{"status": "completed", "completed_at": "2026-01-01T08:00:00+00:00", "generated": 3, "cached": 1, "failed": 0},
		{"status": "failed", "completed_at": "2026-01-02T09:00:00+00:00", "generated": 1, "cached": 0, "failed": 2}
	]`
	settings := systemStatusTestSettings(dir)
	if err := writeFileForTest(settings.MediaRoot, "preheat-history.json", history); err != nil {
		t.Fatal(err)
	}
	health := CollectPreheatHealth(settings)
	if health.HistoryJobs != 2 || health.RecentGenerated != 4 || health.RecentCached != 1 || health.RecentFailed != 2 {
		t.Fatalf("聚合 = %+v", health)
	}
	// delivered=5, attempts=7。
	if health.RecentSuccessRate < 0.7142 || health.RecentSuccessRate > 0.7143 {
		t.Fatalf("成功率 = %v, want 5/7", health.RecentSuccessRate)
	}
	if health.LastStatus == nil || *health.LastStatus != "failed" {
		t.Fatalf("last_status = %v, want failed", health.LastStatus)
	}
	if health.LastCompletedAt == nil || health.LastCompletedAt.UTC().Hour() != 9 {
		t.Fatalf("last_completed_at = %v", health.LastCompletedAt)
	}
}
