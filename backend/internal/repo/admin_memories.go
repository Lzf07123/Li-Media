// admin_memories.go 后台 memories 的数据访问:列表/分页/单条取回,
// 对齐 admin.py 的 base_remote_statement + add_admin_filters 链。
package repo

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"limedia/backend/internal/models"
)

// AdminListOptions 后台列表参数(过滤口径见 admin_filters.go)。
type AdminListOptions struct {
	Filter   AdminMemoryFilter
	Page     int
	PageSize int
}

// AdminPage 后台列表一页。
type AdminPage struct {
	Items []*models.Memory
	Total int
}

// ListAdminMemories 后台分页列表(含草稿/隐藏,首文件即 primary_file)。
func ListAdminMemories(ctx context.Context, pool *pgxpool.Pool, opts AdminListOptions) (*AdminPage, error) {
	condBuilder := newAdminCond()
	cond := AdminFilterWhere(condBuilder, opts.Filter)

	count, err := CountAdminMemories(ctx, pool, opts.Filter)
	if err != nil {
		return nil, err
	}

	// 过滤条件占位 $1..$k,分页参数延续 $k+1(LIMIT)、$k+2(OFFSET)。
	args := argsOf(condBuilder)
	args = append(args, opts.PageSize, (opts.Page-1)*opts.PageSize)
	limit := "$" + strconv.Itoa(len(args)-1)
	offset := "$" + strconv.Itoa(len(args))
	rows, err := pool.Query(ctx,
		`SELECT `+memoryColumns+` FROM memories m
		 WHERE EXISTS (SELECT 1 FROM memory_files f WHERE f.memory_id = m.id AND `+cond+`)
		 ORDER BY m.created_at DESC, m.id DESC
		 OFFSET `+offset+` LIMIT `+limit,
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("后台列表查询失败: %w", err)
	}
	memories, err := collectMemories(rows)
	if err != nil {
		return nil, err
	}
	if len(memories) == 0 {
		memories = []*models.Memory{}
	}
	memories, err = attachFilesAdmin(ctx, pool, memories)
	if err != nil {
		return nil, err
	}
	return &AdminPage{Items: memories, Total: count}, nil
}

// GetAdminByID 后台单条(含任何状态,首个文件即 primary_file)。
func GetAdminByID(ctx context.Context, pool *pgxpool.Pool, id uuid.UUID) (*models.Memory, error) {
	row := pool.QueryRow(ctx,
		`SELECT `+memoryColumnsBare+` FROM memories WHERE id = $1`, id)
	memory, err := scanMemory(row)
	if errorsIsNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("查询 memory 失败: %w", err)
	}
	files, err := filesByMemoryIDs(ctx, pool, []uuid.UUID{memory.ID})
	if err != nil {
		return nil, err
	}
	memory.Files = files[memory.ID]
	return memory, nil
}

func errorsIsNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

// attachFilesAdmin 后台列表组装文件(admin 口径不过滤文件状态)。
func attachFilesAdmin(ctx context.Context, pool *pgxpool.Pool, memories []*models.Memory) ([]*models.Memory, error) {
	if len(memories) == 0 {
		return memories, nil
	}
	ids := make([]uuid.UUID, len(memories))
	for i, m := range memories {
		ids[i] = m.ID
	}
	byID, err := filesByMemoryIDs(ctx, pool, ids)
	if err != nil {
		return nil, err
	}
	for _, m := range memories {
		m.Files = byID[m.ID]
	}
	return memories, nil
}

func filesByMemoryIDs(ctx context.Context, pool *pgxpool.Pool, ids []uuid.UUID) (map[uuid.UUID][]models.MemoryFile, error) {
	rows, err := pool.Query(ctx,
		`SELECT `+models.MemoryFilesColumns+` FROM memory_files WHERE memory_id = ANY($1) ORDER BY id`,
		ids,
	)
	if err != nil {
		return nil, fmt.Errorf("查询 memory files 失败: %w", err)
	}
	files, err := collectMemoryFiles(rows)
	if err != nil {
		return nil, err
	}
	byMemory := make(map[uuid.UUID][]models.MemoryFile)
	for _, f := range files {
		if f.MemoryID != nil {
			byMemory[*f.MemoryID] = append(byMemory[*f.MemoryID], f)
		}
	}
	return byMemory, nil
}
