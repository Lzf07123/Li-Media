// Package db 提供 pgx 连接池与迁移入口,对应原 app/db/session.py。
package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Open 建立 pgx 连接池。pool_size/max_overflow 的 SQLAlchemy 语义映射:
// max_conns = pool_size + max_overflow,默认 8+8=16。
func Open(ctx context.Context, databaseURL string, poolSize, maxOverflow int) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("解析数据库连接串失败: %w", err)
	}
	maxConns := int32(poolSize + maxOverflow)
	if maxConns < 1 {
		maxConns = 16
	}
	cfg.MaxConns = maxConns

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("创建连接池失败: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("数据库 ping 失败: %w", err)
	}
	return pool, nil
}
