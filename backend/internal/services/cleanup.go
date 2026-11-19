// cleanup.go 对齐原 admin.py 的 _collect_cleanup_stats/_remove_derived_media:
// 派生图与网关缓存的统计与清理。
package services

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/jackc/pgx/v5/pgxpool"
)

// CleanupCounts 数据库行计数(对齐 AdminCleanupStats 的 DB 字段)。
type CleanupCounts struct {
	Memories         int `json:"memories"`
	RemoteFileIndexes int `json:"remote_file_indexes"`
	ScanTasks        int `json:"scan_tasks"`
}

// CleanupCountsDB 统计 memories/文件索引/扫描任务行数。
func CleanupCountsDB(ctx context.Context, pool *pgxpool.Pool) CleanupCounts {
	var counts CleanupCounts
	_ = pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM memories),
		(SELECT count(*) FROM memory_files),
		(SELECT count(*) FROM remote_scan_tasks)`).Scan(
		&counts.Memories, &counts.RemoteFileIndexes, &counts.ScanTasks)
	return counts
}

// scanTreeFiles 统计目录树内文件数与字节(rglob 语义)。
func scanTreeFiles(root string) (int, int64) {
	files, bytes := 0, int64(0)
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || path == root {
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		files++
		if info, statErr := entry.Info(); statErr == nil {
			bytes += info.Size()
		}
		return nil
	})
	return files, bytes
}

// ScanDerivedMedia 统计派生图目录(thumbnails/tmp)的文件与字节。
func ScanDerivedMedia(mediaRoot string) (int, int64) {
	totalFiles, totalBytes := 0, int64(0)
	for _, name := range []string{"thumbnails", "tmp"} {
		files, bytes := scanTreeFiles(filepath.Join(mediaRoot, name))
		totalFiles += files
		totalBytes += bytes
	}
	return totalFiles, totalBytes
}

// RemoveDerivedMediaFiles 删除派生图目录内容,保留活跃临时文件;返回删除文件数。
func RemoveDerivedMediaFiles(mediaRoot string) int {
	removed := 0
	for _, name := range []string{"thumbnails", "tmp"} {
		directory := filepath.Join(mediaRoot, name)
		entries, err := os.ReadDir(directory)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			target := filepath.Join(directory, entry.Name())
			if entry.IsDir() {
				if !treeHasActiveTemporary(target) {
					removed += countTreeFiles(target)
					_ = os.RemoveAll(target)
				}
				continue
			}
			if IsTemporaryPathActive(target) {
				continue
			}
			_ = os.Remove(target)
			removed++
		}
	}
	return removed
}

func treeHasActiveTemporary(root string) bool {
	active := false
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if IsTemporaryPathActive(path) {
			active = true
			return fs.SkipAll
		}
		return nil
	})
	return active
}

func countTreeFiles(root string) int {
	files, _ := scanTreeFiles(root)
	return files
}
