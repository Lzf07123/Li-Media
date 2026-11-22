// remote_thumbnails.go 对齐原 app/services/remote_thumbnails.py:
// 不落源文件、直接从远程流生成派生缓存。
package services

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"limedia/backend/internal/config"
	"limedia/backend/internal/models"
)

// CreateRemoteThumbnail 下载源到临时文件后生成派生图,临时文件即时清理。
func CreateRemoteThumbnail(
	ctx context.Context,
	settings *config.Settings,
	client *BaiduPanClient,
	remoteID, mediaRoot string,
	memory *models.Memory,
	maxSize int,
	failureSink map[string]string,
) (*string, error) {
	temporaryDir := filepath.Join(mediaRoot, "tmp")
	if err := os.MkdirAll(temporaryDir, 0o755); err != nil {
		setFailureKind(failureSink, models.DerivativeFailureTemporaryIO)
		return nil, nil
	}
	temporaryPath := filepath.Join(temporaryDir,
		fmt.Sprintf("%s.%s.tmp", memory.ID, uuid.NewString()))

	var maxSourceBytes int64
	if memory.Kind == models.MemoryKindVideo {
		maxSourceBytes = settings.RemoteThumbnailVideoSourceMaxBytes
	} else {
		maxSourceBytes = settings.RemoteThumbnailSourceMaxBytes
	}

	recordFailure := func(kind models.DerivativeFailureKind) {
		if failureSink != nil {
			setFailureKind(failureSink, kind)
		}
	}

	streamDone := make(chan struct{})
	defer func() { <-streamDone }()

	statusCode, contentLength, _, _, body, err := client.OpenStream(ctx, remoteID, "")
	if err != nil {
		recordFailure(classifyRemoteError(err))
		close(streamDone)
		return nil, nil
	}
	if statusCode >= 400 {
		respBody := body
		closeAndDrain(respBody)
		close(streamDone)
		recordFailure(models.DerivativeFailureRemoteUnavail)
		return nil, nil
	}

	// 下载 + 清理由同一 goroutine 完成,保证 body 一定关闭。
	resultCh := make(chan *string, 1)
	go func() {
		defer close(streamDone)
		defer body.Close()
		defer func() {
			_ = os.Remove(temporaryPath)
			UnregisterTemporaryPath(absPath(temporaryPath))
		}()

		if !temporaryDirectoryHasCapacity(settings, temporaryDir) {
			recordFailure(models.DerivativeFailureDiskQuota)
			resultCh <- nil
			return
		}
		if contentLength != nil && *contentLength > maxSourceBytes {
			recordFailure(sourceLimitKind(memory.Kind))
			resultCh <- nil
			return
		}

		RegisterTemporaryPath(absPath(temporaryPath))
		file, openErr := os.Create(temporaryPath)
		if openErr != nil {
			recordFailure(models.DerivativeFailureTemporaryIO)
			resultCh <- nil
			return
		}
		defer file.Close()

		written := int64(0)
		buf := make([]byte, 64*1024)
		for {
			select {
			case <-ctx.Done():
				recordFailure(models.DerivativeFailureCancelled)
				resultCh <- nil
				return
			default:
			}
			n, readErr := body.Read(buf)
			if n > 0 {
				written += int64(n)
				if written >= maxSourceBytes {
					recordFailure(sourceLimitKind(memory.Kind))
					resultCh <- nil
					return
				}
				if _, writeErr := file.Write(buf[:n]); writeErr != nil {
					recordFailure(models.DerivativeFailureTemporaryIO)
					resultCh <- nil
					return
				}
			}
			if readErr == io.EOF {
				break
			}
			if readErr != nil {
				recordFailure(models.DerivativeFailureRemoteUnavail)
				resultCh <- nil
				return
			}
		}

		info, statErr := os.Stat(temporaryPath)
		if statErr != nil || info.Size() == 0 {
			recordFailure(models.DerivativeFailureTemporaryEmpty)
			resultCh <- nil
			return
		}

		resultCh <- CreateMemoryDerivative(temporaryPath, mediaRoot, memory.Kind,
			memory.ID, maxSize, failureSink, settings)
	}()

	return <-resultCh, nil
}

func sourceLimitKind(kind models.MemoryKind) models.DerivativeFailureKind {
	if kind == models.MemoryKindVideo {
		return models.DerivativeFailureMovMoov
	}
	return models.DerivativeFailureSourceTruncated
}

func closeAndDrain(closer io.ReadCloser) {
	_, _ = io.Copy(io.Discard, io.LimitReader(closer, 4096))
	_ = closer.Close()
}

func absPath(path string) string {
	if abs, err := filepath.Abs(path); err == nil {
		return abs
	}
	return path
}

// ClassifyRemoteError 保留(导出别名供测试/诊断使用)。
func ClassifyRemoteError(err error) models.DerivativeFailureKind {
	return classifyRemoteError(err)
}

func classifyRemoteError(err error) models.DerivativeFailureKind {
	message := err.Error()
	switch {
	case strings.Contains(message, "凭证无效") || strings.Contains(message, "凭证已过期"):
		return models.DerivativeFailureRemoteAuth
	case strings.Contains(message, "凭证"):
		return models.DerivativeFailureRemoteAuth
	case strings.Contains(message, "限流"):
		return models.DerivativeFailureBaiduRateLimited
	case strings.Contains(message, "不存在") || strings.Contains(message, "路径已变化") ||
		strings.Contains(message, "ID 无效"):
		return models.DerivativeFailureRemoteNotFound
	case strings.Contains(message, "不可用") || strings.Contains(message, "暂时无法读取"):
		return models.DerivativeFailureRemoteUnavail
	case strings.Contains(message, "403") || strings.Contains(message, "直链被拒绝"):
		return models.DerivativeFailureRemoteForbidden
	case strings.Contains(message, "context deadline exceeded") || strings.Contains(message, "超时"):
		return models.DerivativeFailureTimeout
	case isOSError(err):
		return models.DerivativeFailureTemporaryIO
	default:
		return models.DerivativeFailureUnknown
	}
}

// ---- 临时目录容量:字节用 3s TTL 缓存共享扫描,文件数实时 ----

var (
	usedBytesCacheMu    sync.Mutex
	usedBytesCache      = make(map[string]cacheUsedBytes)
	usedBytesCacheTTL   = 3 * time.Second
)

type cacheUsedBytes struct {
	at        time.Time
	usedBytes int64
}

func temporaryUsedBytes(temporaryDir string) int64 {
	key := temporaryDir
	now := time.Now()
	usedBytesCacheMu.Lock()
	if cached, ok := usedBytesCache[key]; ok && now.Sub(cached.at) < usedBytesCacheTTL {
		usedBytesCacheMu.Unlock()
		return cached.usedBytes
	}
	usedBytesCacheMu.Unlock()

	var used int64
	_ = filepath.Walk(temporaryDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info == nil || !info.Mode().IsRegular() {
			return nil
		}
		used += info.Size()
		return nil
	})

	usedBytesCacheMu.Lock()
	usedBytesCache[key] = cacheUsedBytes{at: now, usedBytes: used}
	usedBytesCacheMu.Unlock()
	return used
}

// TemporaryDirectoryHasCapacity 容量与文件数双重限额。
func TemporaryDirectoryHasCapacity(settings *config.Settings, temporaryDir string) bool {
	return temporaryDirectoryHasCapacity(settings, temporaryDir)
}

func temporaryDirectoryHasCapacity(settings *config.Settings, temporaryDir string) bool {
	// 文件数量是并发硬上限:保持实时计数,避免 TTL 窗口内超发。
	fileCount := 0
	_ = filepath.Walk(temporaryDir, func(path string, info os.FileInfo, err error) error {
		if err == nil && info != nil && info.Mode().IsRegular() {
			fileCount++
		}
		return nil
	})
	if fileCount >= settings.RemoteThumbnailMaxTempFiles {
		return false
	}
	return temporaryUsedBytes(temporaryDir) < settings.RemoteThumbnailDiskQuotaBytes
}

// CleanupStaleRemoteTemporaryFiles 启动前清理被杀死 worker 留下的孤儿临时文件。
func CleanupStaleRemoteTemporaryFiles(mediaRoot string) int {
	temporaryDir := filepath.Join(mediaRoot, "tmp")
	if _, err := os.Stat(temporaryDir); err != nil {
		return 0
	}
	removed := 0
	entries, _ := os.ReadDir(temporaryDir)
	for _, entry := range entries {
		path := filepath.Join(temporaryDir, entry.Name())
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".tmp") {
			continue
		}
		if !IsTemporaryPathActive(absPath(path)) {
			_ = os.Remove(path)
			removed++
		}
	}
	return removed
}
