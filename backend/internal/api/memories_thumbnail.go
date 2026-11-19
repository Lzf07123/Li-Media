package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"

	"github.com/google/uuid"

	"limedia/backend/internal/models"
	"limedia/backend/internal/repo"
	"limedia/backend/internal/services"
)

type ioReader interface {
	Read(p []byte) (int, error)
}

// PreheatStatus 公开预热状态占位:thumbnail_preheat 服务接入后
// 替换为真实聚合(Cache-Control: no-store 是契约)。
func (h *MemoriesHandler) PreheatStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	ErrorDetail(w, http.StatusNotFound, "preheat status unavailable")
}

// Thumbnail 派生图服务:缓存直出 / 本地派生 / 远程派生(对齐 get_memory_thumbnail)。
func (h *MemoriesHandler) Thumbnail(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		ErrorDetail(w, http.StatusNotFound, "memory not found")
		return
	}
	size := r.URL.Query().Get("size")
	if size == "" {
		size = "480"
	}
	if !sizePattern.MatchString(size) {
		h.validationError(w, "size", "Input should be 240, 480, 768 or 1280", size)
		return
	}
	maxSize, _ := strconv.Atoi(size)

	memory, memoryFile, ok := h.publicVisibilityCheck(r.Context(), w, id)
	if !ok {
		return
	}
	if memory.ThumbnailPath == nil &&
		(memoryFile == nil || memoryFile.RemoteID == nil ||
			memoryFile.ThumbnailState == models.RemoteThumbnailStateMissing) {
		ErrorDetail(w, http.StatusNotFound, "memory thumbnail missing")
		return
	}

	settings := h.Settings
	etag := `"` + id.String() + `-` + settings.MediaDerivativeVersion + `-` + size + `"`
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	targetPath := services.DerivativeCachePath(settings.MediaRoot, id, maxSize, settings.MediaDerivativeVersion)
	if info, statErr := os.Stat(targetPath); statErr == nil && info.Mode().IsRegular() {
		h.fillDimensionsIfMissing(memory, targetPath)
		h.serveWebp(w, r, targetPath, info.Size())
		return
	}

	// 本地源文件 → 本地派生。
	if memoryFile != nil {
		if localSource := services.ResolveMediaPath(settings.MediaRoot, memoryFile.SourcePath); localSource != nil {
			if _, statErr := os.Stat(*localSource); statErr == nil {
				generated, taskErr := h.Derivatives.RunLocalDerivative(
					r.Context(), *localSource, settings.MediaRoot, memory, maxSize, nil, nil)
				if taskErr != nil {
					taskHTTPError(w, taskErr)
					return
				}
				if generated != nil {
					h.markThumbnailReady(memory, memoryFile, *generated)
					h.fillDimensionsIfMissing(memory, targetPath)
					h.serveWebp(w, r, targetPath, -1)
					return
				}
			}
		}
	}

	if memoryFile == nil || memoryFile.RemoteID == nil {
		ErrorDetail(w, http.StatusNotFound, "memory thumbnail missing")
		return
	}

	// 远程派生:临时下载源 + ffmpeg。
	client, clientErr := h.Baidu.New()
	if clientErr != nil {
		ErrorDetail(w, http.StatusBadGateway, clientErr.Error())
		return
	}
	failureSink := map[string]string{}
	generated, taskErr := h.Derivatives.RunRemoteDerivative(
		r.Context(), client, deref(memoryFile.RemoteID), settings.MediaRoot,
		memory, maxSize, nil, failureSink)
	if taskErr != nil {
		var baiduErr *services.BaiduPanError
		if errors.As(taskErr, &baiduErr) {
			generated = nil // BaiduPanError 语义上等于派生失败
		} else {
			taskHTTPError(w, taskErr)
			return
		}
	}

	if generated != nil {
		h.markThumbnailReady(memory, memoryFile, *generated)
		h.fillDimensionsIfMissing(memory, targetPath)
		h.serveWebp(w, r, targetPath, -1)
		return
	}

	// 失败:记录种类并按永久/暂时分类;无方形兜底(契约)。
	kind := failureSink["kind"]
	if kind == "" {
		kind = "unknown"
	}
	h.updateThumbnailFailure(memoryFile.ID, kind)
	h.Governor.Metrics.RecordFailed(services.TaskTypeDerivative)
	detail := "服务端派生失败，未回退到方形缩略图；failure_kind=" + kind
	_ = services.RecordAdminOperation(h.Pool, "thumbnail_derivation_failed",
		strPtr("memory"), strPtr(memory.ID.String()), nil, &detail)
	ErrorDetail(w, http.StatusBadGateway, "远程媒体派生暂时无法加载")
}

func (h *MemoriesHandler) serveWebp(w http.ResponseWriter, r *http.Request, path string, size int64) {
	w.Header().Set("Content-Type", guessImageMime(path))
	if size >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	}
	w.WriteHeader(http.StatusOK)
	body, err := os.Open(path)
	if err != nil {
		return
	}
	defer body.Close()
	_, _ = io.Copy(w, body)
}

func r2Ctx() context.Context { return context.Background() }

var _ = os.Stat // os 保留位

func (h *MemoriesHandler) markThumbnailReady(memory *models.Memory, file *models.MemoryFile, relative string) {
	memory.ThumbnailPath = &relative
	file.ThumbnailState = models.RemoteThumbnailStateReady
	file.ThumbnailFailureKind = nil
	_, _ = h.Pool.Exec(context.Background(),
		`UPDATE memories SET thumbnail_path = $1, updated_at = now() WHERE id = $2`,
		relative, memory.ID)
	_, _ = h.Pool.Exec(context.Background(),
		`UPDATE memory_files SET thumbnail_state = $1, thumbnail_failure_kind = NULL, updated_at = now() WHERE id = $2`,
		models.RemoteThumbnailStateReady, file.ID)
}

func (h *MemoriesHandler) updateThumbnailFailure(fileID uuid.UUID, kind string) {
	state := repo.ClassifyThumbnailFailureState(&kind)
	_, _ = h.Pool.Exec(context.Background(),
		`UPDATE memory_files SET thumbnail_state = $1, thumbnail_failure_kind = $2, updated_at = now() WHERE id = $3`,
		state, kind, fileID)
}

func (h *MemoriesHandler) fillDimensionsIfMissing(memory *models.Memory, derivativePath string) {
	if memory.Width != nil && memory.Height != nil {
		return
	}
	content, err := os.ReadFile(derivativePath)
	if err != nil {
		return
	}
	width, height := services.ReadImageDimensions(content)
	if width == nil || height == nil {
		return
	}
	memory.Width, memory.Height = width, height
	_, _ = h.Pool.Exec(context.Background(),
		`UPDATE memories SET width = $1, height = $2, updated_at = now() WHERE id = $3`,
		*width, *height, memory.ID)
}
