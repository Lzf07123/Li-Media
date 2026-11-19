package services

import (
	"os"
	"os/exec"
	"io/fs"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/google/uuid"

	"limedia/backend/internal/config"
	"limedia/backend/internal/models"
)

// genTestImage 用 ffmpeg 生成纯色 JPEG 源(4000x3000,触发缩放路径)。
func genTestImage(t *testing.T, path string) {
	t.Helper()
	cmd := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=steelblue:s=4000x3000:d=1",
		"-frames:v", "1", "-y", path)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("生成测试图失败: %v\n%s", err, out)
	}
}

func testSettings() *config.Settings {
	return &config.Settings{
		MediaRoot:               "./data/media",
		MediaDerivativeVersion:  "20260906-ratio-v1",
		ThumbnailQuality:        82,
		ThumbnailMaxSize:        1280,
		VideoFrameOffsetSeconds: 0,
		RemoteThumbnailSourceMaxBytes:      16 * 1024 * 1024,
		RemoteThumbnailVideoSourceMaxBytes: 64 * 1024 * 1024,
		RemoteThumbnailDiskQuotaBytes:      4 * 1024 * 1024 * 1024,
		RemoteThumbnailMaxTempFiles:        8,
	}
}

func TestCreateMemoryDerivativesPhoto(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "source.jpg")
	genTestImage(t, source)
	mediaRoot := filepath.Join(dir, "media")
	settings := testSettings()

	sink := map[string]string{}
	memoryID := uuid.MustParse("00000000-0000-4000-8000-0000000000aa")
	results := CreateMemoryDerivatives(source, mediaRoot, "photo", memoryID,
		[]int{240, 480, 768}, sink, settings)

	for _, size := range []int{240, 480, 768} {
		relative := results[size]
		if relative == nil {
			t.Fatalf("尺寸 %d 应生成成功(sink=%v)", size, sink)
		}
		abs := filepath.Join(mediaRoot, *relative)
		info, err := os.Stat(abs)
		if err != nil || info.Size() == 0 {
			t.Fatalf("尺寸 %d 产物缺失: %v", size, err)
		}
		if want := filepath.Join("thumbnails", memoryID.String(), settings.MediaDerivativeVersion,
			string(rune('0'))); false {
			_ = want
		}
	}
	// 路径结构:thumbnails/{memory_id}/{version}/{size}.webp
	wantSuffix := filepath.Join("thumbnails", memoryID.String(), settings.MediaDerivativeVersion, "240.webp")
	if filepath.ToSlash(*results[240]) != filepath.ToSlash(wantSuffix) {
		t.Fatalf("路径 = %s, want %s", *results[240], wantSuffix)
	}
	// 临时文件应已清理。
	entries, _ := os.ReadDir(filepath.Dir(filepath.Join(mediaRoot, *results[240])))
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) == ".tmp" || len(entry.Name()) > 4 && entry.Name()[0] == '.' {
			t.Fatalf("临时文件未清理: %s", entry.Name())
		}
	}
}

func TestCreateMemoryDerivativeSingle(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "source.jpg")
	genTestImage(t, source)
	mediaRoot := filepath.Join(dir, "media")
	settings := testSettings()

	sink := map[string]string{}
	memoryID := uuid.MustParse("00000000-0000-4000-8000-0000000000bb")
	result := CreateMemoryDerivative(source, mediaRoot, "photo", memoryID, 240, sink, settings)
	if result == nil {
		t.Fatalf("单尺寸派生应成功(sink=%v)", sink)
	}
	info, err := os.Stat(filepath.Join(mediaRoot, *result))
	if err != nil || info.Size() == 0 {
		t.Fatalf("产物缺失: %v", err)
	}
}

func TestCreateMemoryDerivativeFailureClassified(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "broken.jpg")
	if err := os.WriteFile(source, []byte("not an image at all"), 0o644); err != nil {
		t.Fatal(err)
	}
	mediaRoot := filepath.Join(dir, "media")
	settings := testSettings()

	sink := map[string]string{}
	memoryID := uuid.MustParse("00000000-0000-4000-8000-0000000000cc")
	result := CreateMemoryDerivative(source, mediaRoot, "photo", memoryID, 240, sink, settings)
	if result != nil {
		t.Fatal("损坏源应派生失败")
	}
	if sink["kind"] == "" {
		t.Fatal("失败种类应写入 failure_sink")
	}
}

func TestResolveMediaPathBlocksTraversal(t *testing.T) {
	mediaRoot := "/tmp/limedia-test-media"

	if got := ResolveMediaPath(mediaRoot, "photos/a.jpg"); got == nil {
		t.Fatal("合法相对路径应解析")
	}
	if got := ResolveMediaPath(mediaRoot, "../escape.jpg"); got != nil {
		t.Fatalf("越界路径应被拒绝, got %v", got)
	}
	if got := ResolveMediaPath(mediaRoot, "photos/../../escape.jpg"); got != nil {
		t.Fatalf("嵌套越界应被拒绝, got %v", got)
	}
}

func TestReadImageDimensions(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "img.jpg")
	genTestImage(t, source)
	content, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	width, height := ReadImageDimensions(content)
	if width == nil || height == nil {
		t.Fatal("应读到宽高")
	}
	if *width != 4000 || *height != 3000 {
		t.Fatalf("宽高 = (%d, %d), want (4000, 3000)", *width, *height)
	}

	w, h := ReadImageDimensions([]byte("garbage"))
	if w != nil || h != nil {
		t.Fatal("无效内容应返回 nil")
	}
}

func TestClassifyDerivativeException(t *testing.T) {
	// 真实 os.PathError → temporary_io;其他自定义错误按文案归类。
	pathErr := &fs.PathError{Op: "open", Path: "/tmp/x", Err: syscall.ENOENT}
	if got := ClassifyDerivativeException(pathErr); got != models.DerivativeFailureTemporaryIO {
		t.Errorf("PathError 分类 = %q, want temporary_io", got)
	}

	cases := []struct {
		message string
		want    models.DerivativeFailureKind
	}{
		{"moov atom not found in file", models.DerivativeFailureMovMoov},
		{"Invalid data found when processing input", models.DerivativeFailureCodecUnsupport},
		{"image: unknown format", models.DerivativeFailureFormatUnsupport},
		{"something else", models.DerivativeFailureUnknown},
	}
	for _, tc := range cases {
		gotKind := ClassifyDerivativeException(&fakeDerivativeError{message: tc.message})
		if gotKind != tc.want {
			t.Errorf("classify(%q) = %q, want %q", tc.message, gotKind, tc.want)
		}
	}
}

type fakeDerivativeError struct{ message string }

func (e *fakeDerivativeError) Error() string { return e.message }

func TestTemporaryCapacityCleanup(t *testing.T) {
	mediaRoot := t.TempDir()
	tmpDir := filepath.Join(mediaRoot, "tmp")
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		t.Fatal(err)
	}
	settings := testSettings()
	settings.RemoteThumbnailMaxTempFiles = 2

	if !TemporaryDirectoryHasCapacity(settings, tmpDir) {
		t.Fatal("空目录应有容量")
	}
	for _, name := range []string{"a.tmp", "b.tmp"} {
		if err := os.WriteFile(filepath.Join(tmpDir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if TemporaryDirectoryHasCapacity(settings, tmpDir) {
		t.Fatal("达到文件数上限应无容量")
	}

	// 孤儿清理:未注册的 .tmp 应被删除。
	if removed := CleanupStaleRemoteTemporaryFiles(mediaRoot); removed != 2 {
		t.Fatalf("孤儿临时文件清理数 = %d, want 2", removed)
	}
}
