package repo

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"math/rand"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"limedia/backend/internal/models"
)

// HomePreheatSize 公开列表可见性的首页派生尺寸(对齐 HOME_PREHEAT_SIZE)。
const HomePreheatSize = 240

// MemoryQuery 公开 memories 的数据访问。
type MemoryQuery struct {
	Pool              *pgxpool.Pool
	DerivativeVersion string // settings.media_derivative_version
}

// ListOptions 列表查询参数。
type ListOptions struct {
	Kind                  string // photo/video/""(不过滤)
	Keyword               string
	Sort                  string // captured_desc/captured_asc/updated_desc/random
	Seed                  string // random 排序的访问级种子
	Page                  int
	PageSize              int
	RequireHomeDerivative bool // 列表与推荐要求 240px 派生图就绪
}

// ListResult 列表响应的计数口径。
type ListResult struct {
	Items            []*models.Memory
	Total            int
	PhotoCount       int
	VideoCount       int
	PublicTotal      int
	PublicPhotoCount int
}

const memoryColumns = `m.id, m.title, m.description, m.kind, m.status, m.captured_at,
m.location, m.thumbnail_path, m.duration_seconds, m.width, m.height,
m.created_at, m.updated_at`

// memoryColumnsBare 无表别名前缀版,供主键直查复用同一扫描序。
const memoryColumnsBare = `id, title, description, kind, status, captured_at,
location, thumbnail_path, duration_seconds, width, height,
created_at, updated_at`

// EscapeLike 转义 LIKE/ilike 通配符,用户输入按字面量匹配(对齐 text_search.escape_like)。
func EscapeLike(keyword string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return replacer.Replace(keyword)
}

// publicWhere 组装公开 memories 的 WHERE 片段(别名 m)。
func publicWhere(b *sqlBuilder, opts ListOptions) string {
	cond := b.PublicFilesCondition()
	if opts.RequireHomeDerivative {
		cond += " AND " + b.HomeDerivativeReadyCondition(b.version, HomePreheatSize)
	}
	where := `m.status = ` + b.placeholder(models.MemoryStatusPublished) +
		` AND EXISTS (SELECT 1 FROM memory_files f WHERE f.memory_id = m.id AND ` + cond + `)`

	if opts.Kind != "" {
		where += ` AND m.kind = ` + b.placeholder(models.MemoryKind(opts.Kind))
	}
	if opts.Keyword != "" {
		pattern := `%` + EscapeLike(opts.Keyword) + `%`
		p := b.placeholder(pattern)
		where += ` AND (m.title ILIKE ` + p + ` ESCAPE '\'` +
			` OR m.description ILIKE ` + p + ` ESCAPE '\'` +
			` OR m.location ILIKE ` + p + ` ESCAPE '\')`
	}
	return where
}

// ListPublic 分页查询公开 memories。计数与排序口径逐条对齐原 list_memories。
func (q *MemoryQuery) ListPublic(ctx context.Context, opts ListOptions) (*ListResult, error) {
	b := &sqlBuilder{version: q.DerivativeVersion}
	where := publicWhere(b, opts)

	// 计数:列表口径(含 home derivative 门槛)与 public_counts 口径(无门槛)。
	total := 0
	if err := q.Pool.QueryRow(ctx,
		`SELECT count(*) FROM memories m WHERE `+where, b.args...,
	).Scan(&total); err != nil {
		return nil, fmt.Errorf("统计公开列表失败: %w", err)
	}
	photoCount, err := q.countByKind(ctx, where, argsOf(b), models.MemoryKindPhoto)
	if err != nil {
		return nil, err
	}

	pb := &sqlBuilder{version: q.DerivativeVersion}
	// public_counts 是全站口径:不带 kind/keyword 过滤(对齐 Python 版)。
	publicWhereAll := publicWhere(pb, ListOptions{})
	publicTotal := 0
	if err := q.Pool.QueryRow(ctx,
		`SELECT count(*) FROM memories m WHERE `+publicWhereAll, pb.args...,
	).Scan(&publicTotal); err != nil {
		return nil, fmt.Errorf("统计公开计数失败: %w", err)
	}
	publicPhoto, err := q.countByKind(ctx, publicWhereAll, argsOf(pb), models.MemoryKindPhoto)
	if err != nil {
		return nil, err
	}

	// 取页数据。
	var memories []*models.Memory
	switch opts.Sort {
	case "random":
		memories, err = q.randomPage(ctx, where, argsOf(b), opts)
	default:
		memories, err = q.orderedPage(ctx, where, argsOf(b), opts)
	}
	if err != nil {
		return nil, err
	}

	return &ListResult{
		Items:            memories,
		Total:            total,
		PhotoCount:       photoCount,
		VideoCount:       total - photoCount,
		PublicTotal:      publicTotal,
		PublicPhotoCount: publicPhoto,
	}, nil
}

func argsOf(b *sqlBuilder) []any { return b.args }

func (q *MemoryQuery) countByKind(ctx context.Context, where string, args []any, kind models.MemoryKind) (int, error) {
	// kind 条件追加为末位参数。
	kindArg := append(args, kind)
	count := 0
	if err := q.Pool.QueryRow(ctx,
		`SELECT count(*) FROM memories m WHERE `+where+` AND m.kind = $`+itoa(len(kindArg)),
		kindArg...,
	).Scan(&count); err != nil {
		return 0, fmt.Errorf("统计分类计数失败: %w", err)
	}
	return count, nil
}

// orderedPage 普通排序:offset/limit 分页。
// captured_desc 是 Python 版的 else 分支兜底;非法 sort 不应到达此处。
func (q *MemoryQuery) orderedPage(ctx context.Context, where string, args []any, opts ListOptions) ([]*models.Memory, error) {
	order := map[string]string{
		"captured_desc": `m.captured_at DESC NULLS LAST, m.updated_at DESC, m.id DESC`,
		"captured_asc":  `m.captured_at ASC NULLS LAST, m.updated_at ASC, m.id DESC`,
		"updated_desc":  `m.updated_at DESC, m.captured_at DESC NULLS LAST, m.id DESC`,
	}[opts.Sort]
	if order == "" {
		order = `m.captured_at DESC NULLS LAST, m.updated_at DESC, m.id DESC`
	}

	args = append(args, opts.PageSize, (opts.Page-1)*opts.PageSize)
	limit := "$" + itoa(len(args)-1)
	offset := "$" + itoa(len(args))

	rows, err := q.Pool.Query(ctx,
		`SELECT `+memoryColumns+` FROM memories m WHERE `+where+
			` ORDER BY `+order+` OFFSET `+offset+` LIMIT `+limit,
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("查询公开列表失败: %w", err)
	}
	memories, err := collectMemories(rows)
	if err != nil {
		return nil, err
	}
	return q.attachFiles(ctx, memories)
}

// randomPage 种子稳定洗牌分页:同 seed 跨请求保持同序。
// 注:洗牌序列不与 Python Mersenne Twister 逐位一致(MT19937 无法在 Go
// 标准库复现),契约要求的是「同 seed 稳定 + 跨实现同集合」,顺序差异
// 在契约对比时按集合比较。
func (q *MemoryQuery) randomPage(ctx context.Context, where string, args []any, opts ListOptions) ([]*models.Memory, error) {
	rows, err := q.Pool.Query(ctx,
		`SELECT m.id FROM memories m WHERE `+where, args...)
	if err != nil {
		return nil, fmt.Errorf("查询随机候选失败: %w", err)
	}
	ids, err := collectIDs(rows)
	if err != nil {
		return nil, err
	}

	seed := opts.Seed
	if seed == "" {
		seed = uuid.NewString()
	}
	shuffleIDs(ids, seed)

	start := (opts.Page - 1) * opts.PageSize
	if start > len(ids) {
		start = len(ids)
	}
	end := start + opts.PageSize
	if end > len(ids) {
		end = len(ids)
	}
	pageIDs := ids[start:end]
	if len(pageIDs) == 0 {
		return []*models.Memory{}, nil
	}

	pageArgs := append(append([]any{}, args...), pageIDs)
	pageSet := "$" + itoa(len(pageArgs))
	memories, err := q.PoolQueryPage(ctx, where, pageArgs, pageSet)
	if err != nil {
		return nil, err
	}

	// 按洗牌顺序输出。
	byID := make(map[uuid.UUID]*models.Memory, len(memories))
	for _, m := range memories {
		byID[m.ID] = m
	}
	ordered := make([]*models.Memory, 0, len(pageIDs))
	for _, id := range pageIDs {
		if m, ok := byID[id]; ok {
			ordered = append(ordered, m)
		}
	}
	return q.attachFiles(ctx, ordered)
}

// PoolQueryPage 取页内 id 集合的完整行。
func (q *MemoryQuery) PoolQueryPage(ctx context.Context, where string, args []any, pageSet string) ([]*models.Memory, error) {
	rows, err := q.Pool.Query(ctx,
		`SELECT `+memoryColumns+` FROM memories m WHERE `+where+` AND m.id = ANY(`+pageSet+`)`,
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("查询随机页失败: %w", err)
	}
	memories, err := collectMemories(rows)
	if err != nil {
		return nil, err
	}
	return memories, nil
}

// shuffleIDs Fisher-Yates,FNV-1a 把种子字符串稳定映射到 int64。
func shuffleIDs(ids []uuid.UUID, seed string) {
	h := fnv.New64a()
	_, _ = h.Write([]byte(seed))
	rng := rand.New(rand.NewSource(int64(h.Sum64())))
	rng.Shuffle(len(ids), func(i, j int) { ids[i], ids[j] = ids[j], ids[i] })
}

// ListRecommend 随机推荐(home 派生门槛),对齐 recommend_memories。
func (q *MemoryQuery) ListRecommend(ctx context.Context, kind string, limit int) ([]*models.Memory, error) {
	b := &sqlBuilder{version: q.DerivativeVersion}
	where := publicWhere(b, ListOptions{
		Kind:                  kind,
		RequireHomeDerivative: true,
	})

	rows, err := q.Pool.Query(ctx,
		`SELECT `+memoryColumns+` FROM memories m WHERE `+where+
			` ORDER BY random() LIMIT `+itoa(limit),
		b.args...,
	)
	if err != nil {
		return nil, fmt.Errorf("查询推荐失败: %w", err)
	}
	memories, err := collectMemories(rows)
	if err != nil {
		return nil, err
	}
	if len(memories) == 0 {
		return []*models.Memory{}, nil
	}
	return q.attachFiles(ctx, memories)
}

// PublicCounts 全站公开计数(public-counts 口径,无 home 门槛)。
func (q *MemoryQuery) PublicCounts(ctx context.Context) (total, photo int, err error) {
	b := &sqlBuilder{version: q.DerivativeVersion}
	where := publicWhere(b, ListOptions{})

	if err = q.Pool.QueryRow(ctx,
		`SELECT count(*) FROM memories m WHERE `+where, b.args...,
	).Scan(&total); err != nil {
		return 0, 0, fmt.Errorf("统计公开计数失败: %w", err)
	}
	photo, err = q.countByKind(ctx, where, argsOf(b), models.MemoryKindPhoto)
	if err != nil {
		return 0, 0, err
	}
	return total, photo, nil
}

// GetByID 主键查询并组装文件。找不到返回 (nil, nil)。
func (q *MemoryQuery) GetByID(ctx context.Context, id uuid.UUID) (*models.Memory, error) {
	row := q.Pool.QueryRow(ctx,
		`SELECT `+memoryColumnsBare+` FROM memories WHERE id = $1`, id)
	memory, err := scanMemory(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("查询 memory 失败: %w", err)
	}
	_, err = q.attachFiles(ctx, []*models.Memory{memory})
	return memory, err
}

// attachFiles 两查询组装文件列表(防 N+1),按文件 id 升序,
// 对齐 selectinload(Memory.files) 的 order_by(MemoryFile.id)。
func (q *MemoryQuery) attachFiles(ctx context.Context, memories []*models.Memory) ([]*models.Memory, error) {
	if len(memories) == 0 {
		return memories, nil
	}
	ids := make([]uuid.UUID, len(memories))
	for i, m := range memories {
		ids[i] = m.ID
	}
	rows, err := q.Pool.Query(ctx,
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
	for _, m := range memories {
		m.Files = byMemory[m.ID]
	}
	return memories, nil
}

// ---- 扫描助手:列序与 SELECT 清单严格配对 ----

func itoa(n int) string { return fmt.Sprintf("%d", n) }

func collectMemories(rows pgx.Rows) ([]*models.Memory, error) {
	defer rows.Close()
	var out []*models.Memory
	for rows.Next() {
		m, err := scanMemory(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历 memories 失败: %w", err)
	}
	if out == nil {
		out = []*models.Memory{}
	}
	return out, nil
}

type rowScanner interface{ Scan(dest ...any) error }

func scanMemory(row rowScanner) (*models.Memory, error) {
	m := &models.Memory{}
	if err := row.Scan(
		&m.ID, &m.Title, &m.Description, &m.Kind, &m.Status, &m.CapturedAt,
		&m.Location, &m.ThumbnailPath, &m.DurationSeconds, &m.Width, &m.Height,
		&m.CreatedAt, &m.UpdatedAt,
	); err != nil {
		return nil, fmt.Errorf("扫描 memory 失败: %w", err)
	}
	return m, nil
}

func collectMemoryFiles(rows pgx.Rows) ([]models.MemoryFile, error) {
	defer rows.Close()
	var out []models.MemoryFile
	for rows.Next() {
		f, err := scanMemoryFile(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历 memory files 失败: %w", err)
	}
	if out == nil {
		out = []models.MemoryFile{}
	}
	return out, nil
}

func scanMemoryFile(row rowScanner) (models.MemoryFile, error) {
	f := models.MemoryFile{}
	var createdAt, updatedAt time.Time
	err := row.Scan(
		&f.ID, &f.MemoryID, &f.Source, &f.RemotePath, &f.RemoteID, &f.SourcePath,
		&f.MimeType, &f.SizeBytes, &f.RemoteMD5, &f.ParentPath, &f.Filename, &f.Extension, &f.ModifiedAt,
		&f.RemoteState, &f.ThumbnailState, &f.ThumbnailFailureKind, &f.StreamState,
		&f.BrowserCompatibility, &f.BrowserCompatibilityVersion, &f.BrowserFormatSummary,
		&f.BrowserCompatibilityError, &f.BrowserCompatibilityCheckedAt,
		&f.RawMetadataSummary, &f.LastScanTaskID, &f.ContentHash, &f.Status,
		&f.LastSyncedAt, &f.SyncError, &createdAt, &updatedAt,
	)
	if err != nil {
		return f, fmt.Errorf("扫描 memory file 失败: %w", err)
	}
	f.CreatedAt = createdAt
	f.UpdatedAt = updatedAt
	return f, nil
}

func collectIDs(rows pgx.Rows) ([]uuid.UUID, error) {
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("扫描 id 失败: %w", err)
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历 ids 失败: %w", err)
	}
	if out == nil {
		out = []uuid.UUID{}
	}
	return out, nil
}
