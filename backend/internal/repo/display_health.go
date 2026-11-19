// Package repo 数据访问层。display_health.go 对齐原
// app/services/display_health.py:SQL 谓词与内存镜像必须保持同一口径。
package repo

import (
	"fmt"
	"sort"

	"limedia/backend/internal/models"
)

// PermanentThumbnailFailureKinds 永久缩略图失败种类:
// 这些失败不可恢复,公开口径与重试策略都据此排除。
var PermanentThumbnailFailureKinds = map[string]bool{
	"source_truncated":   true,
	"mov_moov":           true,
	"codec_unsupported":  true,
	"format_unsupported": true,
}

// ClassifyThumbnailFailureState 保持暂时性预览错误可见且可重试。
func ClassifyThumbnailFailureState(failureKind *string) models.RemoteThumbnailState {
	if failureKind != nil && PermanentThumbnailFailureKinds[*failureKind] {
		return models.RemoteThumbnailStateFailed
	}
	return models.RemoteThumbnailStateRetryable
}

// sqlBuilder 收集参数化占位符,保证 EXISTS 子查询与外层 WHERE 的
// $N 编号连续一致;version 供派生就绪谓词取当前派生版本。
type sqlBuilder struct {
	args    []any
	version string
}

func (b *sqlBuilder) placeholder(v any) string {
	b.args = append(b.args, v)
	return fmt.Sprintf("$%d", len(b.args))
}

// displayableFilesCondition 有可用公开表面的文件谓词(别名 m/f)。
// 对齐 displayable_files_condition()。
func (b *sqlBuilder) displayableFilesCondition() string {
	return `(` +
		`f.source = ` + b.placeholder("baidupan") +
		` AND f.remote_state = ` + b.placeholder(models.RemoteFileStateReady) +
		` AND (` +
		` (m.kind = ` + b.placeholder(models.MemoryKindPhoto) +
		` AND (f.thumbnail_state <> ` + b.placeholder(models.RemoteThumbnailStateFailed) +
		` OR m.thumbnail_path IS NOT NULL))` +
		` OR (m.kind = ` + b.placeholder(models.MemoryKindVideo) +
		` AND f.stream_state <> ` + b.placeholder(models.RemoteStreamStateFailed) + `)` +
		`))`
}

// browserPlayableFilesCondition 公开口径仅排除 unsupported 与 unknown 的视频。
func (b *sqlBuilder) browserPlayableFilesCondition() string {
	return `(` +
		`f.source = ` + b.placeholder("baidupan") +
		` AND (m.kind = ` + b.placeholder(models.MemoryKindPhoto) +
		` OR (m.kind = ` + b.placeholder(models.MemoryKindVideo) +
		` AND f.browser_compatibility = ` + b.placeholder(models.BrowserCompatibilityStateSupported) + `))` +
		`)`
}

// PublicFilesCondition 展示健康与浏览器兼容双双通过才可公开。
func (b *sqlBuilder) PublicFilesCondition() string {
	return `(` + b.displayableFilesCondition() + ` AND ` + b.browserPlayableFilesCondition() + `)`
}

// HomeDerivativeReadyCondition 首页尺寸派生图已持久化就绪。
// 公开可见性与预热统计共用的唯一口径:存在缓存 READY 行,
// 或 legacy thumbnail_path 以 /{version}/{max_size}.webp 结尾
// (后缀条件天然防 480/1280 污染;version 为受控配置值,无 LIKE 通配字符)。
func (b *sqlBuilder) HomeDerivativeReadyCondition(derivativeVersion string, maxSize int) string {
	return `(EXISTS (SELECT 1 FROM memory_derivative_caches d` +
		` WHERE d.memory_file_id = f.id` +
		` AND d.max_size = ` + b.placeholder(maxSize) +
		` AND d.derivative_version = ` + b.placeholder(derivativeVersion) +
		` AND d.status = ` + b.placeholder(models.DerivativeCacheStatusReady) + `)` +
		` OR (m.thumbnail_path IS NOT NULL` +
		` AND m.thumbnail_path LIKE ` + b.placeholder("%/" + derivativeVersion + fmt.Sprintf("/%d.webp", maxSize)) + `))`
}

// ---- 内存口径(逐条镜像 SQL 谓词,用于详情/序列化路径) ----

// FileDisplayOK 每文件镜像 displayableFilesCondition。
func FileDisplayOK(memory *models.Memory, f *models.MemoryFile) bool {
	if f.Source != "baidupan" {
		return false
	}
	if f.RemoteState != models.RemoteFileStateReady {
		return false
	}
	switch memory.Kind {
	case models.MemoryKindPhoto:
		return f.ThumbnailState != models.RemoteThumbnailStateFailed || memory.ThumbnailPath != nil
	case models.MemoryKindVideo:
		return f.StreamState != models.RemoteStreamStateFailed
	default:
		return false
	}
}

// FileBrowserOK 每文件镜像 browserPlayableFilesCondition。
func FileBrowserOK(memory *models.Memory, f *models.MemoryFile) bool {
	if memory.Kind != models.MemoryKindVideo {
		return true
	}
	return f.BrowserCompatibility == models.BrowserCompatibilityStateSupported
}

// iterPublicFiles 双门槛通过的文件,稳定按 id 升序。
// md5 去重会把多个文件挂到同一 memory;SQL 谓词用 any-file 语义,
// Python 侧分类与实际服务的文件必须同口径,Go 侧沿用此约定。
func iterPublicFiles(memory *models.Memory) []*models.MemoryFile {
	files := make([]*models.MemoryFile, 0, len(memory.Files))
	for i := range memory.Files {
		f := &memory.Files[i]
		if FileDisplayOK(memory, f) && FileBrowserOK(memory, f) {
			files = append(files, f)
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].ID.String() < files[j].ID.String() })
	return files
}

// PrimaryPublicFile 首个满足公开表面的文件,即实际对外服务的代表。
func PrimaryPublicFile(memory *models.Memory) *models.MemoryFile {
	files := iterPublicFiles(memory)
	if len(files) == 0 {
		return nil
	}
	return files[0]
}

// GetMediaDisplayState 单条 memory 的公开渲染/后台诊断分类。
func GetMediaDisplayState(memory *models.Memory) string {
	if memory.Kind != models.MemoryKindPhoto && memory.Kind != models.MemoryKindVideo {
		return "excluded"
	}
	for i := range memory.Files {
		if FileDisplayOK(memory, &memory.Files[i]) {
			return "displayable"
		}
	}
	return "excluded"
}

// GetPublicVisibilityState 最终公开表面分类;excluded 有意不透明。
func GetPublicVisibilityState(memory *models.Memory) string {
	if PrimaryPublicFile(memory) != nil {
		return "displayable"
	}
	return "excluded"
}
