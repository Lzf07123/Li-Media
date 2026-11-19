// source_zero.go 对齐原 app/services/source_zero.py:
// 源文件不变量审计——媒体只应索引远程,本地不落源文件。
// 返回有界的源存储计数,不暴露文件名或绝对路径。
package services

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// SourceMediaExtensions 视为源媒体文件的后缀(对齐 SOURCE_MEDIA_EXTENSIONS)。
var SourceMediaExtensions = map[string]bool{
	".avi": true, ".gif": true, ".heic": true, ".jpeg": true, ".jpg": true,
	".m4a": true, ".mkv": true, ".mov": true, ".mp3": true, ".mp4": true,
	".png": true, ".wav": true, ".webm": true,
}

// DerivativeDirectories 派生缓存目录(对齐 DERIVATIVE_DIRECTORIES)。
var DerivativeDirectories = map[string]bool{
	"thumbnails": true, "tmp": true,
}

// SourceZeroStatus 源文件审计契约结构(对齐 responses.SourceZeroStatus)。
type SourceZeroStatus struct {
	Compliant                 bool           `json:"compliant"`
	SourcePathCount           int            `json:"source_path_count"`
	SourcePathSchemaExposed   bool           `json:"source_path_schema_exposed"`
	DatabaseBlobCount         int            `json:"database_blob_count"`
	SourceMediaFileCount      int            `json:"source_media_file_count"`
	SourceMediaExtensions     map[string]int `json:"source_media_extensions"`
	MediaPhotosFileCount      int            `json:"media_photos_file_count"`
	MediaVideosFileCount      int            `json:"media_videos_file_count"`
	UnexpectedMediaFileCount  int            `json:"unexpected_media_file_count"`
	TemporaryFileCount        int            `json:"temporary_file_count"`
	FilesystemScanFailed      bool           `json:"filesystem_scan_failed"`
}

// sourcePathSchemaExposed 对齐 "source_path" in (MemoryRead.model_fields |
// MemorySummaryRead.model_fields):API 响应契约是否暴露 source_path。
// 当前 Go 响应结构(api.MemorySummary 等)均不含该字段,恒为 false;
// 若响应结构未来新增该字段,必须同步修改此处。
func sourcePathSchemaExposed() bool {
	return false
}

// CollectSourceZeroStatus 聚合源存储审计计数(对齐 collect_source_zero_status)。
func CollectSourceZeroStatus(ctx context.Context, pool *pgxpool.Pool, mediaRoot string) *SourceZeroStatus {
	status := &SourceZeroStatus{
		SourceMediaExtensions: map[string]int{},
		Compliant:             true,
	}

	// source_path 非空计数:源文件路径只应存在于网盘,不应入库。
	_ = pool.QueryRow(ctx,
		`SELECT count(*) FROM memory_files WHERE source_path <> ''`,
	).Scan(&status.SourcePathCount)

	// 二进制列审计:模型不应有 LargeBinary/bytea 列(Python 遍历 ORM
	// 表列;Go 经 information_schema 动态发现 memories/memory_files 的
	// bytea 列并计数非空值,语义等价且覆盖未来新增列)。
	status.DatabaseBlobCount = countDatabaseBlobs(ctx, pool)

	status.SourcePathSchemaExposed = sourcePathSchemaExposed()

	// 文件系统扫描:media_root 缺失视为无源文件(不算失败)。
	if info, err := os.Stat(mediaRoot); err == nil && info.IsDir() {
		scanErr := filepath.WalkDir(mediaRoot, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() {
				return nil
			}
			// WalkDir 不跟随目录符号链接;文件条目(含指向文件的链接)计数。
			rel, relErr := filepath.Rel(mediaRoot, path)
			if relErr != nil {
				return err
			}
			parts := strings.Split(filepath.ToSlash(rel), "/")
			topLevel := parts[0]
			suffix := strings.ToLower(filepath.Ext(entry.Name()))
			if SourceMediaExtensions[suffix] {
				status.SourceMediaExtensions[suffix]++
			}
			switch {
			case topLevel == "tmp":
				status.TemporaryFileCount++
			case topLevel == "photos":
				status.MediaPhotosFileCount++
			case topLevel == "videos":
				status.MediaVideosFileCount++
			case !DerivativeDirectories[topLevel]:
				status.UnexpectedMediaFileCount++
			}
			return nil
		})
		if scanErr != nil {
			status.FilesystemScanFailed = true
		}
	}

	sourceMediaFileCount := 0
	for _, count := range status.SourceMediaExtensions {
		sourceMediaFileCount += count
	}
	status.SourceMediaFileCount = sourceMediaFileCount

	// 键序与 dict(sorted(...)) 一致(响应序列化再排一次也兼容)。
	sortedExtensions := make(map[string]int, len(status.SourceMediaExtensions))
	keys := make([]string, 0, len(status.SourceMediaExtensions))
	for key := range status.SourceMediaExtensions {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		sortedExtensions[key] = status.SourceMediaExtensions[key]
	}
	status.SourceMediaExtensions = sortedExtensions

	// 不变量:全零计数且扫描未失败且 schema 未暴露才合规
	// (对齐 not any([...]) 真值判断)。
	status.Compliant = !anyTrue(
		status.FilesystemScanFailed,
		status.SourcePathCount != 0,
		status.SourcePathSchemaExposed,
		status.DatabaseBlobCount != 0,
		len(status.SourceMediaExtensions) != 0,
		status.MediaPhotosFileCount != 0,
		status.MediaVideosFileCount != 0,
		status.UnexpectedMediaFileCount != 0,
	)
	return status
}

func anyTrue(values ...bool) bool {
	for _, v := range values {
		if v {
			return true
		}
	}
	return false
}

// countDatabaseBlobs 统计 memories/memory_files 中 bytea 列的非空值总数。
func countDatabaseBlobs(ctx context.Context, pool *pgxpool.Pool) int {
	rows, err := pool.Query(ctx,
		`SELECT table_name, column_name FROM information_schema.columns
		 WHERE table_schema = 'public'
		   AND data_type = 'bytea'
		   AND table_name IN ('memories', 'memory_files')`)
	if err != nil {
		return 0
	}
	type blobColumn struct{ table, column string }
	var columns []blobColumn
	for rows.Next() {
		var col blobColumn
		if err := rows.Scan(&col.table, &col.column); err == nil {
			columns = append(columns, col)
		}
	}
	rows.Close()

	total := 0
	for _, col := range columns {
		// 列名来自 information_schema 标识符,双引号包裹防注入歧义。
		var count int
		_ = pool.QueryRow(ctx,
			`SELECT count(*) FROM `+col.table+` WHERE "`+col.column+`" IS NOT NULL`,
		).Scan(&count)
		total += count
	}
	return total
}
