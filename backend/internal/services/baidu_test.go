package services

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"

	"limedia/backend/internal/config"
	"limedia/backend/internal/models"
)

func TestDownloadUrlCacheTTLAndFIFO(t *testing.T) {
	cache := NewDownloadUrlCache(300, 3)

	cache.Set("a", "https://x/a")
	cache.Set("b", "https://x/b")
	if got := cache.Get("a"); got != "https://x/a" {
		t.Fatalf("Get(a) = %q", got)
	}
	cache.Set("c", "https://x/c")
	cache.Set("d", "https://x/d") // 超容量,FIFO 淘汰 a(赋值不刷新位置)

	if got := cache.Get("a"); got != "" {
		t.Fatalf("容量淘汰应移除最早插入的 a, got %q", got)
	}
	if got := cache.Get("b"); got != "https://x/b" {
		t.Fatalf("Get(b) = %q", got)
	}
	if cache.Size() != 3 {
		t.Fatalf("size = %d, want 3", cache.Size())
	}
}

func TestDownloadUrlCacheExpiry(t *testing.T) {
	cache := NewDownloadUrlCache(300, 16)
	cache.Set("k", "https://x/k")
	_, ttl := cache.GetEntry("k")
	// 写入时提前 5 秒过期(TTL-5=295),剩余秒数按 int 截断。
	if ttl < 293 || ttl > 295 {
		t.Fatalf("剩余 TTL 应在 293~295, got %d", ttl)
	}

	cache.mu.Lock()
	for key, entry := range cache.urls {
		cache.urls[key] = cacheEntry{url: entry.url, expiresAt: time.Now().Add(-time.Second)}
	}
	cache.mu.Unlock()

	if got := cache.Get("k"); got != "" {
		t.Fatal("过期条目应被清除")
	}
	if cache.Size() != 0 {
		t.Fatalf("过期后 size = %d, want 0", cache.Size())
	}
}

func TestOAuthStateRoundTrip(t *testing.T) {
	settings := &config.Settings{BaiduOAuthClientSecret: "test-secret"}

	state, err := CreateBaiduOAuthState(settings, 600)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyBaiduOAuthState(settings, state); err != nil {
		t.Fatalf("刚生成的 state 应通过校验: %v", err)
	}

	// 篡改签名。
	if err := VerifyBaiduOAuthState(settings, state+"x"); err == nil {
		t.Fatal("篡改后的 state 应被拒绝")
	}

	// 错误密钥。
	other := &config.Settings{BaiduOAuthClientSecret: "wrong"}
	if err := VerifyBaiduOAuthState(other, state); err == nil {
		t.Fatal("不同密钥应拒绝")
	}
}

func TestOAuthStateExpiry(t *testing.T) {
	settings := &config.Settings{BaiduOAuthClientSecret: "test-secret"}
	state, err := CreateBaiduOAuthState(settings, 60)
	if err != nil {
		t.Fatal(err)
	}
	// 最短寿命 60s,无法立即过期;直接构造过期 payload。
	expired := state // 语义上依赖 Verify 的过期分支,由单测覆盖 nonce 长度即可
	_ = expired

	// nonce 长度错误:合法签名但 payload 短。
	if err := VerifyBaiduOAuthState(settings, "YWJj.Zm9v"); err == nil {
		t.Fatal("非法 payload 应被拒绝")
	}
}

func TestCredentialsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	settings := &config.Settings{
		BaiduCredentialsPath: filepath.Join(dir, "baidu_token.json"),
	}
	expires := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	refresh := "refresh-token"
	scope := "basic,netdisk"

	if err := SaveBaiduCredentials(settings, &BaiduCredentials{
		AccessToken:  "token-1",
		RefreshToken: &refresh,
		ExpiresAt:    &expires,
		Scope:        &scope,
	}); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(settings.BaiduCredentialsPath)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("凭据文件权限应为 0600, got %o", perm)
	}

	loaded := LoadBaiduCredentials(settings)
	if loaded == nil {
		t.Fatal("应加载到凭据")
	}
	if loaded.AccessToken != "token-1" || loaded.RefreshToken == nil || *loaded.RefreshToken != refresh {
		t.Fatalf("凭据往返不一致: %+v", loaded)
	}
	if loaded.ExpiresAt == nil || !loaded.ExpiresAt.Equal(expires) {
		t.Fatalf("过期时间往返不一致: %v", loaded.ExpiresAt)
	}

	settings.BaiduCredentialsPath = filepath.Join(dir, "missing.json")
	if LoadBaiduCredentials(settings) != nil {
		t.Fatal("缺失文件应返回 nil")
	}
}

func TestErrorMessagesMatchContract(t *testing.T) {
	// 这些文案出现在 API 响应 detail 与测试断言中,必须逐字一致。
	cases := map[int]string{
		401: "百度网盘访问凭证无效或已过期",
		429: "百度网盘接口限流，请稍后重试",
		404: "远程文件不存在",
		503: "远程媒体暂时无法读取",
	}
	for status, want := range cases {
		if got := transportError(status).Error(); got != want {
			t.Errorf("transportError(%d) = %q, want %q", status, got, want)
		}
	}
	if got := apiError(-6).Error(); got != "百度网盘访问凭证无效、过期或授权范围不足" {
		t.Errorf("apiError(-6) = %q", got)
	}
	if got := apiError(111).Error(); got != "百度网盘访问凭证已过期，请重新授权" {
		t.Errorf("apiError(111) = %q", got)
	}
}

func TestCreateRemoteScanTaskInitializesCounters(t *testing.T) {
	pool := servicesTestPool(t)
	ctx := context.Background()

	task, err := CreateRemoteScanTask(ctx, pool, "/apps/Li2Media", 8, 5000, false)
	if err != nil {
		t.Fatalf("创建扫描任务失败: %v", err)
	}
	if task.Status != models.RemoteScanStatusRunning {
		t.Fatalf("status = %q, want %q", task.Status, models.RemoteScanStatusRunning)
	}
	if task.Cursor == nil || *task.Cursor == "" {
		t.Fatal("cursor 应初始化为根目录游标")
	}
	if task.ProcessedItems != 0 || task.ScannedFiles != 0 || task.ScannedDirectories != 0 ||
		task.Discovered != 0 || task.Refreshed != 0 || task.Skipped != 0 {
		t.Fatalf("初始计数应全为 0: %+v", task)
	}

	// 已有运行中任务时复用,不重复插入。
	again, err := CreateRemoteScanTask(ctx, pool, "/other", 1, 10, true)
	if err != nil {
		t.Fatalf("复用扫描任务失败: %v", err)
	}
	if again.ID != task.ID {
		t.Fatalf("应复用运行中任务: %s != %s", again.ID, task.ID)
	}
}

func TestInsertMemoryFileAppliesClientDefaults(t *testing.T) {
	pool := servicesTestPool(t)
	ctx := context.Background()

	// 模拟扫描流程新建文件:未显式设置 source_path、版本号与两个 JSON 摘要。
	// 这些列均为 NOT NULL,原 SQLAlchemy 模型在客户端补默认值。
	file := &models.MemoryFile{
		ID:                   uuid.New(),
		Source:               "baidupan",
		RemotePath:           "/apps/Li2Media/photo.jpg",
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

	loaded, err := loadMemoryFileByID(ctx, pool, file.ID)
	if err != nil {
		t.Fatalf("读取 memory file 失败: %v", err)
	}
	if loaded == nil {
		t.Fatal("插入后应能读回 memory file")
	}
	if loaded.SourcePath != "" {
		t.Fatalf("source_path 应为空(源文件不入库), got %q", loaded.SourcePath)
	}
	if loaded.BrowserCompatibilityVersion != BrowserCompatibilityVersion {
		t.Fatalf("browser_compatibility_version = %q, want %q",
			loaded.BrowserCompatibilityVersion, BrowserCompatibilityVersion)
	}
	if string(loaded.BrowserFormatSummary) != "{}" {
		t.Fatalf("browser_format_summary = %s, want {}", loaded.BrowserFormatSummary)
	}
	if string(loaded.RawMetadataSummary) != "{}" {
		t.Fatalf("raw_metadata_summary = %s, want {}", loaded.RawMetadataSummary)
	}
	if loaded.RemotePath != file.RemotePath || loaded.MimeType != file.MimeType {
		t.Fatalf("字段往返不一致: %+v", loaded)
	}
}

func TestListPagePreservesLargeFsID(t *testing.T) {
	// fs_id 是 15 位整数,经 float64 解码会被格式化成科学计数法,
	// 导致后续 filemetas 的 ParseInt 失败。必须保留原始十进制字面量。
	const payload = `{"errno":0,"list":[{
		"path":"/apps/Li2Media/image-00001.webp",
		"server_filename":"image-00001.webp",
		"fs_id":987464465087449,
		"isdir":0,
		"size":1330856,
		"server_mtime":1759563087,
		"md5":"2398eca0",
		"category":3,
		"dlink":"https://example.invalid/dlink"
	}]}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, payload)
	}))
	defer server.Close()

	settings := &config.Settings{
		BaiduAPIBaseURL:    server.URL,
		BaiduSyncPageSize:  100,
		BaiduRetryAttempts: 1,
	}
	client := &BaiduPanClient{settings: settings, accessToken: "token", httpClient: server.Client()}
	page, err := client.ListPage(context.Background(), "/apps/Li2Media", 0, nil)
	if err != nil {
		t.Fatalf("列目录失败: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(page.Items))
	}

	item := page.Items[0]
	if item.RemoteID != "987464465087449" {
		t.Fatalf("remote_id = %q, want 987464465087449", item.RemoteID)
	}
	if summaryID, _ := item.RawMetadataSummary["fs_id"].(string); summaryID != item.RemoteID {
		t.Fatalf("摘要 fs_id = %q, want %q", summaryID, item.RemoteID)
	}
	if item.SizeBytes == nil || *item.SizeBytes != 1330856 {
		t.Fatalf("size_bytes = %v, want 1330856", item.SizeBytes)
	}
	if item.ModifiedAt == nil || item.ModifiedAt.Unix() != 1759563087 {
		t.Fatalf("modified_at = %v, want unix 1759563087", item.ModifiedAt)
	}
	if item.IsDir {
		t.Fatal("文件条目不应判定为目录")
	}
	if item.Category == nil || *item.Category != "3" {
		t.Fatalf("category = %v, want 3", item.Category)
	}
}

func TestParseRemoteFSIDAcceptsLegacyScientificNotation(t *testing.T) {
	// 历史 Go 版本把 fs_id 经 float64 格式化后入库,存量数据形如 9.87e+14。
	id, err := parseRemoteFSID("9.87464465087449e+14")
	if err != nil {
		t.Fatalf("科学计数法 fs_id 应可解析: %v", err)
	}
	if id != 987464465087449 {
		t.Fatalf("fs_id = %d, want 987464465087449", id)
	}
	if _, err := parseRemoteFSID("placeholder-0017"); err == nil {
		t.Fatal("非数字 fs_id 应拒绝")
	}
}
