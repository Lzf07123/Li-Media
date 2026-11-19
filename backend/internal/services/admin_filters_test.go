package services

import (
	"context"
	"testing"

	"limedia/backend/internal/models"
)

func TestCollectAdminCounts(t *testing.T) {
	pool := servicesTestPool(t)
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
	pool := servicesTestPool(t)
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
	pool := servicesTestPool(t)
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
	pool := servicesTestPool(t)
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
