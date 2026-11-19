// Package services 服务层。admin_security.go 对齐原
// app/services/admin_security.py:进程内登录限流 + 数据库会话。
package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"limedia/backend/internal/models"
)

// AdminLoginLimitError 登录限流锁定,RetryAfterSeconds 供 429 响应头。
type AdminLoginLimitError struct {
	RetryAfterSeconds int
}

func (e *AdminLoginLimitError) Error() string { return "管理登录尝试过于频繁" }

// LoginAttempt 单客户端键的失败轨迹。
type LoginAttempt struct {
	Failures       int
	FirstFailureAt time.Time
	LockedUntil    time.Time
}

// AdminLoginRateLimiter 进程内限流器(对齐 Python 版;单副本部署前提)。
type AdminLoginRateLimiter struct {
	MaxAttempts int
	BaseDelay   float64
	MaxDelay    float64

	mu       sync.Mutex
	attempts map[string]*LoginAttempt
}

func NewAdminLoginRateLimiter(maxAttempts int, baseDelay, maxDelay float64) *AdminLoginRateLimiter {
	return &AdminLoginRateLimiter{
		MaxAttempts: maxAttempts,
		BaseDelay:   baseDelay,
		MaxDelay:    maxDelay,
		attempts:    make(map[string]*LoginAttempt),
	}
}

// Check 客户端处于锁定期时返回限流错误。
func (l *AdminLoginRateLimiter) Check(clientKey string) error {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if attempt, ok := l.attempts[clientKey]; ok && attempt.LockedUntil.After(now) {
		seconds := int(attempt.LockedUntil.Sub(now).Seconds())
		if seconds < 1 {
			seconds = 1
		}
		return &AdminLoginLimitError{RetryAfterSeconds: seconds}
	}
	return nil
}

// RecordFailure 记录失败并返回本次应退避的秒数;15 分钟窗口内
// 累计达 max_attempts 则锁定 15 分钟。
func (l *AdminLoginRateLimiter) RecordFailure(clientKey string) float64 {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()

	attempt, ok := l.attempts[clientKey]
	if !ok {
		attempt = &LoginAttempt{}
		l.attempts[clientKey] = attempt
	}
	if attempt.FirstFailureAt.IsZero() || now.Sub(attempt.FirstFailureAt) >= 15*time.Minute {
		attempt.FirstFailureAt = now
		attempt.Failures = 0
	}

	attempt.Failures++
	delay := l.BaseDelay * float64(int(1)<<(attempt.Failures-1)) // base * 2^(n-1)
	if delay > l.MaxDelay {
		delay = l.MaxDelay
	}
	if attempt.Failures >= l.MaxAttempts && !attempt.FirstFailureAt.IsZero() {
		attempt.LockedUntil = attempt.FirstFailureAt.Add(15 * time.Minute)
	}
	return delay
}

// Reset 登录成功后清空失败轨迹。
func (l *AdminLoginRateLimiter) Reset(clientKey string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, clientKey)
}

// SleepForLoginDelay 失败退避(Python 版直接 time.sleep;Go 由调用方决定阻塞)。
func SleepForLoginDelay(delay float64) {
	if delay > 0 {
		time.Sleep(time.Duration(delay * float64(time.Second)))
	}
}

// HashSessionToken sha256 hex,数据库中只存哈希。
func HashSessionToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// AdminSessions 会话数据访问。
type AdminSessions struct {
	Pool *pgxpool.Pool
}

// Create 新会话:先清理过期行,签发 32 字节 URL-safe token。
func (s *AdminSessions) Create(ctx context.Context, ttlMinutes int, clientIP *string) (string, error) {
	now := time.Now()
	if _, err := s.Pool.Exec(ctx,
		`DELETE FROM admin_sessions WHERE expires_at < $1`, now); err != nil {
		return "", fmt.Errorf("清理过期会话失败: %w", err)
	}

	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("生成会话令牌失败: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)

	if _, err := s.Pool.Exec(ctx,
		`INSERT INTO admin_sessions (id, token_hash, client_ip, expires_at)
		 VALUES ($1, $2, $3, $4)`,
		uuid.New(), HashSessionToken(token), clientIP,
		now.Add(time.Duration(ttlMinutes)*time.Minute),
	); err != nil {
		return "", fmt.Errorf("写入会话失败: %w", err)
	}
	return token, nil
}

// GetValid 按 token 哈希取未撤销、未过期的会话;未命中返回 (nil, nil)。
func (s *AdminSessions) GetValid(ctx context.Context, token string) (*models.AdminSession, error) {
	if token == "" {
		return nil, nil
	}
	row := s.Pool.QueryRow(ctx,
		`SELECT id, token_hash, client_ip, expires_at, revoked_at, created_at
		 FROM admin_sessions
		 WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
		HashSessionToken(token), time.Now(),
	)
	sess := &models.AdminSession{}
	if err := row.Scan(&sess.ID, &sess.TokenHash, &sess.ClientIP, &sess.ExpiresAt, &sess.RevokedAt, &sess.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("查询会话失败: %w", err)
	}
	return sess, nil
}

// Revoke 撤销当前有效会话。
func (s *AdminSessions) Revoke(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	_, err := s.Pool.Exec(ctx,
		`UPDATE admin_sessions SET revoked_at = $1
		 WHERE token_hash = $2 AND revoked_at IS NULL AND expires_at > $1`,
		time.Now(), HashSessionToken(token),
	)
	return err
}
