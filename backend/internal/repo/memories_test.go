package repo

import (
	"context"
	"fmt"
	"os"
	"testing"
	neturl "net/url"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"limedia/backend/internal/db"
	"limedia/backend/internal/models"
)

// testPool 对容器 Postgres 建独立测试库:迁移 + 种子,测试完即弃。
// 默认指向 limedia-dev 网络的基线容器,可用 GO_TEST_DATABASE_URL 覆盖。
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	base := os.Getenv("GO_TEST_DATABASE_URL")
	if base == "" {
		base = "postgres://media:media@limedia-baseline-db:5432/media"
	}

	adminURL := base
	testDB := "limedia_repo_test_" + uuid.NewString()[:8]
	conn, err := pgxpool.New(context.Background(), adminURL)
	if err != nil {
		t.Fatalf("连接测试宿主失败: %v", err)
	}
	defer conn.Close()
	if _, err := conn.Exec(context.Background(), `CREATE DATABASE `+testDB); err != nil {
		t.Fatalf("创建测试库失败: %v", err)
	}

	testURL, err := urlWithDatabase(base, testDB)
	if err != nil {
		t.Fatalf("构造测试库连接串失败: %v", err)
	}
	pool, err := pgxpool.New(context.Background(), testURL)
	if err != nil {
		t.Fatalf("连接测试库失败: %v", err)
	}
	if err := db.MigrateUp(testURL); err != nil {
		t.Fatalf("迁移测试库失败: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		drop, _ := pgxpool.New(context.Background(), adminURL)
		defer drop.Close()
		_, _ = drop.Exec(context.Background(), `DROP DATABASE `+testDB+` WITH (FORCE)`)
	})
	return pool
}

// urlWithDatabase 替换连接串中的库名,用于创建独立的测试库。
func urlWithDatabase(base, database string) (string, error) {
	u, err := neturl.Parse(base)
	if err != nil {
		return "", err
	}
	u.Path = "/" + database
	return u.String(), nil
}

// seedVisibilityMatrix 种入公开可见性矩阵(对齐 docs/contract-samples/seed-baseline.sql):
// #1 photo 双文件 ready+派生 → 公开;#2 photo 缩略图失败但 legacy path 兜底 → 公开;
// #3 video stream ready + browser supported + 派生 → 公开;
// #4 video browser unsupported → 列表排除(详情也 excluded);
// #5 draft → 排除;#6 remote unverified → 排除。
func seedVisibilityMatrix(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	const version = "20260906-ratio-v1"
	ctx := context.Background()

	stmts := []string{
		`INSERT INTO memories (id, title, description, kind, status, captured_at, location, thumbnail_path, width, height) VALUES
			('00000000-0000-4000-8000-000000000001','洱海日出','清晨的第一缕光','photo','published','2025-03-12T06:24:00+08:00','云南·大理',NULL,4032,3024),
			('00000000-0000-4000-8000-000000000002','巷口猫','抓拍的瞬间','photo','published','2025-04-02T15:10:00+08:00','上海·弄堂','photos/2025/04/cat.jpg',3024,4032),
			('00000000-0000-4000-8000-000000000003','海浪延时','傍晚的浪','video','published','2025-05-20T18:40:00+08:00','福建·霞浦',NULL,1920,1080),
			('00000000-0000-4000-8000-000000000004','旧编码片段','浏览器不支持的编码','video','published','2025-01-08T12:00:00+08:00',NULL,NULL,1280,720),
			('00000000-0000-4000-8000-000000000005','未整理草稿','','photo','draft','2025-06-01T09:00:00+08:00','浙江·杭州',NULL,4032,3024),
			('00000000-0000-4000-8000-000000000006','待核验文件','remote_state 未验证','photo','published','2025-07-10T11:00:00+08:00','四川·稻城',NULL,4032,3024)`,

		`INSERT INTO memory_files (id, memory_id, source, remote_path, remote_id, source_path, parent_path, filename, mime_type, remote_state, thumbnail_state, thumbnail_failure_kind, stream_state, browser_compatibility, status) VALUES
			('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','baidupan','/photos/erhai/sunrise.jpg','101','','/photos/erhai','sunrise.jpg','image/jpeg','ready','ready',NULL,'unavailable','unknown','matched'),
			('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','baidupan','/backup/sunrise_copy.jpg','102','','/backup','sunrise_copy.jpg','image/jpeg','ready','ready',NULL,'unavailable','unknown','matched'),
			('10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','baidupan','/photos/cat/alley_cat.jpg','103','','/photos/cat','alley_cat.jpg','image/jpeg','ready','failed','source_truncated','unavailable','unknown','matched'),
			('10000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','baidupan','/videos/waves/delay.mp4','104','','/videos/waves','delay.mp4','video/mp4','ready','ready',NULL,'ready','supported','matched'),
			('10000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000004','baidupan','/videos/legacy/old_clip.mov','105','','/videos/legacy','old_clip.mov','video/quicktime','ready','ready',NULL,'ready','unsupported','matched'),
			('10000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000005','baidupan','/photos/hz/draft.jpg','106','','/photos/hz','draft.jpg','image/jpeg','ready','ready',NULL,'unavailable','unknown','matched'),
			('10000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-000000000006','baidupan','/photos/dc/unchecked.jpg','107','','/photos/dc','unchecked.jpg','image/jpeg','unverified','missing',NULL,'unavailable','unknown','pending')`,

		// 首页 240px 派生:#1 #2 #3 就绪;#4 也就绪(但 browser 门槛先排除它)。
		// #2 的缩略图状态为 failed,靠派生缓存行通过 home 门槛进入列表。
		fmt.Sprintf(`INSERT INTO memory_derivative_caches (id, memory_file_id, max_size, derivative_version, status) VALUES
			('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',240,'%s','ready'),
			('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003',240,'%s','ready'),
			('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000004',240,'%s','ready')`, version, version, version),
	}
	for _, stmt := range stmts {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			t.Fatalf("种子导入失败: %v\n%s", err, stmt)
		}
	}
}

func newTestQuery(pool *pgxpool.Pool) *MemoryQuery {
	return &MemoryQuery{Pool: pool, DerivativeVersion: "20260906-ratio-v1"}
}

func TestListPublicVisibilityMatrix(t *testing.T) {
	pool := testPool(t)
	seedVisibilityMatrix(t, pool)
	q := newTestQuery(pool)

	result, err := q.ListPublic(context.Background(), ListOptions{
		Sort: "captured_desc", Page: 1, PageSize: 24, RequireHomeDerivative: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	// 预期可见:#1 #2 #3(240 派生或 legacy 兜底);#4 被 browser 门槛排除。
	got := make([]string, len(result.Items))
	for i, m := range result.Items {
		got[i] = m.Title
	}
	want := []string{"海浪延时", "巷口猫", "洱海日出"} // captured_desc
	if len(got) != len(want) {
		t.Fatalf("可见列表 = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("可见列表 = %v, want %v", got, want)
		}
	}
	if result.Total != 3 || result.PhotoCount != 2 || result.VideoCount != 1 {
		t.Fatalf("列表计数 = (%d,%d,%d), want (3,2,1)", result.Total, result.PhotoCount, result.VideoCount)
	}
	// public_counts 无 home derivative 门槛,同为 3 条。
	if result.PublicTotal != 3 || result.PublicPhotoCount != 2 {
		t.Fatalf("公开计数 = (%d,%d), want (3,2)", result.PublicTotal, result.PublicPhotoCount)
	}
}

func TestListPublicRandomSeedStable(t *testing.T) {
	pool := testPool(t)
	seedVisibilityMatrix(t, pool)
	q := newTestQuery(pool)
	ctx := context.Background()

	opts := ListOptions{Sort: "random", Seed: "abc123", Page: 1, PageSize: 24, RequireHomeDerivative: true}
	first, err := q.ListPublic(ctx, opts)
	if err != nil {
		t.Fatal(err)
	}
	second, err := q.ListPublic(ctx, opts)
	if err != nil {
		t.Fatal(err)
	}
	for i := range first.Items {
		if first.Items[i].ID != second.Items[i].ID {
			t.Fatalf("同 seed 两次请求顺序不一致: 第 %d 项 %s != %s", i, first.Items[i].ID, second.Items[i].ID)
		}
	}

	// 集合与列表口径一致。
	if len(first.Items) != 3 {
		t.Fatalf("随机页数量 = %d, want 3", len(first.Items))
	}
}

func TestGetByIDAssemblesFilesInOrder(t *testing.T) {
	pool := testPool(t)
	seedVisibilityMatrix(t, pool)
	q := newTestQuery(pool)

	id := uuid.MustParse("00000000-0000-4000-8000-000000000001")
	memory, err := q.GetByID(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if memory == nil {
		t.Fatal("memory #1 应存在")
	}
	if len(memory.Files) != 2 {
		t.Fatalf("文件数 = %d, want 2(md5 去重挂载的副本)", len(memory.Files))
	}
	if memory.Files[0].ID.String() >= memory.Files[1].ID.String() {
		t.Fatal("文件应按 id 升序(对齐 selectinload order_by)")
	}
	if GetMediaDisplayState(memory) != "displayable" || GetPublicVisibilityState(memory) != "displayable" {
		t.Fatal("memory #1 应为 displayable")
	}
}

func TestGetByIDMissingReturnsNil(t *testing.T) {
	pool := testPool(t)
	seedVisibilityMatrix(t, pool)
	q := newTestQuery(pool)

	memory, err := q.GetByID(context.Background(), uuid.MustParse("00000000-0000-4000-8000-999999999999"))
	if err != nil {
		t.Fatal(err)
	}
	if memory != nil {
		t.Fatal("不存在的 id 应返回 nil")
	}
}

func TestVisibilityMemoryMirror(t *testing.T) {
	// 内存口径与 SQL 口径一致性抽检:#4(browser unsupported video)在内存
	// 口径下 public excluded——详情/直链端点据此返回 404。
	pool := testPool(t)
	seedVisibilityMatrix(t, pool)
	q := newTestQuery(pool)

	legacy := uuid.MustParse("00000000-0000-4000-8000-000000000004")
	memory, err := q.GetByID(context.Background(), legacy)
	if err != nil {
		t.Fatal(err)
	}
	if GetPublicVisibilityState(memory) != "excluded" {
		t.Fatal("browser unsupported 的视频应 excluded")
	}
	if GetMediaDisplayState(memory) != "displayable" {
		t.Fatal("displayable 仅受展示健康约束,不含 browser 门槛")
	}
}

func TestEscapeLike(t *testing.T) {
	cases := map[string]string{
		`plain`:   `plain`,
		`50%off`:  `50\%off`,
		`a_b`:     `a\_b`,
		`back\slash`: `back\\slash`,
	}
	for in, want := range cases {
		if got := EscapeLike(in); got != want {
			t.Errorf("EscapeLike(%q) = %q, want %q", in, got, want)
		}
	}
}

var _ = models.MemoryKindPhoto // 保持 models 引用(谓词常量来源于此)
