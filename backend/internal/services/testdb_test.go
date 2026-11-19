package services

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"limedia/backend/internal/db"
	"limedia/backend/internal/models"
)

// servicesTestPool 对容器 Postgres 建独立测试库:迁移后使用,测试完即弃。
// 默认指向 limedia-dev 网络的基线容器,可用 GO_TEST_DATABASE_URL 覆盖。
// (与 repo 包的 testPool 同模式;包内独立维护避免导出测试助手。)
func servicesTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	base := os.Getenv("GO_TEST_DATABASE_URL")
	if base == "" {
		base = "postgres://media:media@limedia-baseline-db:5432/media"
	}

	adminURL := base
	testDB := "limedia_svc_test_" + uuid.NewString()[:8]
	conn, err := pgxpool.New(context.Background(), adminURL)
	if err != nil {
		t.Fatalf("连接测试宿主失败: %v", err)
	}
	defer conn.Close()
	if _, err := conn.Exec(context.Background(), "CREATE DATABASE "+testDB); err != nil {
		t.Fatalf("创建测试库失败: %v", err)
	}

	testURL, err := replaceDatabaseURL(base, testDB)
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
		_, _ = drop.Exec(context.Background(), "DROP DATABASE "+testDB+" WITH (FORCE)")
	})
	return pool
}

func replaceDatabaseURL(base, database string) (string, error) {
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	u.Path = "/" + database
	return u.String(), nil
}

// seedAdminMatrix 种入后台计数矩阵(列口径对齐 docs/contract-samples/
// seed-baseline.sql 与 repo 包测试种子):
// #1 photo 双文件 ready+派生;#2 photo 缩略图失败但 legacy path;
// #3 video supported+派生;#4 video unsupported+派生;
// #5 photo draft;#6 photo published remote unverified。
func seedAdminMatrix(t *testing.T, pool *pgxpool.Pool) {
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

var _ = models.MemoryKindPhoto // 保持 models 引用
