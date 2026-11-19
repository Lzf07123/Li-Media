package services

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RecordAdminOperation 写入管理操作审计(对齐 admin_logs.record_admin_operation)。
func RecordAdminOperation(
	pool *pgxpool.Pool,
	action string,
	targetType, targetID, clientIP, detail *string,
) error {
	_, err := pool.Exec(context.Background(),
		`INSERT INTO admin_operation_logs (id, action, target_type, target_id, client_ip, detail)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		uuid.New(), action, targetType, targetID, clientIP, detail,
	)
	if err != nil {
		return fmt.Errorf("写入管理审计失败: %w", err)
	}
	return nil
}
