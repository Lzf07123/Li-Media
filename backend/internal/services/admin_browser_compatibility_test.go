package services

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"

	"limedia/backend/internal/models"
)

func TestRunBrowserCompatibilityProbeCompletes(t *testing.T) {
	pool := servicesTestPool(t)
	ctx := context.Background()
	fileID := seedProbeFile(t, pool)
	jobID := uuid.MustParse("30000000-0000-4000-8000-000000000101")

	if _, err := pool.Exec(ctx,
		`INSERT INTO admin_background_jobs (id, action, status, filter_snapshot, resource_ids, total)
		 VALUES ($1, 'browser_probe_batch', 'queued', '{"limit": 10}', '[]', 10)`,
		jobID); err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	settings := probeTestSettings(dir)
	governor := NewTaskGovernor(settings)
	deps := &BrowserProbeJobDeps{Pool: pool, Settings: settings, Governor: governor}

	// 任务内部构造真实 BaiduPanClient,无法注入假客户端;测试配置凭证文件
	// (任意 token)并把网盘 API 指向不可达端口:open_stream 连接失败走
	// generic 分支(job 计 failed),据此验证任务编排、候选圈定与审计日志。
	credentialsPath := filepath.Join(dir, "baidu_token.json")
	if err := os.WriteFile(credentialsPath,
		[]byte(`{"access_token": "test-token", "expires_at": "2099-01-01T00:00:00Z"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	settings.BaiduCredentialsPath = credentialsPath
	settings.BaiduAPIBaseURL = "http://127.0.0.1:1/rest/2.0/xpan" // 连接立即失败
	settings.BaiduRetryAttempts = 1
	settings.BaiduRetryBaseDelaySec = 0
	settings.BaiduRequestIntervalSec = 0

	operator := uuid.MustParse("40000000-0000-4000-8000-000000000101")
	RunBrowserCompatibilityProbe(ctx, deps, jobID, &operator)

	var status string
	var total, processed, changed, skipped, failed int
	var errorMessage *string
	var resourceIDs string
	if err := pool.QueryRow(ctx,
		`SELECT status, total, processed, changed, skipped, failed, error_message,
		 resource_ids::text
		 FROM admin_background_jobs WHERE id = $1`, jobID,
	).Scan(&status, &total, &processed, &changed, &skipped, &failed, &errorMessage, &resourceIDs); err != nil {
		t.Fatal(err)
	}
	if status != "completed" {
		t.Fatalf("status = %q, want completed(探测失败计 failed 不中断任务); error_message=%q", status, *errorMessage)
	}
	if total != 1 || processed != 1 || changed != 0 || skipped != 0 || failed != 1 {
		t.Fatalf("计数 = (total=%d, processed=%d, changed=%d, skipped=%d, failed=%d)",
			total, processed, changed, skipped, failed)
	}
	if errorMessage == nil ||
		*errorMessage != "failed=1;reason=bounded_probe_unavailable;retry=later_or_refresh_remote_entry" {
		t.Fatalf("error_message = %v", errorMessage)
	}
	if !strings.Contains(resourceIDs, fileID.String()) {
		t.Fatalf("resource_ids 应含候选文件 id: %s", resourceIDs)
	}

	// 审计日志:action 固定 browser_probe,detail 含任务字段。
	var action, detail string
	if err := pool.QueryRow(ctx,
		`SELECT action, detail FROM admin_operation_logs
		 WHERE target_type = 'memory_batch_job' ORDER BY created_at DESC LIMIT 1`,
	).Scan(&action, &detail); err != nil {
		t.Fatal(err)
	}
	if action != "browser_probe" {
		t.Fatalf("action = %q, want browser_probe", action)
	}
	for _, fragment := range []string{
		"job=" + jobID.String(),
		"status=completed",
		"session=" + operator.String(),
		"processed=1;changed=0;skipped=0;failed=1",
	} {
		if !strings.Contains(detail, fragment) {
			t.Fatalf("detail 缺少 %q:\n%s", fragment, detail)
		}
	}

	// 失败探测的文件在库内应保持 unknown 且带文案。
	var persistedState string
	var persistedErr *string
	if err := pool.QueryRow(ctx,
		`SELECT browser_compatibility, browser_compatibility_error
		 FROM memory_files WHERE id = $1`, fileID,
	).Scan(&persistedState, &persistedErr); err != nil {
		t.Fatal(err)
	}
	if persistedState != string(models.BrowserCompatibilityStateUnknown) || persistedErr == nil {
		t.Fatalf("库内 = (%q, %v)", persistedState, persistedErr)
	}
	if governor.Metrics.Snapshot()["direct_probe.failed"].(int) != 1 {
		t.Fatalf("direct_probe.failed 指标应 +1: %v", governor.Metrics.Snapshot())
	}
}

func TestRunBrowserCompatibilityProbeCancel(t *testing.T) {
	pool := servicesTestPool(t)
	ctx := context.Background()
	fileID := seedProbeFile(t, pool)
	jobID := uuid.MustParse("30000000-0000-4000-8000-000000000102")

	if _, err := pool.Exec(ctx,
		`INSERT INTO admin_background_jobs (id, action, status, filter_snapshot, resource_ids, total)
		 VALUES ($1, 'browser_probe_batch', 'queued', '{}', '[]', 10)`,
		jobID); err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	settings := probeTestSettings(dir)
	// 凭证存在使客户端构造成功,取消发生在首个候选的探测之前。
	credentialsPath := filepath.Join(dir, "baidu_token.json")
	if err := os.WriteFile(credentialsPath,
		[]byte(`{"access_token": "test-token", "expires_at": "2099-01-01T00:00:00Z"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	settings.BaiduCredentialsPath = credentialsPath
	settings.BaiduAPIBaseURL = "http://127.0.0.1:1/rest/2.0/xpan"
	settings.BaiduRetryAttempts = 1
	settings.BaiduRetryBaseDelaySec = 0
	settings.BaiduRequestIntervalSec = 0
	governor := NewTaskGovernor(settings)
	deps := &BrowserProbeJobDeps{Pool: pool, Settings: settings, Governor: governor}

	RequestBrowserProbeCancel(jobID)
	RunBrowserCompatibilityProbe(ctx, deps, jobID, nil)

	var status string
	var processed int
	var detail string
	if err := pool.QueryRow(ctx,
		`SELECT j.status, j.processed, l.detail
		 FROM admin_background_jobs j
		 LEFT JOIN admin_operation_logs l
		   ON l.detail LIKE 'job=' || j.id::text || ';status=' || j.status || ';%'
		 WHERE j.id = $1`, jobID,
	).Scan(&status, &processed, &detail); err != nil {
		t.Fatal(err)
	}
	if status != "cancelled" {
		t.Fatalf("status = %q, want cancelled", status)
	}
	if processed != 0 {
		t.Fatalf("取消时不应处理条目: %d", processed)
	}
	if detail != "" && !strings.Contains(detail, "status=cancelled") {
		t.Fatalf("审计日志状态不符: %s", detail)
	}
	_ = fileID
}
