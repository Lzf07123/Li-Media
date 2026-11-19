package services

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestCollectSourceZeroStatusCompliant(t *testing.T) {
	pool := servicesTestPool(t)
	seedAdminMatrix(t, pool)
	mediaRoot := t.TempDir() // 空目录:无源文件

	status := CollectSourceZeroStatus(context.Background(), pool, mediaRoot)
	if !status.Compliant {
		t.Fatalf("空 media_root 应合规: %+v", status)
	}
	if status.SourcePathCount != 0 || status.DatabaseBlobCount != 0 {
		t.Fatalf("计数 = (source_path=%d, blob=%d)", status.SourcePathCount, status.DatabaseBlobCount)
	}
	if status.SourcePathSchemaExposed {
		t.Fatal("当前响应结构不应暴露 source_path")
	}
	if status.SourceMediaFileCount != 0 || len(status.SourceMediaExtensions) != 0 {
		t.Fatalf("媒体计数 = (%d, %v)", status.SourceMediaFileCount, status.SourceMediaExtensions)
	}
}

func TestCollectSourceZeroStatusDetectsSources(t *testing.T) {
	pool := servicesTestPool(t)
	seedAdminMatrix(t, pool)
	mediaRoot := t.TempDir()

	// 派生目录文件:合规。
	if err := os.MkdirAll(filepath.Join(mediaRoot, "thumbnails", "m1"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mediaRoot, "thumbnails", "m1", "240.webp"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(mediaRoot, "tmp"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mediaRoot, "tmp", "chunk.part"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	// 违规:photos/videos 目录、未归类目录与源媒体后缀。
	if err := os.MkdirAll(filepath.Join(mediaRoot, "photos"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mediaRoot, "photos", "src.jpg"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(mediaRoot, "videos"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mediaRoot, "videos", "clip.MP4"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(mediaRoot, "stray"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mediaRoot, "stray", "old.png"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mediaRoot, "loose.mov"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	status := CollectSourceZeroStatus(context.Background(), pool, mediaRoot)
	if status.Compliant {
		t.Fatalf("存在源文件应不合规: %+v", status)
	}
	if status.MediaPhotosFileCount != 1 || status.MediaVideosFileCount != 1 {
		t.Fatalf("photos/videos 计数 = (%d, %d)", status.MediaPhotosFileCount, status.MediaVideosFileCount)
	}
	if status.TemporaryFileCount != 1 {
		t.Fatalf("tmp 计数 = %d", status.TemporaryFileCount)
	}
	if status.UnexpectedMediaFileCount != 2 {
		t.Fatalf("未归类计数 = %d(stray/old.png + loose.mov)", status.UnexpectedMediaFileCount)
	}
	if status.SourceMediaFileCount != 4 {
		t.Fatalf("源媒体计数 = %d(jpg/mp4/png/mov)", status.SourceMediaFileCount)
	}
	if status.SourceMediaExtensions[".mp4"] != 1 || status.SourceMediaExtensions[".jpg"] != 1 {
		t.Fatalf("后缀分布 = %v(.MP4 应小写归并)", status.SourceMediaExtensions)
	}
}

func TestCollectSourceZeroStatusSourcePathIndexed(t *testing.T) {
	pool := servicesTestPool(t)
	seedAdminMatrix(t, pool)
	ctx := context.Background()

	// source_path 非空即违规。
	if _, err := pool.Exec(ctx,
		`UPDATE memory_files SET source_path = '/local/cache/sunrise.jpg'
		 WHERE remote_id = '101'`); err != nil {
		t.Fatal(err)
	}
	status := CollectSourceZeroStatus(ctx, pool, t.TempDir())
	if status.SourcePathCount != 1 {
		t.Fatalf("source_path 计数 = %d, want 1", status.SourcePathCount)
	}
	if status.Compliant {
		t.Fatal("source_path 入库应不合规")
	}
}

func TestCollectSourceZeroStatusMissingRoot(t *testing.T) {
	pool := servicesTestPool(t)
	seedAdminMatrix(t, pool)
	// media_root 不存在:不算扫描失败,仍合规(Python exists() 分支)。
	status := CollectSourceZeroStatus(context.Background(), pool,
		filepath.Join(t.TempDir(), "absent"))
	if status.Compliant != true || status.FilesystemScanFailed {
		t.Fatalf("缺失 root = %+v", status)
	}
}
