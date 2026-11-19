// memory_thumbnails.go 对齐原 app/services/memory_thumbnails.py。
//
// 实现路线差异(有意为之):Python 用 Pillow 处理照片、ffmpeg 处理视频;
// Go 无纯 Go WebP 编码器,统一走 ffmpeg 单次解码多尺寸(filter_complex
// split/scale 链)。派生版本号随之 +1,规避新旧产物缓存混用。
package services

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	_ "golang.org/x/image/webp"

	"github.com/google/uuid"

	"limedia/backend/internal/config"
	"limedia/backend/internal/models"
)

// ChildPeakRecorder 由装配层注入(指向 TaskGovernor.Metrics);
// 默认 no-op,避免服务层与具体 governor 实例耦合。
var ChildPeakRecorder = func(int) {}

// ResolveMediaPath 限制在 media_root 内解析相对路径,越界返回 nil。
func ResolveMediaPath(mediaRoot, relativePath string) *string {
	absRoot, err := filepath.Abs(mediaRoot)
	if err != nil {
		return nil
	}
	target, err := filepath.Abs(filepath.Join(absRoot, relativePath))
	if err != nil {
		return nil
	}
	rel, err := filepath.Rel(absRoot, target)
	if err != nil || strings.HasPrefix(rel, "..") {
		return nil
	}
	return &target
}

// ReadImageDimensions 读图宽高,EXIF orientation 5-8 时交换宽高
// (对齐 ImageOps.exif_transpose 的尺寸语义)。
func ReadImageDimensions(content []byte) (*int, *int) {
	width, height, err := imageDimensions(content)
	if err != nil || width <= 0 || height <= 0 {
		return nil, nil
	}
	orientation := jpegOrientation(content)
	if orientation >= 5 && orientation <= 8 {
		width, height = height, width
	}
	w, h := width, height
	return &w, &h
}

func imageDimensions(content []byte) (int, int, error) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(content))
	if err != nil {
		return 0, 0, err
	}
	return cfg.Width, cfg.Height, nil
}

// jpegOrientation 从 JPEG APP1 EXIF 段读取 orientation tag;非 JPEG 返回 1。
func jpegOrientation(content []byte) int {
	if len(content) < 4 || content[0] != 0xFF || content[1] != 0xD8 {
		return 1
	}
	pos := 2
	for pos+4 <= len(content) {
		if content[pos] != 0xFF {
			return 1
		}
		marker := content[pos+1]
		if marker == 0xD8 || (marker >= 0xD0 && marker <= 0xD7) { // SOI/RST
			pos += 2
			continue
		}
		if pos+4 > len(content) {
			return 1
		}
		length := int(content[pos+2])<<8 | int(content[pos+3])
		if marker == 0xE1 && length >= 8 { // APP1(EXIF)
			segment := content[pos+4 : minInt(pos+2+length, len(content))]
			if len(segment) > 6 && string(segment[:6]) == "Exif\x00\x00" {
				return exifOrientation(segment[6:])
			}
		}
		pos += 2 + length
	}
	return 1
}

func exifOrientation(tiff []byte) int {
	if len(tiff) < 8 {
		return 1
	}
	byteOrder := "II"
	if string(tiff[:2]) == "MM" {
		byteOrder = "MM"
	} else if string(tiff[:2]) != "II" {
		return 1
	}
	readU16 := func(b []byte) int {
		if byteOrder == "MM" {
			return int(b[0])<<8 | int(b[1])
		}
		return int(b[1])<<8 | int(b[0])
	}
	readU32 := func(b []byte) int {
		if byteOrder == "MM" {
			return int(b[0])<<24 | int(b[1])<<16 | int(b[2])<<8 | int(b[3])
		}
		return int(b[3])<<24 | int(b[2])<<16 | int(b[1])<<8 | int(b[0])
	}

	ifReadStart := readU32(tiff[4:8])
	if ifReadStart+2 > len(tiff) {
		return 1
	}
	entryCount := readU16(tiff[ifReadStart : ifReadStart+2])
	for i := 0; i < entryCount; i++ {
		off := ifReadStart + 2 + i*12
		if off+12 > len(tiff) {
			return 1
		}
		tag := readU16(tiff[off : off+2])
		if tag == 0x0112 { // orientation
			return readU16(tiff[off+8 : off+10])
		}
	}
	return 1
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// RemoveMediaFile 删除 media_root 内的相对路径文件(越界忽略)。
func RemoveMediaFile(mediaRoot string, relativePath *string) {
	if relativePath == nil || *relativePath == "" {
		return
	}
	if target := ResolveMediaPath(mediaRoot, *relativePath); target != nil {
		if info, err := os.Stat(*target); err == nil && info.Mode().IsRegular() {
			_ = os.Remove(*target)
		}
	}
}

// DerivativeCachePath 单个保持宽高比的派生图缓存路径(隔离目录树)。
func DerivativeCachePath(mediaRoot string, memoryID uuid.UUID, maxSize int, version string) string {
	return filepath.Join(mediaRoot, "thumbnails", memoryID.String(), version,
		fmt.Sprintf("%d.webp", maxSize))
}

// ClassifyDerivativeException 从错误与 stderr 归类失败种类。
func ClassifyDerivativeException(err error) models.DerivativeFailureKind {
	var exitErr *exec.ExitError
	message := ""
	if errors.As(err, &exitErr) {
		message = strings.ToLower(string(exitErr.Stderr) + " " + err.Error())
	} else {
		message = strings.ToLower(err.Error())
	}

	switch {
	case strings.Contains(err.Error(), "context deadline exceeded") || strings.Contains(err.Error(), "signal: killed"):
		return models.DerivativeFailureTimeout
	case strings.Contains(message, "moov atom not found"):
		return models.DerivativeFailureMovMoov
	case strings.Contains(message, "invalid data found") || strings.Contains(message, "no video"):
		return models.DerivativeFailureCodecUnsupport
	case strings.Contains(message, "image: unknown format") || strings.Contains(message, "image: decode"):
		return models.DerivativeFailureFormatUnsupport
	case isOSError(err):
		return models.DerivativeFailureTemporaryIO
	default:
		return models.DerivativeFailureUnknown
	}
}

func isOSError(err error) bool {
	var pathErr *os.PathError
	var sysErr *os.SyscallError
	return errors.As(err, &pathErr) || errors.As(err, &sysErr)
}

// runFFmpegMultiSize 单次 ffmpeg 解码输出多尺寸;单尺寸产物缺失只影响该尺寸。
func runFFmpegMultiSize(
	sourcePath string,
	maxSizes []int,
	outputs map[int]string,
	temporaries map[int]string,
	startSeconds float64,
	quality int,
	failureSink map[string]string,
) map[int]*string {
	results := make(map[int]*string, len(maxSizes))
	orderedSizes := append([]int{}, maxSizes...)
	count := len(orderedSizes)

	// split 与其输出标签直接相连(无分号),各 scale 段之间用分号。
	splitPart := fmt.Sprintf("[0:v]split=%d", count)
	for i := range orderedSizes {
		splitPart += fmt.Sprintf("[s%d]", i)
	}
	chain := []string{splitPart}
	for i, maxSize := range orderedSizes {
		chain = append(chain, fmt.Sprintf(
			"[s%d]scale='if(gt(iw,ih),min(%d,iw),-2)':'if(gt(iw,ih),-2,min(%d,ih))'[o%d]",
			i, maxSize, maxSize, i))
	}

	command := []string{
		"ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
		"-threads", "1",
	}
	if startSeconds > 0 {
		command = append(command, "-ss", fmt.Sprintf("%.2f", startSeconds))
	}
	command = append(command, "-i", sourcePath, "-filter_complex", strings.Join(chain, ";"))
	for i := range orderedSizes {
		command = append(command, "-map", fmt.Sprintf("[o%d]", i), "-frames:v", "1")
		command = append(command, "-quality", fmt.Sprintf("%d", quality))
		command = append(command, temporaries[orderedSizes[i]])
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitErr.Stderr = stderr.Bytes()
		}
		for _, maxSize := range orderedSizes {
			cleanupOutput(outputs[maxSize], temporaries[maxSize])
			results[maxSize] = nil
		}
		if failureSink != nil {
			setFailureKind(failureSink, ClassifyDerivativeException(err))
		}
		return results
	}
	recordChildPeakRSS()

	for _, maxSize := range orderedSizes {
		temporary := temporaries[maxSize]
		info, statErr := os.Stat(temporary)
		if statErr == nil && info.Size() > 0 {
			renameErr := os.Rename(temporary, outputs[maxSize])
			if renameErr == nil {
				result := outputs[maxSize]
				results[maxSize] = &result
				continue
			}
			cleanupOutput(outputs[maxSize], temporary)
			results[maxSize] = nil
			if failureSink != nil {
				setFailureKind(failureSink, ClassifyDerivativeException(renameErr))
			}
			continue
		}
		cleanupOutput(outputs[maxSize], temporary)
		results[maxSize] = nil
	}
	return results
}

func setFailureKind(sink map[string]string, kind models.DerivativeFailureKind) {
	if _, exists := sink["kind"]; !exists {
		sink["kind"] = string(kind)
	}
}

func cleanupOutput(outputPath, temporaryPath string) {
	_ = os.Remove(temporaryPath)
	_ = os.Remove(outputPath)
}

// recordChildPeakRSS 记录子进程峰值内存(RUSAGE_CHILDREN)。
func recordChildPeakRSS() {
	var usage syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_CHILDREN, &usage); err == nil {
		// Linux ru_maxrss 单位为 KB,macOS 为字节;容器部署为 Linux。
		ChildPeakRecorder(int(usage.Maxrss))
	}
}

// CreateMemoryDerivatives 一次 ffmpeg 生成多尺寸,返回 {max_size: 相对路径|nil}。
// 解码级失败使全部尺寸失败;单尺寸保存失败只影响该尺寸。
func CreateMemoryDerivatives(
	sourcePath, mediaRoot string,
	kind models.MemoryKind,
	memoryID uuid.UUID,
	maxSizes []int,
	failureSink map[string]string,
	settings *config.Settings,
) map[int]*string {
	sizes := dedupeInts(maxSizes)
	outputs := make(map[int]string, len(sizes))
	temporaries := make(map[int]string, len(sizes))
	var registered []string

	for _, maxSize := range sizes {
		outputPath := DerivativeCachePath(mediaRoot, memoryID, maxSize, settings.MediaDerivativeVersion)
		_ = os.MkdirAll(filepath.Dir(outputPath), 0o755)
		outputs[maxSize] = outputPath
		temporaries[maxSize] = filepath.Join(filepath.Dir(outputPath),
			fmt.Sprintf(".%s.%s.tmp.webp", memoryID, uuid.NewString()))
		if active, err := filepath.Abs(outputPath); err == nil {
			registered = append(registered, active)
			RegisterTemporaryPath(active)
		}
	}
	defer func() {
		for _, active := range registered {
			UnregisterTemporaryPath(active)
		}
	}()

	var startSeconds float64
	if kind == models.MemoryKindVideo {
		startSeconds = settings.VideoFrameOffsetSeconds
		if startSeconds < 0 {
			startSeconds = 0
		}
	}
	sizeResults := runFFmpegMultiSize(sourcePath, sizes, outputs, temporaries,
		startSeconds, settings.ThumbnailQuality, failureSink)

	result := make(map[int]*string, len(sizes))
	for _, maxSize := range sizes {
		if sizeResults[maxSize] != nil {
			if rel, err := filepath.Rel(mediaRoot, outputs[maxSize]); err == nil {
				posix := filepath.ToSlash(rel)
				result[maxSize] = &posix
				continue
			}
		}
		result[maxSize] = nil
	}
	return result
}

// CreateMemoryDerivative 单尺寸派生(按需请求路径)。
func CreateMemoryDerivative(
	sourcePath, mediaRoot string,
	kind models.MemoryKind,
	memoryID uuid.UUID,
	maxSize int,
	failureSink map[string]string,
	settings *config.Settings,
) *string {
	results := CreateMemoryDerivatives(sourcePath, mediaRoot, kind, memoryID, []int{maxSize}, failureSink, settings)
	return results[maxSize]
}

// CreateMemoryThumbnail 兼容包装:使用配置的最大尺寸。
func CreateMemoryThumbnail(
	sourcePath, mediaRoot string,
	kind models.MemoryKind,
	memoryID uuid.UUID,
	settings *config.Settings,
) *string {
	return CreateMemoryDerivative(sourcePath, mediaRoot, kind, memoryID,
		settings.ThumbnailMaxSize, nil, settings)
}

func dedupeInts(values []int) []int {
	seen := make(map[int]bool, len(values))
	out := make([]int, 0, len(values))
	for _, v := range values {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}
