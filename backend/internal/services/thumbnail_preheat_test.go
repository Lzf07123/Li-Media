package services

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"

	"limedia/backend/internal/models"
)

// TestThumbnailPreheatRunnerCompletesRemoteCandidate 覆盖网盘源预热全链路:
// 枚举候选 → 下载远程源 → 本地派生 → 缓存/缩略图落库 → 任务完成。
// 此前下载成功后未把临时文件路径交回派生步骤,会在 *sourcePath 处空指针
// panic,预热任务与进程一起中断。
func TestThumbnailPreheatRunnerCompletesRemoteCandidate(t *testing.T) {
	pool := servicesTestPool(t)
	ctx := context.Background()

	dir := t.TempDir()
	mediaRoot := filepath.Join(dir, "media")
	if err := os.MkdirAll(mediaRoot, 0o755); err != nil {
		t.Fatalf("创建 media_root 失败: %v", err)
	}
	sourceFile := filepath.Join(dir, "remote-source.jpg")
	genTestImage(t, sourceFile)
	sourceBytes, err := os.ReadFile(sourceFile)
	if err != nil {
		t.Fatalf("读取测试图失败: %v", err)
	}

	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/multimedia"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprintf(w,
				`{"errno":0,"list":[{"path":"/remote/photo.jpg","server_filename":"photo.jpg",`+
					`"fs_id":424242,"isdir":0,"size":%d,"server_mtime":1700000000,`+
					`"md5":"abc","category":3,"dlink":%q}]}`,
				len(sourceBytes), server.URL+"/download/source.jpg")
		case r.URL.Path == "/download/source.jpg":
			w.Header().Set("Content-Type", "image/jpeg")
			w.Header().Set("Content-Length", strconv.Itoa(len(sourceBytes)))
			_, _ = w.Write(sourceBytes)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	settings := testSettings()
	settings.MediaRoot = mediaRoot
	settings.BaiduAPIBaseURL = server.URL
	settings.BaiduAccessToken = "token"
	settings.BaiduRetryAttempts = 1
	settings.SourceDownloadTimeoutSec = 10
	settings.DerivativeConcurrencyLimit = 2
	settings.DerivativeQueueLimit = 4
	settings.DerivativeWaitTimeoutSec = 5
	settings.PreheatConcurrencyLimit = 2
	settings.PreheatQueueLimit = 4
	settings.PreheatWaitTimeoutSec = 5

	governor := NewTaskGovernor(settings)
	derivatives := &DerivativeTasks{
		Settings: settings,
		Governor: governor,
		InFlight: NewInFlightRegistry(governor.Metrics),
	}
	registry := NewThumbnailPreheatRegistry()
	runner := &ThumbnailPreheatRunner{
		Pool:        pool,
		Settings:    settings,
		Governor:    governor,
		Derivatives: derivatives,
		Registry:    registry,
	}

	memoryID := uuid.New()
	fileID := uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO memories (id, title, kind, status, captured_at)
		 VALUES ($1, $2, $3, $4, now())`,
		memoryID, "远程照片", models.MemoryKindPhoto, models.MemoryStatusPublished); err != nil {
		t.Fatalf("插入 memory 失败: %v", err)
	}
	file := &models.MemoryFile{
		ID:                   fileID,
		MemoryID:             &memoryID,
		Source:               "baidupan",
		RemotePath:           "/remote/photo.jpg",
		RemoteID:             ptrString("424242"),
		MimeType:             "image/jpeg",
		Status:               models.MemoryFileStatusMatched,
		RemoteState:          models.RemoteFileStateReady,
		ThumbnailState:       models.RemoteThumbnailStateMissing,
		StreamState:          models.RemoteStreamStateReady,
		BrowserCompatibility: models.BrowserCompatibilityStateSupported,
	}
	if err := insertMemoryFile(ctx, pool, file); err != nil {
		t.Fatalf("插入 memory file 失败: %v", err)
	}

	job, started := registry.Start([]int{240}, nil, 0,
		settings.PreheatConcurrencyLimit, settings.PreheatQueueLimit, false)
	if !started {
		t.Fatal("预热任务应能启动")
	}
	runner.Run(job.ID)

	snapshot := registry.Snapshot(job.ID)
	if snapshot == nil {
		t.Fatal("任务快照丢失")
	}
	if snapshot.Status != PreheatJobCompleted {
		t.Fatalf("任务状态 = %q, want completed (message=%v)", snapshot.Status, snapshot.Message)
	}
	if snapshot.Processed != 1 || snapshot.Generated != 1 {
		t.Fatalf("任务计数 processed=%d generated=%d, want 1/1", snapshot.Processed, snapshot.Generated)
	}

	var status, outputPath string
	if err := pool.QueryRow(ctx,
		`SELECT status, output_path FROM memory_derivative_caches
		 WHERE memory_file_id = $1 AND max_size = 240`, fileID).Scan(&status, &outputPath); err != nil {
		t.Fatalf("读取派生缓存失败: %v", err)
	}
	if status != "ready" || outputPath == "" {
		t.Fatalf("派生缓存 = (%q, %q), want (ready, 非空)", status, outputPath)
	}
	// 库内 output_path 相对 media_root 存储。
	absoluteOutput := outputPath
	if !filepath.IsAbs(absoluteOutput) {
		absoluteOutput = filepath.Join(mediaRoot, absoluteOutput)
	}
	if info, err := os.Stat(absoluteOutput); err != nil || info.Size() == 0 {
		t.Fatalf("派生文件缺失: %v", err)
	}

	var thumbnailPath *string
	if err := pool.QueryRow(ctx,
		`SELECT thumbnail_path FROM memories WHERE id = $1`, memoryID).Scan(&thumbnailPath); err != nil {
		t.Fatalf("读取 memory.thumbnail_path 失败: %v", err)
	}
	if thumbnailPath == nil || *thumbnailPath == "" {
		t.Fatal("240 预热后应回填 memory.thumbnail_path")
	}

	// 下载的临时源文件必须清理。
	entries, err := os.ReadDir(filepath.Join(mediaRoot, "tmp"))
	if err != nil {
		t.Fatalf("读取临时目录失败: %v", err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".source.tmp") {
			t.Fatalf("临时源文件未清理: %s", entry.Name())
		}
	}
}

func TestThumbnailPreheatRunnerRecordsFailureReason(t *testing.T) {
	pool := servicesTestPool(t)
	ctx := context.Background()

	settings := testSettings()
	settings.MediaRoot = t.TempDir()
	settings.BaiduAccessToken = "token" // 凭证可用;失败来自非法 remote_id
	settings.DerivativeConcurrencyLimit = 2
	settings.DerivativeQueueLimit = 4
	settings.DerivativeWaitTimeoutSec = 5
	settings.PreheatConcurrencyLimit = 2
	settings.PreheatQueueLimit = 4
	settings.PreheatWaitTimeoutSec = 5

	governor := NewTaskGovernor(settings)
	registry := NewThumbnailPreheatRegistry()
	runner := &ThumbnailPreheatRunner{
		Pool:     pool,
		Settings: settings,
		Governor: governor,
		Derivatives: &DerivativeTasks{
			Settings: settings,
			Governor: governor,
			InFlight: NewInFlightRegistry(governor.Metrics),
		},
		Registry: registry,
	}

	memoryID := uuid.New()
	fileID := uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO memories (id, title, kind, status, captured_at)
		 VALUES ($1, $2, $3, $4, now())`,
		memoryID, "非法远程 ID", models.MemoryKindPhoto, models.MemoryStatusPublished); err != nil {
		t.Fatalf("插入 memory 失败: %v", err)
	}
	file := &models.MemoryFile{
		ID:                   fileID,
		MemoryID:             &memoryID,
		Source:               "baidupan",
		RemotePath:           "/remote/bad-id.jpg",
		RemoteID:             ptrString("placeholder-0017"),
		MimeType:             "image/jpeg",
		Status:               models.MemoryFileStatusMatched,
		RemoteState:          models.RemoteFileStateReady,
		ThumbnailState:       models.RemoteThumbnailStateMissing,
		StreamState:          models.RemoteStreamStateReady,
		BrowserCompatibility: models.BrowserCompatibilityStateSupported,
	}
	if err := insertMemoryFile(ctx, pool, file); err != nil {
		t.Fatalf("插入 memory file 失败: %v", err)
	}

	job, started := registry.Start([]int{240}, nil, 0,
		settings.PreheatConcurrencyLimit, settings.PreheatQueueLimit, false)
	if !started {
		t.Fatal("预热任务应能启动")
	}
	runner.Run(job.ID)

	snapshot := registry.Snapshot(job.ID)
	if snapshot == nil {
		t.Fatal("任务快照丢失")
	}
	if snapshot.Status != PreheatJobCompleted {
		t.Fatalf("任务状态 = %q, want completed", snapshot.Status)
	}
	if snapshot.Failed != 1 {
		t.Fatalf("failed = %d, want 1", snapshot.Failed)
	}
	if snapshot.Message == nil || !strings.Contains(*snapshot.Message, "reason=remote_not_found") {
		t.Fatalf("任务消息应包含失败原因, got %v", snapshot.Message)
	}

	var failureKind *string
	if err := pool.QueryRow(ctx,
		`SELECT thumbnail_failure_kind FROM memory_files WHERE id = $1`, fileID).Scan(&failureKind); err != nil {
		t.Fatalf("读取文件失败种类失败: %v", err)
	}
	if failureKind == nil || *failureKind != "remote_not_found" {
		t.Fatalf("thumbnail_failure_kind = %v, want remote_not_found", failureKind)
	}
}

func TestCleanupStaleRemoteTemporaryFilesRemovesOrphans(t *testing.T) {
	mediaRoot := t.TempDir()
	temporaryDir := filepath.Join(mediaRoot, "tmp")
	if err := os.MkdirAll(temporaryDir, 0o755); err != nil {
		t.Fatalf("创建 tmp 失败: %v", err)
	}
	staleDownload := filepath.Join(temporaryDir, ".source.tmp")
	staleProbe := filepath.Join(temporaryDir, ".browser-probe-x.media")
	active := filepath.Join(temporaryDir, "active-download.tmp")
	for _, path := range []string{staleDownload, staleProbe, active} {
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatalf("写入临时文件失败: %v", err)
		}
	}
	RegisterTemporaryPath(absPath(active))
	defer UnregisterTemporaryPath(absPath(active))

	if removed := CleanupStaleRemoteTemporaryFiles(mediaRoot); removed != 2 {
		t.Fatalf("removed = %d, want 2", removed)
	}
	if _, err := os.Stat(active); err != nil {
		t.Fatalf("活跃临时文件不应被删除: %v", err)
	}
}

func TestThumbnailPreheatRunnerSkipsOnDiskQuota(t *testing.T) {
	pool := servicesTestPool(t)
	ctx := context.Background()

	mediaRoot := t.TempDir()
	settings := testSettings()
	settings.MediaRoot = mediaRoot
	settings.BaiduAccessToken = "token"
	// 把文件数上限压到 0,模拟 tmp 已满。
	settings.RemoteThumbnailMaxTempFiles = 0
	settings.DerivativeConcurrencyLimit = 2
	settings.DerivativeQueueLimit = 4
	settings.DerivativeWaitTimeoutSec = 5
	settings.PreheatConcurrencyLimit = 2
	settings.PreheatQueueLimit = 4
	settings.PreheatWaitTimeoutSec = 5

	governor := NewTaskGovernor(settings)
	registry := NewThumbnailPreheatRegistry()
	runner := &ThumbnailPreheatRunner{
		Pool:     pool,
		Settings: settings,
		Governor: governor,
		Derivatives: &DerivativeTasks{
			Settings: settings,
			Governor: governor,
			InFlight: NewInFlightRegistry(governor.Metrics),
		},
		Registry: registry,
	}

	memoryID := uuid.New()
	fileID := uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO memories (id, title, kind, status, captured_at)
		 VALUES ($1, $2, $3, $4, now())`,
		memoryID, "容量不足", models.MemoryKindPhoto, models.MemoryStatusPublished); err != nil {
		t.Fatalf("插入 memory 失败: %v", err)
	}
	file := &models.MemoryFile{
		ID:                   fileID,
		MemoryID:             &memoryID,
		Source:               "baidupan",
		RemotePath:           "/remote/photo.jpg",
		RemoteID:             ptrString("424242"),
		MimeType:             "image/jpeg",
		Status:               models.MemoryFileStatusMatched,
		RemoteState:          models.RemoteFileStateReady,
		ThumbnailState:       models.RemoteThumbnailStateMissing,
		StreamState:          models.RemoteStreamStateReady,
		BrowserCompatibility: models.BrowserCompatibilityStateSupported,
	}
	if err := insertMemoryFile(ctx, pool, file); err != nil {
		t.Fatalf("插入 memory file 失败: %v", err)
	}

	job, started := registry.Start([]int{240}, nil, 0,
		settings.PreheatConcurrencyLimit, settings.PreheatQueueLimit, false)
	if !started {
		t.Fatal("预热任务应能启动")
	}
	runner.Run(job.ID)

	snapshot := registry.Snapshot(job.ID)
	if snapshot == nil {
		t.Fatal("任务快照丢失")
	}
	if snapshot.Status != PreheatJobCompleted {
		t.Fatalf("任务状态 = %q, want completed", snapshot.Status)
	}
	if snapshot.Failed != 0 || snapshot.Skipped != 1 {
		t.Fatalf("failed=%d skipped=%d, want 0/1", snapshot.Failed, snapshot.Skipped)
	}
	if snapshot.Message == nil ||
		!strings.Contains(*snapshot.Message, "reason=disk_quota") ||
		!strings.Contains(*snapshot.Message, "retry=clean_tmp_or_raise_disk_quota") {
		t.Fatalf("任务消息缺少 disk_quota 诊断, got %v", snapshot.Message)
	}

	// 环境性失败不能把文件写成 retryable,否则下一轮会被冷却期排除。
	var state string
	var kind *string
	if err := pool.QueryRow(ctx,
		`SELECT thumbnail_state::text, thumbnail_failure_kind FROM memory_files WHERE id = $1`,
		fileID).Scan(&state, &kind); err != nil {
		t.Fatalf("读取文件状态失败: %v", err)
	}
	if state != "missing" || kind != nil {
		t.Fatalf("文件状态 = (%v, %v), want (missing, nil)", state, kind)
	}
}
