// admin_filters.go 对齐原 app/services/admin_filters.py:
// 后台列表、计数与批量操作共用的过滤谓词与计数口径。
//
// Python 版以 SQLAlchemy statement 组合表达;Go 无 ORM,等价实现为
// 「过滤条件结构体 + 参数化 WHERE 片段 + 显式 SQL」。计数口径保持逐条
// 一致:所有计数都作用在 `SELECT DISTINCT m.id` 的 memory 去重集合上
// (md5 去重会把多条文件挂到同一 memory,必须按 memory 计数)。
//
// 占位符纪律:全部条件统一经同一个 SQLCond 分配 $N 编号(filter 条件与
// count_* 追加条件共用一个 builder),避免多 builder 编号错位。
package services

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"limedia/backend/internal/models"
	"limedia/backend/internal/repo"
)

// ---- 计数契约结构(json 字段名与序对齐 schemas/responses.py) ----

// MemoryCounts 对齐 responses.MemoryCounts。
type MemoryCounts struct {
	Photo int `json:"photo"`
	Video int `json:"video"`
}

// DisplayHealthCounts 对齐 responses.DisplayHealthCounts。
type DisplayHealthCounts struct {
	Displayable int `json:"displayable"`
	Excluded    int `json:"excluded"`
}

// BrowserCompatibilityCounts 对齐 responses.BrowserCompatibilityCounts。
type BrowserCompatibilityCounts struct {
	Supported   int `json:"supported"`
	Unsupported int `json:"unsupported"`
	Unknown     int `json:"unknown"`
}

// MemoryStatusCounts 对齐 responses.MemoryStatusCounts。
type MemoryStatusCounts struct {
	Published   int `json:"published"`
	Unpublished int `json:"unpublished"`
}

// AdminMemoryCounts 对齐 collect_counts 返回的字典结构。
type AdminMemoryCounts struct {
	Total         int                        `json:"total"`
	Counts        MemoryCounts               `json:"counts"`
	StatusCounts  MemoryStatusCounts         `json:"status_counts"`
	DisplayCounts DisplayHealthCounts        `json:"display_counts"`
	BrowserCounts BrowserCompatibilityCounts `json:"browser_counts"`
}

// AdminMemoryFilter 后台列表过滤参数,对齐 add_admin_filters 关键字。
type AdminMemoryFilter struct {
	Kind          *models.MemoryKind   // nil=不过滤
	Status        *models.MemoryStatus // nil=不过滤
	Keyword       string               // 空串=不过滤
	Display       string               // all|displayable|excluded(默认 all)
	Compatibility string               // all|supported|unsupported|unknown(默认 all)
}

// AdminBaseWhere 基础口径:memory join 文件且文件来自 baidupan
// (对齐 base_remote_statement 的 join + where,去重由计数/取数端处理)。
func AdminBaseWhere(b *repo.SQLCond) string {
	return "f.source = " + b.Placeholder("baidupan")
}

// AdminFilterWhere 追加后台过滤条件(kind/status/keyword/display/compatibility)。
// 条件作用于 (m, f) join 别名,与 Python 的 statement.where 链等价。
func AdminFilterWhere(b *repo.SQLCond, filter AdminMemoryFilter) string {
	conds := []string{AdminBaseWhere(b)}

	if filter.Kind != nil {
		conds = append(conds, "m.kind = "+b.Placeholder(*filter.Kind))
	}
	if filter.Status != nil {
		conds = append(conds, "m.status = "+b.Placeholder(*filter.Status))
	}
	if filter.Keyword != "" {
		pattern := "%" + repo.EscapeLike(filter.Keyword) + "%"
		p := b.Placeholder(pattern)
		conds = append(conds,
			"(m.title ILIKE "+p+" ESCAPE '\\'"+
				" OR m.description ILIKE "+p+" ESCAPE '\\'"+
				" OR m.location ILIKE "+p+" ESCAPE '\\')")
	}
	switch filter.Display {
	case "displayable":
		conds = append(conds, b.DisplayableFilesCondition())
	case "excluded":
		conds = append(conds, "NOT "+b.DisplayableFilesCondition())
	}

	if filter.Compatibility != "" && filter.Compatibility != "all" {
		conds = append(conds,
			"(m.kind = "+b.Placeholder(models.MemoryKindVideo)+
				" AND f.browser_compatibility = "+b.Placeholder(models.BrowserCompatibilityState(filter.Compatibility))+")")
	}
	return strings.Join(conds, " AND ")
}

// adminCountStatementFn 计数:extra 条件由内部构建器生成(占位编号延续 filter)。
func adminCountStatementFn(ctx context.Context, pool *pgxpool.Pool, filter AdminMemoryFilter, extraFn func(b *repo.SQLCond) (string, []any)) (int, error) {
	b := repo.NewSQLCond()
	where := AdminFilterWhere(b, filter)
	args := b.Args()
	if extraFn != nil {
		condition, extraArgs := extraFn(b)
		if condition != "" {
			where += " AND " + condition
			args = append(args, extraArgs...)
		}
	}
	sql := "SELECT count(*) FROM (SELECT DISTINCT m.id FROM memories m" +
		" JOIN memory_files f ON f.memory_id = m.id WHERE " + where + ") sub"
	count := 0
	if err := pool.QueryRow(ctx, sql, args...).Scan(&count); err != nil {
		return 0, fmt.Errorf("后台计数查询失败: %w", err)
	}
	return count, nil
}

// adminCountStatement 计数:子查询去重 memory 后计数
// (对齐 select(func.count()).select_from(statement.subquery()))。
// extra 在基础过滤后追加,统一经 SQLCond 分配占位符
// (对齐 count_kind 等函数的 statement.where 追加)。
func adminCountStatement(
	ctx context.Context,
	pool *pgxpool.Pool,
	filter AdminMemoryFilter,
	extra func(b *repo.SQLCond) string,
) (int, error) {
	b := repo.NewSQLCond()
	where := AdminFilterWhere(b, filter)
	if extra != nil {
		where += " AND " + extra(b)
	}
	args := b.Args()
	sql := "SELECT count(*) FROM (SELECT DISTINCT m.id FROM memories m" +
		" JOIN memory_files f ON f.memory_id = m.id WHERE " + where + ") sub"
	count := 0
	if err := pool.QueryRow(ctx, sql, args...).Scan(&count); err != nil {
		return 0, fmt.Errorf("后台计数查询失败: %w", err)
	}
	return count, nil
}

// CountAdminMemories 对齐 count_statement:按过滤口径的总数。
func CountAdminMemories(ctx context.Context, pool *pgxpool.Pool, filter AdminMemoryFilter) (int, error) {
	return adminCountStatement(ctx, pool, filter, nil)
}

// CountAdminKind 对齐 count_kind。
func CountAdminKind(ctx context.Context, pool *pgxpool.Pool, filter AdminMemoryFilter, kind models.MemoryKind) (int, error) {
	return adminCountStatement(ctx, pool, filter, func(b *repo.SQLCond) string {
		return "m.kind = " + b.Placeholder(kind)
	})
}

// CountAdminStatus 对齐 count_status。
func CountAdminStatus(ctx context.Context, pool *pgxpool.Pool, filter AdminMemoryFilter, status models.MemoryStatus) (int, error) {
	return adminCountStatement(ctx, pool, filter, func(b *repo.SQLCond) string {
		return "m.status = " + b.Placeholder(status)
	})
}

// CountAdminDisplayable 对齐 count_displayable:displayable 真伪二选一。
func CountAdminDisplayable(ctx context.Context, pool *pgxpool.Pool, filter AdminMemoryFilter, displayable bool) (int, error) {
	return adminCountStatement(ctx, pool, filter, func(b *repo.SQLCond) string {
		condition := b.DisplayableFilesCondition()
		if !displayable {
			condition = "NOT " + condition
		}
		return condition
	})
}

// CountAdminBrowserState 对齐 count_browser_state:video 且指定兼容状态。
func CountAdminBrowserState(ctx context.Context, pool *pgxpool.Pool, filter AdminMemoryFilter, state models.BrowserCompatibilityState) (int, error) {
	return adminCountStatement(ctx, pool, filter, func(b *repo.SQLCond) string {
		return "m.kind = " + b.Placeholder(models.MemoryKindVideo) +
			" AND f.browser_compatibility = " + b.Placeholder(state)
	})
}

// CollectAdminCounts 对齐 collect_counts:一次聚合全部仪表盘计数。
func CollectAdminCounts(ctx context.Context, pool *pgxpool.Pool, filter AdminMemoryFilter) (*AdminMemoryCounts, error) {
	total, err := CountAdminMemories(ctx, pool, filter)
	if err != nil {
		return nil, err
	}
	photo, err := CountAdminKind(ctx, pool, filter, models.MemoryKindPhoto)
	if err != nil {
		return nil, err
	}
	published, err := CountAdminStatus(ctx, pool, filter, models.MemoryStatusPublished)
	if err != nil {
		return nil, err
	}
	displayable, err := CountAdminDisplayable(ctx, pool, filter, true)
	if err != nil {
		return nil, err
	}
	supported, err := CountAdminBrowserState(ctx, pool, filter, models.BrowserCompatibilityStateSupported)
	if err != nil {
		return nil, err
	}
	unsupported, err := CountAdminBrowserState(ctx, pool, filter, models.BrowserCompatibilityStateUnsupported)
	if err != nil {
		return nil, err
	}
	videoTotal, err := CountAdminKind(ctx, pool, filter, models.MemoryKindVideo)
	if err != nil {
		return nil, err
	}

	return &AdminMemoryCounts{
		Total: total,
		Counts: MemoryCounts{
			Photo: photo,
			Video: total - photo,
		},
		StatusCounts: MemoryStatusCounts{
			Published:   published,
			Unpublished: total - published,
		},
		DisplayCounts: DisplayHealthCounts{
			Displayable: displayable,
			Excluded:    total - displayable,
		},
		BrowserCounts: BrowserCompatibilityCounts{
			Supported:   supported,
			Unsupported: unsupported,
			Unknown:     videoTotal - supported - unsupported,
		},
	}, nil
}
