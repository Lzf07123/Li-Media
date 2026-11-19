package services

import (
	"time"
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"

	"limedia/backend/internal/config"
	"limedia/backend/internal/models"
)

func TestRunBatchStatusJobCompletes(t *testing.T) {
	pool := servicesTestPool(t)
	ctx := context.Background()

	m1 := "00000000-0000-4000-8000-0000000000b1"
	m2 := "00000000-0000-4000-8000-0000000000b2"
	m3 := "00000000-0000-4000-8000-0000000000b3"
	jobID := uuid.MustParse("30000000-0000-4000-8000-000000000001")

	stmts := []string{
		`INSERT INTO memories (id, title, kind, status) VALUES
			('` + m1 + `', '批量甲', 'photo', 'published'),
			('` + m2 + `', '批量乙', 'photo', 'hidden'),
			('` + m3 + `', '批量丙', 'photo', 'published')`,
		`INSERT INTO memory_files (id, memory_id, source, remote_path, remote_id, source_path,
			parent_path, filename, mime_type, remote_state, thumbnail_state, stream_state,
			browser_compatibility, status) VALUES
			('10000000-0000-4000-8000-0000000000b1', '` + m1 + `', 'baidupan', '/p/a.jpg', '201', '',
			 '/p', 'a.jpg', 'image/jpeg', 'ready', 'ready', 'unavailable', 'unknown', 'matched'),
			('10000000-0000-4000-8000-0000000000b2', '` + m2 + `', 'baidupan', '/p/b.jpg', '202', '',
			 '/p', 'b.jpg', 'image/jpeg', 'ready', 'ready', 'unavailable', 'unknown', 'matched')`,
		`INSERT INTO admin_background_jobs (id, action, status, filter_snapshot, resource_ids, total)
		 VALUES ('` + jobID.String() + `', 'batch_hide', 'queued',
		 '{"status": "hidden", "keyword": null}', '["` + m1 + `","` + m2 + `","` + m3 + `"]'::json, 3)`,
	}
	for _, stmt := range stmts {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			t.Fatalf("种子导入失败: %v\n%s", err, stmt)
		}
	}

	deps := &BatchStatusJobDeps{Pool: pool, Settings: &config.Settings{NginxCacheRoot: "/nonexistent-nginx-cache"}}
	operator := uuid.MustParse("40000000-0000-4000-8000-000000000001")
	RunBatchStatusJob(ctx, deps, jobID, models.MemoryStatusHidden, &operator)

	// 任务行断言。
	var status string
	var total, processed, changed, skipped, failed int
	var errorMessage *string
	if err := pool.QueryRow(ctx,
		`SELECT status, total, processed, changed, skipped, failed, error_message
		 FROM admin_background_jobs WHERE id = $1`, jobID,
	).Scan(&status, &total, &processed, &changed, &skipped, &failed, &errorMessage); err != nil {
		t.Fatal(err)
	}
	if status != "completed" {
		t.Fatalf("status = %q, want completed", status)
	}
	if total != 3 || processed != 3 || changed != 1 || skipped != 1 || failed != 1 {
		t.Fatalf("计数 = (total=%d, processed=%d, changed=%d, skipped=%d, failed=%d)",
			total, processed, changed, skipped, failed)
	}
	if errorMessage == nil ||
		*errorMessage != "failed=1;reason=memory_or_remote_index_missing;retry=rescan_remote_directory" {
		t.Fatalf("error_message = %v", errorMessage)
	}

	// memory 状态断言:m1 → hidden,m2 保持 hidden,m3 不动。
	var m1Status, m2Status, m3Status string
	if err := pool.QueryRow(ctx, `SELECT status FROM memories WHERE id = $1`, uuid.MustParse(m1)).Scan(&m1Status); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT status FROM memories WHERE id = $1`, uuid.MustParse(m2)).Scan(&m2Status); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT status FROM memories WHERE id = $1`, uuid.MustParse(m3)).Scan(&m3Status); err != nil {
		t.Fatal(err)
	}
	if m1Status != "hidden" || m2Status != "hidden" || m3Status != "published" {
		t.Fatalf("memory 状态 = (%q, %q, %q)", m1Status, m2Status, m3Status)
	}

	// 审计日志断言:action 映射 + detail 契约格式。
	var action, detail string
	if err := pool.QueryRow(ctx,
		`SELECT action, detail FROM admin_operation_logs
		 WHERE target_type = 'memory_batch_job' ORDER BY created_at DESC LIMIT 1`,
	).Scan(&action, &detail); err != nil {
		t.Fatal(err)
	}
	if action != "batch_hide" {
		t.Fatalf("action = %q, want batch_hide", action)
	}
	for _, fragment := range []string{
		"job=" + jobID.String(),
		"status=completed",
		"session=" + operator.String(),
		"nginx_cache_files=0",
		`filters={"keyword": null, "status": "hidden"}`,
		`resource_ids=["` + m1 + `","` + m2 + `","` + m3 + `"]`,
	} {
		if !strings.Contains(detail, fragment) {
			t.Fatalf("detail 缺少 %q:\n%s", fragment, detail)
		}
	}
}

func TestRunBatchStatusJobCancelled(t *testing.T) {
	pool := servicesTestPool(t)
	ctx := context.Background()

	m1 := "00000000-0000-4000-8000-0000000000c1"
	jobID := uuid.MustParse("30000000-0000-4000-8000-000000000002")
	stmts := []string{
		`INSERT INTO memories (id, title, kind, status) VALUES
			('` + m1 + `', '取消甲', 'photo', 'published')`,
		`INSERT INTO memory_files (id, memory_id, source, remote_path, remote_id, source_path,
			parent_path, filename, mime_type, remote_state, thumbnail_state, stream_state,
			browser_compatibility, status) VALUES
			('10000000-0000-4000-8000-0000000000c1', '` + m1 + `', 'baidupan', '/p/c.jpg', '203', '',
			 '/p', 'c.jpg', 'image/jpeg', 'ready', 'ready', 'unavailable', 'unknown', 'matched')`,
		`INSERT INTO admin_background_jobs (id, action, status, filter_snapshot, resource_ids, total)
		 VALUES ('` + jobID.String() + `', 'batch_hide', 'queued', '{}', '["` + m1 + `"]'::json, 1)`,
	}
	for _, stmt := range stmts {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			t.Fatalf("种子导入失败: %v\n%s", err, stmt)
		}
	}

	// 预先请求取消:首个分块开始即中断。
	RequestBatchStatusCancel(jobID)
	deps := &BatchStatusJobDeps{Pool: pool, Settings: &config.Settings{NginxCacheRoot: "/nonexistent-nginx-cache"}}
	RunBatchStatusJob(ctx, deps, jobID, models.MemoryStatusHidden, nil)

	var status string
	var processed int
	var completedAt *time.Time
	if err := pool.QueryRow(ctx,
		`SELECT status, processed, completed_at FROM admin_background_jobs WHERE id = $1`, jobID,
	).Scan(&status, &processed, &completedAt); err != nil {
		t.Fatal(err)
	}
	if status != "cancelled" {
		t.Fatalf("status = %q, want cancelled", status)
	}
	if processed != 0 {
		t.Fatalf("取消时不应处理任何条目: processed=%d", processed)
	}
	if completedAt == nil {
		t.Fatal("cancelled 应有 completed_at")
	}

	// memory 状态未被变更。
	var m1Status string
	if err := pool.QueryRow(ctx, `SELECT status FROM memories WHERE id = $1`, uuid.MustParse(m1)).Scan(&m1Status); err != nil {
		t.Fatal(err)
	}
	if m1Status != "published" {
		t.Fatalf("取消后状态不应变更: %q", m1Status)
	}
}

func TestRunBatchStatusJobMissingJob(t *testing.T) {
	pool := servicesTestPool(t)
	deps := &BatchStatusJobDeps{Pool: pool, Settings: &config.Settings{}}
	// 不存在的任务:直接返回,不报错。
	RunBatchStatusJob(context.Background(), deps, uuid.New(), models.MemoryStatusHidden, nil)
}
