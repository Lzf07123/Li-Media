package services

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"limedia/backend/internal/db"
)

func testAdminPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	base := os.Getenv("GO_TEST_DATABASE_URL")
	if base == "" {
		base = "postgres://media:media@limedia-baseline-db:5432/media"
	}
	pool, err := pgxpool.New(context.Background(), base)
	if err != nil {
		t.Fatalf("连接测试库失败: %v", err)
	}
	if err := db.MigrateUp(base); err != nil {
		t.Fatalf("迁移失败: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestLoginRateLimiterLockout(t *testing.T) {
	limiter := NewAdminLoginRateLimiter(3, 0, 0) // 0 延迟:只验证锁定逻辑

	for i := 0; i < 2; i++ {
		if err := limiter.Check("client-a"); err != nil {
			t.Fatalf("未达上限不应锁定: %v", err)
		}
		limiter.RecordFailure("client-a")
	}
	if err := limiter.Check("client-a"); err != nil {
		t.Fatalf("第 3 次尝试前不应锁定: %v", err)
	}
	limiter.RecordFailure("client-a") // 第 3 次失败 → 锁定

	err := limiter.Check("client-a")
	if err == nil {
		t.Fatal("达到上限后应锁定")
	}
	limitErr, ok := err.(*AdminLoginLimitError)
	if !ok {
		t.Fatalf("错误类型应为 AdminLoginLimitError, got %T", err)
	}
	if limitErr.RetryAfterSeconds < 1 {
		t.Fatalf("RetryAfterSeconds 应 >= 1, got %d", limitErr.RetryAfterSeconds)
	}

	limiter.Reset("client-a")
	if err := limiter.Check("client-a"); err != nil {
		t.Fatalf("Reset 后不应锁定: %v", err)
	}
}

func TestLoginRateLimiterExponentialDelay(t *testing.T) {
	limiter := NewAdminLoginRateLimiter(20, 0.2, 2.0)
	limiter.RecordFailure("client-b") // 0.2 * 2^0 = 0.2
	d1 := limiter.RecordFailure("client-b") // 0.2 * 2^1 = 0.4
	if d1 != 0.4 {
		t.Fatalf("第二次失败退避 = %v, want 0.4", d1)
	}
	for i := 0; i < 10; i++ {
		limiter.RecordFailure("client-b")
	}
	if d := limiter.RecordFailure("client-b"); d != 2.0 {
		t.Fatalf("退避应被 max_delay 截断为 2.0, got %v", d)
	}
}

func TestAdminSessionLifecycle(t *testing.T) {
	pool := testAdminPool(t)
	ctx := context.Background()
	sessions := &AdminSessions{Pool: pool}

	token, err := sessions.Create(ctx, 120, nil)
	if err != nil {
		t.Fatal(err)
	}
	if token == "" {
		t.Fatal("应返回非空 token")
	}

	sess, err := sessions.GetValid(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	if sess == nil {
		t.Fatal("刚创建的会话应有效")
	}
	if sess.TokenHash != HashSessionToken(token) {
		t.Fatal("数据库应存哈希而非明文")
	}

	if err := sessions.Revoke(ctx, token); err != nil {
		t.Fatal(err)
	}
	sess, _ = sessions.GetValid(ctx, token)
	if sess != nil {
		t.Fatal("撤销后的会话不应有效")
	}

	if sess, _ := sessions.GetValid(ctx, ""); sess != nil {
		t.Fatal("空 token 应返回 nil")
	}
}

func TestAdminSessionExpiryCleanup(t *testing.T) {
	pool := testAdminPool(t)
	ctx := context.Background()

	// 直接插入一条已过期会话,Create 应清理它。
	_, err := pool.Exec(ctx,
		`INSERT INTO admin_sessions (id, token_hash, expires_at) VALUES (gen_random_uuid(), 'expired-hash', $1)`,
		time.Now().Add(-time.Hour),
	)
	if err != nil {
		t.Fatal(err)
	}

	sessions := &AdminSessions{Pool: pool}
	if _, err := sessions.Create(ctx, 120, nil); err != nil {
		t.Fatal(err)
	}

	var count int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM admin_sessions WHERE token_hash = 'expired-hash'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("过期会话应被 Create 清理")
	}
}
