package repo

import (
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"context"
	"testing"

	"limedia/backend/internal/models"
)

func TestCollectAdminCounts(t *testing.T) {
	pool := testPool(t)
	seedAdminMatrix(t, pool)

	counts, err := CollectAdminCounts(context.Background(), pool, AdminMemoryFilter{})
	if err != nil {
		t.Fatal(err)
	}

	// 6 条 memory 全部挂 baidupan 文件:total=6,photo=4,video=2。
	if counts.Total != 6 || counts.Counts.Photo != 4 || counts.Counts.Video != 2 {
		t.Fatalf("total/counts = (%d, %+v), want (6, {4 2})", counts.Total, counts.Counts)
	}
	// published 5 条(#5 为 draft)。
	if counts.StatusCounts.Published != 5 || counts.StatusCounts.Unpublished != 1 {
		t.Fatalf("status_counts = %+v, want {5 1}", counts.StatusCounts)
	}
	// 展示口径不看 status:#6 remote unverified 被排除,其余 5 条 displayable
	// (含 draft #5 与缩略图失败但有 legacy path 的 #2)。
	if counts.DisplayCounts.Displayable != 5 || counts.DisplayCounts.Excluded != 1 {
		t.Fatalf("display_counts = %+v, want {5 1}", counts.DisplayCounts)
	}
	// 浏览口径:video #3 supported、#4 unsupported,unknown=0。
	if counts.BrowserCounts.Supported != 1 || counts.BrowserCounts.Unsupported != 1 || counts.BrowserCounts.Unknown != 0 {
		t.Fatalf("browser_counts = %+v, want {1 1 0}", counts.BrowserCounts)
	}
}

func TestAdminFilterDisplayExcluded(t *testing.T) {
	pool := testPool(t)
	seedAdminMatrix(t, pool)
	ctx := context.Background()

	excluded := AdminMemoryFilter{Display: "excluded"}
	count, err := CountAdminMemories(ctx, pool, excluded)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("excluded 计数 = %d, want 1(#6)", count)
	}

	displayable := AdminMemoryFilter{Display: "displayable"}
	count, err = CountAdminMemories(ctx, pool, displayable)
	if err != nil {
		t.Fatal(err)
	}
	if count != 5 {
		t.Fatalf("displayable 计数 = %d, want 5", count)
	}
}

func TestAdminFilterKeyword(t *testing.T) {
	pool := testPool(t)
	seedAdminMatrix(t, pool)
	ctx := context.Background()

	// 中文关键字命中 title。
	count, err := CountAdminMemories(ctx, pool, AdminMemoryFilter{Keyword: "海浪"})
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("关键字计数 = %d, want 1", count)
	}

	// LIKE 通配符按字面量匹配。
	count, err = CountAdminMemories(ctx, pool, AdminMemoryFilter{Keyword: "%"})
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("%% 通配符应被转义, got %d", count)
	}
}

func TestAdminFilterKindStatusCompatibility(t *testing.T) {
	pool := testPool(t)
	seedAdminMatrix(t, pool)
	ctx := context.Background()

	video := models.MemoryKindVideo
	unsupported := AdminMemoryFilter{Kind: &video, Compatibility: "unsupported"}
	count, err := CountAdminMemories(ctx, pool, unsupported)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("video+unsupported 计数 = %d, want 1(#4)", count)
	}

	unknown := AdminMemoryFilter{Kind: &video, Compatibility: "unknown"}
	count, err = CountAdminMemories(ctx, pool, unknown)
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("video+unknown 计数 = %d, want 0", count)
	}

	draft := models.MemoryStatusDraft
	statusFilter := AdminMemoryFilter{Status: &draft}
	count, err = CountAdminMemories(ctx, pool, statusFilter)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("draft 计数 = %d, want 1", count)
	}
}

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
