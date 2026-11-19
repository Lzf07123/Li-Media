// cache_invalidation.go 对齐原 app/services/cache_invalidation.py:
// 可见性变更后的 nginx 代理缓存同步失效。
package services

import (
	"os"
	"path/filepath"

	"limedia/backend/internal/config"
)

// InvalidateNginxProxyCache 删除 nginx 代理缓存文件;返回删除的文件数。
// root 为空串时回退到注入配置的 nginx_cache_root
// (对齐 invalidate_nginx_proxy_cache(root=None))。
// 目录不存在返回 0;清理后重建目录,保持缓存根可用。
func InvalidateNginxProxyCache(settings *config.Settings, root string) int {
	cacheRoot := root
	if cacheRoot == "" {
		if settings == nil {
			return 0
		}
		cacheRoot = settings.NginxCacheRoot
	}
	info, err := os.Stat(cacheRoot)
	if err != nil || !info.IsDir() {
		return 0
	}

	removedFiles := 0
	_ = filepath.WalkDir(cacheRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil || path == cacheRoot {
			return nil
		}
		if entry.IsDir() {
			return nil // 递归:rglob 语义,子目录文件也计数
		}
		removedFiles++
		return nil
	})

	entries, readErr := os.ReadDir(cacheRoot)
	if readErr != nil {
		return removedFiles
	}
	for _, entry := range entries {
		target := filepath.Join(cacheRoot, entry.Name())
		if entry.IsDir() {
			_ = os.RemoveAll(target)
		} else {
			_ = os.Remove(target)
		}
	}
	_ = os.MkdirAll(cacheRoot, 0o755)
	return removedFiles
}
