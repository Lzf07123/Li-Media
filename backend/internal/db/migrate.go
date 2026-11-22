package db

import (
	"database/sql"
	"embed"
	"errors"
	"fmt"

	"github.com/golang-migrate/migrate/v4"
	pgxdriver "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	_ "github.com/jackc/pgx/v5/stdlib" // database/sql 注册 "pgx" 驱动
)

// migrations 内嵌全部 SQL 迁移文件,二进制自足,无需外部 migrate 工具。
//
//go:embed migrations/*.sql
var migrations embed.FS

const baselineVersion = 1

// MigrateUp 将数据库推进到最新迁移。幂等:已到最新时是 no-op。
//
// 存量库升级路径:曾由 Alembic(0001..0010)建表、但从未运行过本迁移链
// 的数据库,会被识别为「已完成基线」——直接登记版本 1 并退役
// alembic_version 表,不重放 0001(CREATE TABLE 会撞已存在的表)。
// 存量库升级路径:曾由 Alembic(0001..0010)建表、但从未运行过本迁移链
// 的数据库,会被识别为「已完成基线」——直接登记版本 1 并退役
// alembic_version 表,不重放 0001(CREATE TABLE 会撞已存在的表);
// 随后继续执行基线之后的迁移(如 0002 数据修复)。
// 全新数据库则正常执行迁移链。
func MigrateUp(databaseURL string) error {
	conn, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return fmt.Errorf("打开迁移连接失败: %w", err)
	}
	defer conn.Close()

	if hasTable(conn, "alembic_version") && !hasTable(conn, "schema_migrations") {
		if err := adoptLegacyDatabase(conn); err != nil {
			return err
		}
	}

	source, err := iofs.New(migrations, "migrations")
	if err != nil {
		return fmt.Errorf("读取内嵌迁移失败: %w", err)
	}

	driver, err := pgxdriver.WithInstance(conn, &pgxdriver.Config{})
	if err != nil {
		return fmt.Errorf("初始化迁移驱动失败: %w", err)
	}

	m, err := migrate.NewWithInstance("iofs", source, "pgx", driver)
	if err != nil {
		return fmt.Errorf("初始化迁移器失败: %w", err)
	}
	defer func() {
		_, _ = m.Close()
	}()

	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("执行迁移失败: %w", err)
	}
	return nil
}

// adoptLegacyDatabase 把 Alembic 数据库登记为基线版本并退役版本表。
func adoptLegacyDatabase(conn *sql.DB) error {
	if _, err := conn.Exec(
		`CREATE TABLE IF NOT EXISTS schema_migrations (version bigint not null primary key, dirty boolean not null)`,
	); err != nil {
		return fmt.Errorf("存量库基线登记失败: %w", err)
	}
	if _, err := conn.Exec(
		`INSERT INTO schema_migrations (version, dirty) VALUES ($1, false) ON CONFLICT (version) DO NOTHING`,
		baselineVersion,
	); err != nil {
		return fmt.Errorf("存量库基线登记失败: %w", err)
	}
	if _, err := conn.Exec(`DROP TABLE IF EXISTS alembic_version`); err != nil {
		return fmt.Errorf("退役 alembic_version 失败: %w", err)
	}
	return nil
}

func hasTable(conn *sql.DB, name string) bool {
	var exists bool
	err := conn.QueryRow(
		`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1)`,
		name,
	).Scan(&exists)
	return err == nil && exists
}
