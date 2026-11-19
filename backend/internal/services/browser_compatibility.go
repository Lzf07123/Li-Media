// browser_compatibility.go 对齐原 app/services/browser_compatibility.py:
// 已索引视频的保守浏览器播放兼容判定与有界远程探测。
//
// 集合常量、_first_text 与 _classify_format 的判定逻辑在 baidu_sync.go
// 已实现(apply_persisted_compatibility 半边),此处直接复用,避免重复定义;
// 本文件补齐该模块的探测半边(evaluate/probe/持久化)。
package services

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"limedia/backend/internal/config"
	"limedia/backend/internal/models"
)

var (
	browserContainerKeys = [...]string{"container", "format_name", "container_name"}
	browserVideoKeys     = [...]string{"video_codec", "vcodec", "codec_name"}
	browserAudioKeys     = [...]string{"audio_codec", "acodec", "audio_codec_name"}
	browserProfileKeys   = [...]string{"video_profile", "profile"}
)

// BrowserProbeClient 兼容探测的流客户端协议(对齐 BrowserProbeClient
// Protocol);*BaiduPanClient 天然满足该接口,测试可注入假实现。
type BrowserProbeClient interface {
	OpenStream(ctx context.Context, remoteID, rangeHeader string) (int, *int64, string, string, io.ReadCloser, error)
}

// classifyFormat 保守判定:证据不足保持 unknown
// (对齐 _classify_format;与 baidu_sync.go 共用判定顺序)。
func classifyFormat(summary map[string]any) models.BrowserCompatibilityState {
	container := browserFirstText(summary, browserContainerKeys[:]...)
	videoCodec := browserFirstText(summary, browserVideoKeys[:]...)
	audioCodec := browserFirstText(summary, browserAudioKeys[:]...)
	return classifyBrowserFormat(container, videoCodec, audioCodec)
}

// EvaluateMemoryFile 只依据持久化证据分类;证据缺失保持 unknown
// (对齐 evaluate_memory_file)。
func EvaluateMemoryFile(memoryFile *models.MemoryFile) (models.BrowserCompatibilityState, map[string]any, error) {
	state, summary := evaluateMemoryFileCompatibility(
		jsonMap(memoryFile.RawMetadataSummary),
		jsonMap(memoryFile.BrowserFormatSummary),
		memoryFile.Extension)
	return state, summary, nil
}

// marshalJSONValue 序列化摘要为 json 列载荷;nil 写空对象。
func marshalJSONValue(summary map[string]any) json.RawMessage {
	if summary == nil {
		summary = map[string]any{}
	}
	encoded, err := json.Marshal(summary)
	if err != nil {
		return json.RawMessage("{}")
	}
	return encoded
}

// extractFFProbeSummary 从 ffprobe 输出提取判定证据
// (对齐 _extract_ffprobe_summary)。
func extractFFProbeSummary(payload map[string]any) map[string]any {
	firstStream := func(codecType string) map[string]any {
		streams, ok := payload["streams"].([]any)
		if !ok {
			return nil
		}
		for _, raw := range streams {
			stream, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if v, _ := stream["codec_type"].(string); v == codecType {
				return stream
			}
		}
		return nil
	}
	videoStream := firstStream("video")
	audioStream := firstStream("audio")
	formatInfo, _ := payload["format"].(map[string]any)

	text := func(source map[string]any, key string) string {
		if source == nil {
			return ""
		}
		value, ok := source[key]
		if !ok || value == nil {
			return ""
		}
		trimmed := strings.ToLower(strings.TrimSpace(fmt.Sprintf("%v", value)))
		return trimmed
	}

	summary := map[string]any{}
	if container := text(formatInfo, "format_name"); container != "" {
		if idx := strings.Index(container, ","); idx >= 0 {
			container = container[:idx]
		}
		summary["container"] = container
	}
	if v := text(videoStream, "codec_name"); v != "" {
		summary["video_codec"] = v
	}
	if v := text(audioStream, "codec_name"); v != "" {
		summary["audio_codec"] = v
	}
	if v := text(videoStream, "profile"); v != "" {
		summary["video_profile"] = v
	}
	return summary
}

// ---- 有界远程探测 ----

// BrowserProbeDeps 探测依赖注入:配置、任务总督(含指标)与数据库连接池。
type BrowserProbeDeps struct {
	Settings *config.Settings
	Governor *TaskGovernor
	Pool     *pgxpool.Pool
}

// ProbeMemoryFileCompatibility 读取有界的远程前缀供 ffprobe 判定;
// 绝不完整下载或转码(对齐 probe_memory_file_compatibility)。
//
// 错误语义逐条对齐 Python:
//   - OSError/SubprocessError/JSONDecodeError 一类失败:文案取
//     err.Error(),状态置 unknown,指标计 failed,不上抛(调用方按
//     unknown 结果计 skipped);
//   - 其余失败(流读取等):统一文案 "远程兼容探测失败",计 failed
//     并上抛(批量任务计 failed);
//   - 槽位获取失败(TaskRejected):不进探测、不落库,直接上抛。
func ProbeMemoryFileCompatibility(
	ctx context.Context,
	deps *BrowserProbeDeps,
	client BrowserProbeClient,
	memoryFile *models.MemoryFile,
	mediaRoot string,
) error {
	settings := deps.Settings
	_ = os.MkdirAll(mediaRoot, 0o755)
	_ = os.MkdirAll(filepath.Join(mediaRoot, "tmp"), 0o755)

	slot, release, slotErr := deps.Governor.Slot(ctx, TaskTypeDirectProbe, 50, nil)
	if slotErr != nil {
		return slotErr
	}
	_ = slot

	remoteID := ""
	if memoryFile.RemoteID != nil {
		remoteID = *memoryFile.RemoteID
	}

	markUnknown := func(errText string) {
		memoryFile.BrowserCompatibility = models.BrowserCompatibilityStateUnknown
		memoryFile.BrowserFormatSummary = json.RawMessage("{}")
		memoryFile.BrowserCompatibilityError = &errText
	}
	persist := func() error {
		checkedAt := time.Now().UTC()
		memoryFile.BrowserCompatibilityVersion = BrowserCompatibilityVersion
		memoryFile.BrowserCompatibilityCheckedAt = &checkedAt
		return persistBrowserCompatibility(ctx, deps.Pool, memoryFile)
	}

	// metricRecorded:except 分支已计 failed;无异常走 else 分支的终态口径。
	metricRecorded := false
	var raiseErr error

	func() {
		statusCode, _, _, _, body, openErr := client.OpenStream(ctx, remoteID, "bytes=0-")
		if openErr != nil {
			markUnknown("远程兼容探测失败")
			deps.Governor.Metrics.RecordFailed(TaskTypeDirectProbe)
			metricRecorded = true
			raiseErr = openErr
			return
		}
		if statusCode >= 400 {
			_ = body.Close()
			markUnknown("远程兼容探测失败")
			deps.Governor.Metrics.RecordFailed(TaskTypeDirectProbe)
			metricRecorded = true
			raiseErr = fmt.Errorf("远程兼容探测失败: HTTP %d", statusCode)
			return
		}
		defer body.Close()

		temporaryPath := filepath.Join(mediaRoot, "tmp",
			fmt.Sprintf(".browser-probe-%s.media", uuid.NewString()))
		activePath, absErr := filepath.Abs(temporaryPath)
		if absErr != nil {
			markUnknown(absErr.Error())
			deps.Governor.Metrics.RecordFailed(TaskTypeDirectProbe)
			metricRecorded = true
			return
		}
		RegisterTemporaryPath(activePath)
		defer func() {
			UnregisterTemporaryPath(activePath)
			_ = os.Remove(temporaryPath)
		}()

		// 有界写出:写失败按 OSError 分支(文案取 err,不上抛);
		// 流读取失败按 generic 分支(统一文案,上抛)。
		written, writeErr, readErr := boundedCopyToFile(ctx, body, temporaryPath, settings.BrowserProbeMaxBytes)
		if readErr != nil {
			markUnknown("远程兼容探测失败")
			deps.Governor.Metrics.RecordFailed(TaskTypeDirectProbe)
			metricRecorded = true
			raiseErr = readErr
			return
		}
		if writeErr != nil {
			markUnknown(writeErr.Error())
			deps.Governor.Metrics.RecordFailed(TaskTypeDirectProbe)
			metricRecorded = true
			return
		}
		_ = written

		probeCtx, cancel := context.WithTimeout(context.Background(),
			durSec(settings.BrowserProbeTimeoutSec))
		defer cancel()
		probeOut, probeRunErr := exec.CommandContext(probeCtx,
			"ffprobe",
			"-v", "error",
			"-print_format", "json",
			"-show_format",
			"-show_streams",
			temporaryPath,
		).Output()
		if probeRunErr != nil {
			markUnknown(probeRunErr.Error())
			deps.Governor.Metrics.RecordFailed(TaskTypeDirectProbe)
			metricRecorded = true
			return
		}

		stdout := strings.TrimSpace(string(probeOut))
		if stdout == "" {
			stdout = "{}"
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(stdout), &payload); err != nil {
			markUnknown(err.Error())
			deps.Governor.Metrics.RecordFailed(TaskTypeDirectProbe)
			metricRecorded = true
			return
		}

		summary := extractFFProbeSummary(payload)
		state := classifyFormat(summary)
		memoryFile.BrowserCompatibility = state
		memoryFile.BrowserFormatSummary = marshalJSONValue(summary)
		if state == models.BrowserCompatibilityStateUnknown {
			message := "探测数据不足，保持未知"
			memoryFile.BrowserCompatibilityError = &message
		} else {
			memoryFile.BrowserCompatibilityError = nil
		}
	}()

	if !metricRecorded {
		if memoryFile.BrowserCompatibility == models.BrowserCompatibilityStateUnknown {
			deps.Governor.Metrics.RecordFailed(TaskTypeDirectProbe)
		} else {
			deps.Governor.Metrics.RecordCompleted(TaskTypeDirectProbe)
		}
	}

	// finally:无论成败都刷新版本/时间并落库(对齐 db.commit + db.refresh)。
	if err := persist(); err != nil {
		release()
		return err
	}
	release()
	return raiseErr
}

// boundedCopyToFile 有界写出:达到 maxBytes 即停止;返回 (写入字节数,
// 写文件错误(OSError 类), 流读取错误(generic 类))。
func boundedCopyToFile(ctx context.Context, body io.Reader, target string, maxBytes int64) (int64, error, error) {
	file, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return 0, err, nil
	}
	defer file.Close()

	var total int64
	chunk := make([]byte, 64*1024)
	for {
		select {
		case <-ctx.Done():
			return total, nil, ctx.Err()
		default:
		}
		n, readErr := body.Read(chunk)
		if n > 0 {
			if total+int64(n) > maxBytes {
				remaining := maxBytes - total
				if remaining > 0 {
					if _, writeErr := file.Write(chunk[:remaining]); writeErr != nil {
						return total, writeErr, nil
					}
					total += remaining
				}
				return total, nil, nil
			}
			if _, writeErr := file.Write(chunk[:n]); writeErr != nil {
				return total, writeErr, nil
			}
			total += int64(n)
		}
		if readErr != nil {
			if readErr == io.EOF {
				return total, nil, nil
			}
			return total, nil, readErr
		}
	}
}

// persistBrowserCompatibility 持久化兼容字段并回读 updated_at
// (SQLAlchemy onupdate 的等价行为)。
func persistBrowserCompatibility(ctx context.Context, pool *pgxpool.Pool, memoryFile *models.MemoryFile) error {
	return pool.QueryRow(ctx,
		`UPDATE memory_files SET
			browser_compatibility = $1,
			browser_compatibility_version = $2,
			browser_format_summary = $3,
			browser_compatibility_error = $4,
			browser_compatibility_checked_at = $5,
			updated_at = now()
		 WHERE id = $6
		 RETURNING updated_at`,
		memoryFile.BrowserCompatibility,
		memoryFile.BrowserCompatibilityVersion,
		memoryFile.BrowserFormatSummary,
		memoryFile.BrowserCompatibilityError,
		memoryFile.BrowserCompatibilityCheckedAt,
		memoryFile.ID,
	).Scan(&memoryFile.UpdatedAt)
}
