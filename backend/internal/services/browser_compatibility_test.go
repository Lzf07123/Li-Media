package services

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"limedia/backend/internal/config"
	"limedia/backend/internal/models"
)

func TestClassifyFormat(t *testing.T) {
	cases := []struct {
		summary map[string]any
		want    models.BrowserCompatibilityState
	}{
		{map[string]any{}, models.BrowserCompatibilityStateUnknown},
		{map[string]any{"container": "mp4"}, models.BrowserCompatibilityStateUnknown}, // 缺 codec
		{map[string]any{"container": "mp4", "video_codec": "h264"}, models.BrowserCompatibilityStateSupported},
		{map[string]any{"container": "mp4", "video_codec": "h264", "audio_codec": "aac"}, models.BrowserCompatibilityStateSupported},
		{map[string]any{"container": "mp4", "video_codec": "h264", "audio_codec": "opus"}, models.BrowserCompatibilityStateUnsupported},
		{map[string]any{"container": "mkv", "video_codec": "h264"}, models.BrowserCompatibilityStateUnsupported},
		{map[string]any{"container": "mov", "video_codec": "h264"}, models.BrowserCompatibilityStateUnsupported},
		{map[string]any{"container": "mp4", "video_codec": "hevc"}, models.BrowserCompatibilityStateUnsupported},
		{map[string]any{"video_codec": "av1"}, models.BrowserCompatibilityStateUnsupported},
		{map[string]any{"container": "mpegts", "video_codec": "mpeg2video"}, models.BrowserCompatibilityStateUnsupported},
		{map[string]any{"video_codec": "h264", "container": "avi"}, models.BrowserCompatibilityStateUnsupported},
		// codec 优先于 container(判定顺序)。
		{map[string]any{"container": "mp4", "video_codec": "vp9"}, models.BrowserCompatibilityStateUnsupported},
	}
	for _, tc := range cases {
		if got := classifyFormat(tc.summary); got != tc.want {
			t.Errorf("classifyFormat(%v) = %q, want %q", tc.summary, got, tc.want)
		}
	}
}

func TestExtractFFProbeSummary(t *testing.T) {
	payload := map[string]any{
		"streams": []any{
			map[string]any{"codec_type": "video", "codec_name": "H264", "profile": "High"},
			map[string]any{"codec_type": "audio", "codec_name": "AAC"},
		},
		"format": map[string]any{"format_name": "mov,mp4,m4a,3gp,3g2,mj2"},
	}
	summary := extractFFProbeSummary(payload)
	if summary["container"] != "mov" {
		t.Fatalf("container 应取逗号前第一段: %v", summary["container"])
	}
	if summary["video_codec"] != "h264" {
		t.Fatalf("video_codec = %v", summary["video_codec"])
	}
	if summary["audio_codec"] != "aac" {
		t.Fatalf("audio_codec = %v", summary["audio_codec"])
	}
	if summary["video_profile"] != "high" {
		t.Fatalf("video_profile = %v(应小写)", summary["video_profile"])
	}

	if got := extractFFProbeSummary(map[string]any{}); len(got) != 0 {
		t.Fatalf("空 payload 应得空摘要: %v", got)
	}
}

func TestEvaluateMemoryFile(t *testing.T) {
	file := &models.MemoryFile{
		Extension:           strPtrOf("mp4"),
		RawMetadataSummary:  []byte(`{"video_codec":"h264","audio_codec":"aac"}`),
		BrowserFormatSummary: []byte(`{}`),
	}
	state, summary, err := EvaluateMemoryFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if state != models.BrowserCompatibilityStateSupported {
		t.Fatalf("h264+aac+mp4 应 supported, got %q", state)
	}
	if summary["container"] != "mp4" {
		t.Fatalf("扩展名应兜底 container: %v", summary)
	}

	hevc := &models.MemoryFile{
		Extension:          strPtrOf("mp4"),
		RawMetadataSummary: []byte(`{"video_codec":"hvc1"}`),
	}
	if state, _, _ := EvaluateMemoryFile(hevc); state != models.BrowserCompatibilityStateUnsupported {
		t.Fatalf("hvc1 应 unsupported, got %q", state)
	}

	empty := &models.MemoryFile{}
	emptyState, emptySummary, _ := EvaluateMemoryFile(empty)
	if emptyState != models.BrowserCompatibilityStateUnknown {
		t.Fatalf("无证据应 unknown, got %q", emptyState)
	}
	if len(emptySummary) != 0 {
		t.Fatalf("无证据摘要应为空: %v", emptySummary)
	}
}

func strPtrOf(s string) *string { return &s }

// ---- 假流客户端 ----

type fakeProbeClient struct {
	body   io.ReadCloser
	status int
	err    error
}

func (c *fakeProbeClient) OpenStream(ctx context.Context, remoteID, rangeHeader string) (int, *int64, string, string, io.ReadCloser, error) {
	if c.err != nil {
		return 0, nil, "", "", nil, c.err
	}
	return c.status, nil, "", "video/mp4", c.body, nil
}

func probeTestSettings(mediaRoot string) *config.Settings {
	return &config.Settings{
		MediaRoot:              mediaRoot,
		BrowserProbeMaxBytes:   2 * 1024 * 1024,
		BrowserProbeTimeoutSec: 12,
		DirectProbeConcurrencyLimit: 4,
		DirectProbeQueueLimit:       16,
		DirectProbeWaitTimeoutSec:   3,
	}
}

func TestProbeMemoryFileCompatibilitySupported(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "clip.mp4")
	genTestVideo(t, source)
	content, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}

	pool := servicesTestPool(t)
	ctx := context.Background()
	fileID := seedProbeFile(t, pool)

	governor := NewTaskGovernor(probeTestSettings(dir))
	deps := &BrowserProbeDeps{
		Settings: probeTestSettings(dir),
		Governor: governor,
		Pool:     pool,
	}
	client := &fakeProbeClient{body: io.NopCloser(bytes.NewReader(content)), status: 200}

	file := &models.MemoryFile{ID: fileID, RemoteID: strPtrOf("104")}
	if err := ProbeMemoryFileCompatibility(ctx, deps, client, file, dir); err != nil {
		t.Fatal(err)
	}

	// 契约对齐上游:format_name 取逗号前首段("mov,mp4,..."→"mov"∉{mp4,m4v}),
	// 真实 mp4 探测结果为 unsupported(上游语义,如需修两侧同步)。
	if file.BrowserCompatibility != models.BrowserCompatibilityStateUnsupported {
		t.Fatalf("探测结果 = %q, want unsupported(上游 format_name 首段语义)", file.BrowserCompatibility)
	}
	if file.BrowserCompatibilityError != nil {
		t.Fatalf("成功探测不应有 error: %v", *file.BrowserCompatibilityError)
	}
	if file.BrowserCompatibilityVersion != BrowserCompatibilityVersion {
		t.Fatalf("version = %q", file.BrowserCompatibilityVersion)
	}
	summary := map[string]any{}
	if err := json.Unmarshal(file.BrowserFormatSummary, &summary); err != nil {
		t.Fatal(err)
	}
	if summary["video_codec"] != "h264" {
		t.Fatalf("摘要应含 video_codec: %v", summary)
	}

	// 持久化回读:库内状态一致。
	var persisted string
	if err := pool.QueryRow(ctx,
		`SELECT browser_compatibility FROM memory_files WHERE id = $1`, fileID,
	).Scan(&persisted); err != nil {
		t.Fatal(err)
	}
	// 契约对齐上游:format_name 首段语义下真实 mp4 持久化为 unsupported。
	if persisted != string(models.BrowserCompatibilityStateUnsupported) {
		t.Fatalf("库内状态 = %q", persisted)
	}
	if governor.Metrics.Snapshot()["direct_probe.completed"].(int) != 1 {
		t.Fatalf("direct_probe.completed 指标应 +1: %v", governor.Metrics.Snapshot())
	}

	// 临时探测文件应清理。
	tmpEntries, _ := os.ReadDir(filepath.Join(dir, "tmp"))
	for _, entry := range tmpEntries {
		if strings.HasPrefix(entry.Name(), ".browser-probe-") {
			t.Fatalf("探测临时文件未清理: %s", entry.Name())
		}
	}
}

func TestProbeMemoryFileCompatibilityClientError(t *testing.T) {
	dir := t.TempDir()
	pool := servicesTestPool(t)
	ctx := context.Background()
	fileID := seedProbeFile(t, pool)

	governor := NewTaskGovernor(probeTestSettings(dir))
	deps := &BrowserProbeDeps{Settings: probeTestSettings(dir), Governor: governor, Pool: pool}
	client := &fakeProbeClient{err: &fakeProbeError{"net down"}}

	file := &models.MemoryFile{ID: fileID, RemoteID: strPtrOf("104")}
	err := ProbeMemoryFileCompatibility(ctx, deps, client, file, dir)
	if err == nil {
		t.Fatal("客户端错误应上抛")
	}

	// unknown + 统一文案 + 失败指标。
	if file.BrowserCompatibility != models.BrowserCompatibilityStateUnknown {
		t.Fatalf("客户端错误应为 unknown, got %q", file.BrowserCompatibility)
	}
	if file.BrowserCompatibilityError == nil || *file.BrowserCompatibilityError != "远程兼容探测失败" {
		t.Fatalf("error = %v, want 远程兼容探测失败", file.BrowserCompatibilityError)
	}
	if governor.Metrics.Snapshot()["direct_probe.failed"].(int) != 1 {
		t.Fatalf("direct_probe.failed 指标应 +1: %v", governor.Metrics.Snapshot())
	}

	// 库内落库为 unknown(generic 分支也走 finally 持久化)。
	var persisted string
	var persistedErr *string
	if err := pool.QueryRow(ctx,
		`SELECT browser_compatibility, browser_compatibility_error FROM memory_files WHERE id = $1`, fileID,
	).Scan(&persisted, &persistedErr); err != nil {
		t.Fatal(err)
	}
	if persisted != string(models.BrowserCompatibilityStateUnknown) || persistedErr == nil {
		t.Fatalf("库内 = (%q, %v)", persisted, persistedErr)
	}
}

func TestProbeMemoryFileCompatibilityTaskRejected(t *testing.T) {
	dir := t.TempDir()
	pool := servicesTestPool(t)
	ctx := context.Background()
	fileID := seedProbeFile(t, pool)

	settings := probeTestSettings(dir)
	settings.DirectProbeConcurrencyLimit = 1
	settings.DirectProbeWaitTimeoutSec = 0.2
	governor := NewTaskGovernor(settings)
	deps := &BrowserProbeDeps{Settings: settings, Governor: governor, Pool: pool}
	client := &fakeProbeClient{body: io.NopCloser(bytes.NewReader([]byte("x"))), status: 200}

	// 占满唯一并发槽位:后续 acquire 在队列超时后以 TaskRejected 拒绝。
	blocked, release, err := governor.Slot(ctx, TaskTypeDirectProbe, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	_ = blocked

	file := &models.MemoryFile{ID: fileID, RemoteID: strPtrOf("104")}
	rejectErr := ProbeMemoryFileCompatibility(ctx, deps, client, file, dir)
	if rejectErr == nil {
		t.Fatal("队列拒绝应上抛 TaskRejected")
	}
	var rejected *TaskRejected
	if !asTaskRejected(rejectErr, &rejected) {
		t.Fatalf("应 TaskRejected: %v", rejectErr)
	}
	// 未进探测:version/checked_at 不落库。
	var checkedAt *string
	if err := pool.QueryRow(ctx,
		`SELECT browser_compatibility_checked_at FROM memory_files WHERE id = $1`, fileID,
	).Scan(&checkedAt); err != nil {
		t.Fatal(err)
	}
	if checkedAt != nil {
		t.Fatalf("槽位拒绝不应落库: %v", checkedAt)
	}
}

func asTaskRejected(err error, target **TaskRejected) bool {
	if r, ok := err.(*TaskRejected); ok {
		*target = r
		return true
	}
	return false
}

type fakeProbeError struct{ msg string }

func (e *fakeProbeError) Error() string { return e.msg }

// seedProbeFile 种入一条待探测的 video 文件(browser unknown)。
func seedProbeFile(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	memoryID := "00000000-0000-4000-8000-0000000000a1"
	fileID := "10000000-0000-4000-8000-0000000000a1"
	stmts := []string{
		`INSERT INTO memories (id, title, kind, status) VALUES
			('` + memoryID + `', '探测视频', 'video', 'published')`,
		`INSERT INTO memory_files (id, memory_id, source, remote_path, remote_id, source_path,
			parent_path, filename, mime_type, remote_state, thumbnail_state, stream_state,
			browser_compatibility, status) VALUES
			('` + fileID + `', '` + memoryID + `', 'baidupan', '/videos/probe/a.mp4', '104', '',
			 '/videos/probe', 'a.mp4', 'video/mp4', 'ready', 'ready', 'ready',
			 'unknown', 'matched')`,
	}
	for _, stmt := range stmts {
		if _, err := pool.Exec(ctx, stmt); err != nil {
			t.Fatalf("种子导入失败: %v\n%s", err, stmt)
		}
	}
	return uuid.MustParse(fileID)
}
