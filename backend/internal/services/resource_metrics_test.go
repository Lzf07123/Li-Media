package services

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func writeFileForTest(dir, name, content string) error {
	return os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644)
}

func TestCollectResourceMetrics(t *testing.T) {
	dir := t.TempDir()
	// 派生缓存:2 个文件;tmp:1 个文件。
	if err := os.MkdirAll(filepath.Join(dir, "thumbnails", "m1"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "thumbnails", "m1", "240.webp"), []byte("1234"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "thumbnails", "m1", "480.webp"), []byte("123456"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "tmp"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "tmp", "probe.media"), []byte("12"), 0o644); err != nil {
		t.Fatal(err)
	}

	quota := int64(4 * 1024 * 1024 * 1024)
	maxFiles := 8
	metrics := CollectResourceMetrics(dir, nil, &quota, &maxFiles)

	if metrics.Caches.DerivedThumbnails.Files != 2 || metrics.Caches.DerivedThumbnails.Bytes != 10 {
		t.Fatalf("derived = %+v, want (2, 10)", metrics.Caches.DerivedThumbnails)
	}
	if metrics.Caches.Temporary.Files != 1 || metrics.Caches.Temporary.Bytes != 2 {
		t.Fatalf("temporary = %+v, want (1, 2)", metrics.Caches.Temporary)
	}

	if metrics.Temporary.Files != 1 || metrics.Temporary.Bytes != 2 {
		t.Fatalf("temporary 汇总 = %+v", metrics.Temporary)
	}
	if metrics.Temporary.FreeBytes == nil || metrics.Temporary.TotalBytes == nil ||
		metrics.Temporary.UsedBytes == nil {
		t.Fatalf("tmp 磁盘用量应可读: %+v", metrics.Temporary)
	}
	if metrics.Temporary.UsageRatio == nil || *metrics.Temporary.UsageRatio <= 0 || *metrics.Temporary.UsageRatio >= 1 {
		t.Fatalf("usage_ratio = %v", metrics.Temporary.UsageRatio)
	}

	// Filesystem 取 media_root(存在)。
	if metrics.Filesystem.TotalBytes == nil || *metrics.Filesystem.TotalBytes <= 0 {
		t.Fatalf("filesystem = %+v", metrics.Filesystem)
	}

	// 进程指标:getrusage 自取,RSS 应为正。
	if metrics.Process.RSSKBytes == nil || *metrics.Process.RSSKBytes <= 0 {
		t.Fatalf("rss = %v", metrics.Process.RSSKBytes)
	}
	if metrics.Process.Threads == nil || *metrics.Process.Threads <= 0 {
		t.Fatalf("threads = %v", metrics.Process.Threads)
	}

	// limits 注入。
	if metrics.Limits.TempDiskQuotaBytes == nil || *metrics.Limits.TempDiskQuotaBytes != quota {
		t.Fatalf("quota = %v", metrics.Limits.TempDiskQuotaBytes)
	}
	if metrics.Limits.TempMaxFiles == nil || *metrics.Limits.TempMaxFiles != maxFiles {
		t.Fatalf("max files = %v", metrics.Limits.TempMaxFiles)
	}
	if metrics.Limits.BackendMemoryBytes != nil {
		t.Fatal("未传 backend limit 应为 nil")
	}

	// 注册表计数与 GC 结构。
	if metrics.TemporaryRegistry.Paths != TemporaryRegistrySize() {
		t.Fatalf("registry = %d, want %d", metrics.TemporaryRegistry.Paths, TemporaryRegistrySize())
	}
	if metrics.GarbageCollection.Collections < 0 {
		t.Fatalf("gc collections = %d", metrics.GarbageCollection.Collections)
	}
}

func TestCollectResourceMetricsMissingRoot(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "does-not-exist")
	metrics := CollectResourceMetrics(dir, nil, nil, nil)

	// 缺失目录:缓存用量为 0 但状态 ok;filesystem 回退到 tmp 目录再回退父目录。
	if metrics.Caches.DerivedThumbnails.Files != 0 || metrics.Caches.DerivedThumbnails.Status != "ok" {
		t.Fatalf("缺失派生目录 = %+v", metrics.Caches.DerivedThumbnails)
	}
	if metrics.Filesystem.TotalBytes == nil || *metrics.Filesystem.TotalBytes <= 0 {
		t.Fatalf("filesystem 应回退到可见文件系统: %+v", metrics.Filesystem)
	}
}

func TestCollectResourceMetricsTruncated(t *testing.T) {
	dir := t.TempDir()
	nested := filepath.Join(dir, "thumbnails", "big")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 60_000; i++ {
		if err := os.WriteFile(filepath.Join(nested, fmt.Sprintf("%d.bin", i)), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	metrics := CollectResourceMetrics(dir, nil, nil, nil)
	if metrics.Caches.DerivedThumbnails.Status != "truncated" {
		t.Fatalf("超 50000 文件应 truncated: %+v", metrics.Caches.DerivedThumbnails)
	}
}
