package services

import (
	"os"
	"path/filepath"
	"testing"

	"limedia/backend/internal/config"
)

func TestInvalidateNginxProxyCache(t *testing.T) {
	root := filepath.Join(t.TempDir(), "nginx_cache")
	if err := os.MkdirAll(filepath.Join(root, "levels", "a"), 0o755); err != nil {
		t.Fatal(err)
	}
	files := []string{
		filepath.Join(root, "top.cache"),
		filepath.Join(root, "levels", "a", "deep.cache"),
	}
	for _, path := range files {
		if err := os.WriteFile(path, []byte("cache"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	settings := &config.Settings{NginxCacheRoot: root}
	removed := InvalidateNginxProxyCache(settings, "")
	if removed != 2 {
		t.Fatalf("删除数 = %d, want 2", removed)
	}

	// 清理后目录重建为空。
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("缓存根应为空: %d 项", len(entries))
	}
}

func TestInvalidateNginxProxyCacheExplicitRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "explicit_cache")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "one.cache"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	// settings 指向不存在的目录,显式 root 覆盖。
	settings := &config.Settings{NginxCacheRoot: "/nonexistent"}
	if removed := InvalidateNginxProxyCache(settings, root); removed != 1 {
		t.Fatalf("显式 root 删除数 = %d, want 1", removed)
	}
}

func TestInvalidateNginxProxyCacheMissingRoot(t *testing.T) {
	settings := &config.Settings{NginxCacheRoot: "/nonexistent-nginx-cache-root"}
	if removed := InvalidateNginxProxyCache(settings, ""); removed != 0 {
		t.Fatalf("缺失目录应返回 0, got %d", removed)
	}
}
