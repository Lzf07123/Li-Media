// baidu_pan.go 对齐原 app/services/baidu_pan.py:网盘客户端、
// 直链缓存与进程级请求限速。直链绝不持久化、绝不进日志。
package services

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"limedia/backend/internal/config"
)

const MediaUserAgent = "netdisk; BaiduNetdisk"

// BaiduPanError 网盘返回不可用响应。
type BaiduPanError struct{ Msg string }

func (e *BaiduPanError) Error() string { return e.Msg }

func baiduPanError(msg string) error { return &BaiduPanError{Msg: msg} }

// ---- 进程级共享限速:所有客户端实例共同遵守请求间隔 ----

var (
	requestIntervalMu   sync.Mutex
	lastRequestAtUnixMs int64 = -1
)

func waitRequestInterval(intervalSeconds float64) {
	if intervalSeconds <= 0 {
		return
	}
	requestIntervalMu.Lock()
	defer requestIntervalMu.Unlock()
	now := time.Now().UnixMilli()
	if lastRequestAtUnixMs >= 0 {
		remaining := int64(intervalSeconds*1000) - (now - lastRequestAtUnixMs)
		if remaining > 0 {
			time.Sleep(time.Duration(remaining) * time.Millisecond)
			now = time.Now().UnixMilli()
		}
	}
	lastRequestAtUnixMs = now
}

// ---- DownloadUrlCache:直链进程内缓存,绝不落盘 ----

type DownloadUrlCache struct {
	mu         sync.Mutex
	ttlSeconds int
	maxEntries int
	urls       map[string]cacheEntry
	order      []string // FIFO 插入序(对齐 OrderedDict 赋值不改位置的行为)
}

type cacheEntry struct {
	url       string
	expiresAt time.Time // monotonic
}

func NewDownloadUrlCache(ttlSeconds, maxEntries int) *DownloadUrlCache {
	if maxEntries < 1 {
		maxEntries = 1
	}
	return &DownloadUrlCache{
		ttlSeconds: ttlSeconds,
		maxEntries: maxEntries,
		urls:       make(map[string]cacheEntry),
	}
}

func (c *DownloadUrlCache) Get(remoteID string) string {
	url, _ := c.GetEntry(remoteID)
	return url
}

// GetEntry 返回 (url, 剩余秒数);过期即清除。
func (c *DownloadUrlCache) GetEntry(remoteID string) (string, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.urls[remoteID]
	if !ok {
		return "", 0
	}
	if time.Since(entry.expiresAt) >= 0 {
		delete(c.urls, remoteID)
		c.removeOrder(remoteID)
		return "", 0
	}
	remaining := int(entry.expiresAt.Sub(time.Now()).Seconds())
	if remaining < 0 {
		remaining = 0
	}
	return entry.url, remaining
}

// Set 写入缓存并返回 url;TTL 提前 5 秒过期,容量 FIFO 淘汰。
func (c *DownloadUrlCache) Set(remoteID, rawURL string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ttlSeconds <= 0 {
		delete(c.urls, remoteID)
		c.removeOrder(remoteID)
		return rawURL
	}
	now := time.Now()
	for key, entry := range c.urls {
		if now.After(entry.expiresAt) {
			delete(c.urls, key)
			c.removeOrder(key)
		}
	}
	c.urls[remoteID] = cacheEntry{
		url:       rawURL,
		expiresAt: now.Add(time.Duration(maxInt(1, c.ttlSeconds-5)) * time.Second),
	}
	if _, exists := c.orderIndex(remoteID); !exists {
		c.order = append(c.order, remoteID)
	}
	for len(c.order) > c.maxEntries {
		evict := c.order[0]
		c.order = c.order[1:]
		delete(c.urls, evict)
	}
	return rawURL
}

func (c *DownloadUrlCache) Invalidate(remoteID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.urls, remoteID)
	c.removeOrder(remoteID)
}

func (c *DownloadUrlCache) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.urls = make(map[string]cacheEntry)
	c.order = nil
}

func (c *DownloadUrlCache) Size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.urls)
}

func (c *DownloadUrlCache) orderIndex(remoteID string) (int, bool) {
	for i, key := range c.order {
		if key == remoteID {
			return i, true
		}
	}
	return -1, false
}

func (c *DownloadUrlCache) removeOrder(remoteID string) {
	if i, ok := c.orderIndex(remoteID); ok {
		c.order = append(c.order[:i], c.order[i+1:]...)
	}
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// 全局缓存实例(main 装配;测试可独立构造)。
var DownloadURLCache = NewDownloadUrlCache(300, 256)

// ---- 远程条目 ----

type BaiduRemoteItem struct {
	RemoteID           string
	RemotePath         string
	Filename           string
	ParentPath         string
	IsDir              bool
	SizeBytes          *int64
	ModifiedAt         *time.Time
	MD5                *string
	Category           *string
	ThumbnailURL       *string
	RawMetadataSummary map[string]any
}

type BaiduListPage struct {
	Items     []*BaiduRemoteItem
	NextStart *int
}

// ---- 客户端 ----

type BaiduPanClient struct {
	settings    *config.Settings
	accessToken string
	httpClient  *http.Client
}

// NewBaiduPanClient 解析可用访问令牌;缺失即报错(与 Python 一致)。
func NewBaiduPanClient(settings *config.Settings) (*BaiduPanClient, error) {
	accessToken := GetBaiduAccessToken(context.Background(), settings)
	if accessToken == "" {
		return nil, baiduPanError("百度网盘访问凭证缺失")
	}
	return &BaiduPanClient{
		settings:    settings,
		accessToken: accessToken,
		httpClient:  &http.Client{Timeout: 30 * time.Second},
	}, nil
}

// ListPage 列目录一页。
func (c *BaiduPanClient) ListPage(ctx context.Context, remoteDir string, start int, limitOverride *int) (*BaiduListPage, error) {
	pageSize := c.settings.BaiduSyncPageSize
	if limitOverride != nil {
		pageSize = *limitOverride
	}
	payload, err := c.get(ctx, "file", map[string]any{
		"method": "list",
		"dir":    remoteDir,
		"limit":  pageSize,
		"start":  start,
		"web":    "1",
	})
	if err != nil {
		return nil, err
	}

	rawList, _ := payload["list"].([]any)
	items := make([]*BaiduRemoteItem, 0, len(rawList))
	for _, raw := range rawList {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		items = append(items, toRemoteItem(item))
	}
	page := &BaiduListPage{Items: items}
	if len(rawList) == pageSize {
		next := start + len(rawList)
		page.NextStart = &next
	}
	return page, nil
}

// GetFileMetadata filemetas 取元数据。
func (c *BaiduPanClient) GetFileMetadata(ctx context.Context, remoteID string) (*BaiduRemoteItem, error) {
	metadata, _, err := c.getFileMetadataWithDlink(ctx, remoteID)
	return metadata, err
}

// getFileMetadataWithDlink 一次 filemetas 同时取元数据与原始 dlink;
// dlink 含访问凭证,只在返回值里流转,绝不进持久化摘要或日志。
func (c *BaiduPanClient) getFileMetadataWithDlink(ctx context.Context, remoteID string) (*BaiduRemoteItem, string, error) {
	fsID, err := strconv.ParseInt(remoteID, 10, 64)
	if err != nil {
		return nil, "", baiduPanError("百度网盘文件 ID 无效")
	}
	fsids, _ := json.Marshal([]int64{fsID})
	payload, err := c.get(ctx, "multimedia", map[string]any{
		"method": "filemetas",
		"fsids":  string(fsids),
		"dlink":  "1",
		"thumb":  "1",
	})
	if err != nil {
		return nil, "", err
	}

	rawList, _ := payload["list"].([]any)
	if len(rawList) == 0 {
		return nil, "", baiduPanError("远程文件不存在")
	}
	files, _ := rawList[0].(map[string]any)
	if files == nil {
		return nil, "", baiduPanError("远程文件不存在")
	}
	dlink := ""
	if v, ok := files["dlink"].(string); ok {
		dlink = v
	}
	return toRemoteItem(files), dlink, nil
}

// GetThumbnail 取官方缩略图二进制。
func (c *BaiduPanClient) GetThumbnail(ctx context.Context, remoteID, requestedSize string) ([]byte, string, error) {
	metadata, err := c.GetFileMetadata(ctx, remoteID)
	if err != nil {
		return nil, "", err
	}
	if metadata.ThumbnailURL == nil {
		return nil, "", baiduPanError("远程缩略图不可用")
	}

	sizeMap := map[string]string{
		"small":  "c320_u320",
		"medium": "c640_u640",
		"large":  "c1280_u1280",
		"detail": "c1600_u1600",
	}
	size := sizeMap[requestedSize]
	if size == "" {
		size = c.settings.BaiduThumbnailSize
	}
	thumbnailURL := withRequestedThumbnailSize(*metadata.ThumbnailURL, size)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, thumbnailURL, nil)
	if err != nil {
		return nil, "", baiduPanError("远程缩略图请求失败")
	}
	req.Header.Set("User-Agent", "Li&Media")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, "", baiduPanError("远程缩略图请求失败")
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, "", transportError(resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", baiduPanError("远程缩略图请求失败")
	}
	contentType := resp.Header.Get("Content-Type")
	if idx := strings.Index(contentType, ";"); idx >= 0 {
		contentType = contentType[:idx]
	}
	if contentType == "" {
		contentType = "image/jpeg"
	}
	return body, contentType, nil
}

// OpenStream 打开远程流:返回 (状态码, content-length, content-range, content-type, body)。
// 直链不外泄;失败时使缓存失效。
func (c *BaiduPanClient) OpenStream(ctx context.Context, remoteID, rangeHeader string) (int, *int64, string, string, io.ReadCloser, error) {
	headers := map[string]string{"User-Agent": MediaUserAgent}
	if rangeHeader != "" {
		headers["Range"] = rangeHeader
	}

	rawDownloadURL, err := c.ResolveDownloadURL(ctx, remoteID)
	if err != nil {
		return 0, nil, "", "", nil, err
	}
	downloadURL := c.withCurrentAccessToken(rawDownloadURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		c.InvalidateDownloadURL(remoteID)
		return 0, nil, "", "", nil, baiduPanError("远程文件暂时无法读取")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		// 下载 URL 内嵌 access_token:不携带原始异常,避免凭证进日志。
		c.InvalidateDownloadURL(remoteID)
		return 0, nil, "", "", nil, baiduPanError("远程文件暂时无法读取")
	}
	if resp.StatusCode >= 400 {
		status := resp.StatusCode
		resp.Body.Close()
		c.InvalidateDownloadURL(remoteID)
		return 0, nil, "", "", nil, transportError(status)
	}

	var contentLength *int64
	if v := resp.Header.Get("Content-Length"); v != "" {
		if parsed, err := strconv.ParseInt(v, 10, 64); err == nil {
			contentLength = &parsed
		}
	}
	contentRange := resp.Header.Get("Content-Range")
	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	return resp.StatusCode, contentLength, contentRange, contentType, resp.Body, nil
}

// ResolveDownloadURL 缓存优先,冷缓存单次 filemetas 取 dlink。
func (c *BaiduPanClient) ResolveDownloadURL(ctx context.Context, remoteID string) (string, error) {
	if cached := DownloadURLCache.Get(remoteID); cached != "" {
		return cached, nil
	}
	metadata, dlink, err := c.getFileMetadataWithDlink(ctx, remoteID)
	if err != nil {
		return "", err
	}
	if hasLink, _ := metadata.RawMetadataSummary["has_download_link"].(bool); !hasLink || dlink == "" {
		return "", baiduPanError("未获取到可用的下载地址")
	}
	return DownloadURLCache.Set(remoteID, dlink), nil
}

func (c *BaiduPanClient) InvalidateDownloadURL(remoteID string) {
	DownloadURLCache.Invalidate(remoteID)
}

// ResolveDirectURL 签发短时直链:缓存命中先探测,未命中重新解析并探测。
func (c *BaiduPanClient) ResolveDirectURL(ctx context.Context, remoteID string) (string, int, error) {
	if url, ttl := DownloadURLCache.GetEntry(remoteID); url != "" {
		if probeDirectURL(ctx, url) {
			return c.withCurrentAccessToken(url), ttl, nil
		}
		c.InvalidateDownloadURL(remoteID)
	}

	rawURL, err := c.ResolveDownloadURL(ctx, remoteID)
	if err != nil {
		return "", 0, err
	}
	ttl := c.settings.BaiduDownloadURLTTLSec
	if _, cachedTTL := DownloadURLCache.GetEntry(remoteID); cachedTTL > 0 || DownloadURLCache.Get(remoteID) != "" {
		ttl = cachedTTL
	}
	directURL := c.withCurrentAccessToken(rawURL)

	if !probeDirectURL(ctx, directURL) {
		c.InvalidateDownloadURL(remoteID)
		return "", 0, baiduPanError("百度网盘媒体直链被拒绝（403）")
	}
	return directURL, ttl, nil
}

// probeDirectURL Range 首字节探测,200/206 视为可用。
func probeDirectURL(ctx context.Context, rawURL string) bool {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return false
	}
	req.Header.Set("Range", "bytes=0-0")
	req.Header.Set("User-Agent", MediaUserAgent)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64))
	return resp.StatusCode == 200 || resp.StatusCode == 206
}

func toRemoteItem(item map[string]any) *BaiduRemoteItem {
	remotePath, _ := item["path"].(string)
	parentPath := path.Dir(remotePath)
	parentPath = strings.TrimSuffix(parentPath, "/")
	if parentPath == "" || parentPath == "." {
		parentPath = "/"
	}
	filename, _ := item["server_filename"].(string)
	if filename == "" {
		filename = path.Base(remotePath)
	}

	result := &BaiduRemoteItem{
		RemotePath: remotePath,
		Filename:   filename,
		ParentPath: "",
	}
	if parentPath != "/" {
		result.ParentPath = parentPath
	}

	if fsID, ok := item["fs_id"]; ok {
		result.RemoteID = fmt.Sprintf("%v", fsID)
	}
	isDir := false
	if v, ok := item["isdir"].(float64); ok && int(v) == 1 {
		isDir = true
	}
	result.IsDir = isDir

	if v, ok := item["size"].(float64); ok {
		size := int64(v)
		result.SizeBytes = &size
	}
	if v, ok := item["server_mtime"].(float64); ok {
		at := time.Unix(int64(v), 0).UTC()
		result.ModifiedAt = &at
	}
	if v, ok := item["md5"].(string); ok && v != "" {
		result.MD5 = &v
	}
	if v, ok := item["category"]; ok && v != nil {
		s := fmt.Sprintf("%v", v)
		result.Category = &s
	}
	result.ThumbnailURL = extractThumbnailURL(item)
	hasDownloadLink := false
	if _, ok := item["dlink"]; ok {
		hasDownloadLink = true
	}

	summary := map[string]any{
		"fs_id":             result.RemoteID,
		"is_dir":            isDir,
		"has_thumbnail":     result.ThumbnailURL != nil,
		"has_download_link": hasDownloadLink,
	}
	if v, ok := item["category"]; ok {
		summary["category"] = v
	}
	if v, ok := item["md5"]; ok {
		summary["md5"] = v
	}
	if v, ok := item["server_mtime"]; ok {
		summary["mtime"] = v
	}
	if v, ok := item["size"]; ok {
		summary["size"] = v
	}
	result.RawMetadataSummary = summary
	return result
}

func extractThumbnailURL(item map[string]any) *string {
	if thumbs, ok := item["thumbs"].(map[string]any); ok {
		for _, key := range []string{"url", "icon"} {
			if v, ok := thumbs[key].(string); ok && v != "" {
				return &v
			}
		}
	}
	for _, key := range []string{"thumb_url", "thumbnail", "thumbnail_url"} {
		if v, ok := item[key].(string); ok && v != "" {
			return &v
		}
	}
	return nil
}

// withRequestedThumbnailSize 覆盖/追加 size 查询参数。
func withRequestedThumbnailSize(rawURL, size string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	query := parsed.Query()
	query.Set("size", size)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func (c *BaiduPanClient) withCurrentAccessToken(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	if parsed.Query().Get("access_token") != "" {
		return rawURL
	}
	query := parsed.Query()
	query.Set("access_token", c.accessToken)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

// get 网盘 API 请求:进程级限速 + 重试退避 + errno 判定。
func (c *BaiduPanClient) get(ctx context.Context, resource string, params map[string]any) (map[string]any, error) {
	attempts := c.settings.BaiduRetryAttempts
	if attempts < 1 {
		attempts = 1
	}

	var lastStatusErr int
	for attempt := 0; attempt < attempts; attempt++ {
		waitRequestInterval(c.settings.BaiduRequestIntervalSec)

		query := url.Values{}
		for k, v := range params {
			query.Set(k, fmt.Sprintf("%v", v))
		}
		query.Set("access_token", c.accessToken)

		req, err := http.NewRequestWithContext(ctx, http.MethodGet,
			fmt.Sprintf("%s/%s?%s", c.settings.BaiduAPIBaseURL, resource, query.Encode()), nil)
		if err != nil {
			return nil, baiduPanError("百度网盘请求失败")
		}
		req.Header.Set("User-Agent", "Li&Media")

		resp, err := c.httpClient.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			sleepBackoff(c.settings, attempt)
			continue
		}

		body, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			sleepBackoff(c.settings, attempt)
			continue
		}

		if resp.StatusCode >= 400 {
			lastStatusErr = resp.StatusCode
			if resp.StatusCode == 429 || resp.StatusCode == 500 ||
				resp.StatusCode == 502 || resp.StatusCode == 503 || resp.StatusCode == 504 {
				sleepBackoff(c.settings, attempt)
				continue
			}
			// 请求 URL 含 access_token:不携带响应细节,防凭证泄漏。
			return nil, transportError(resp.StatusCode)
		}

		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			sleepBackoff(c.settings, attempt)
			continue
		}
		if errno, _ := payload["errno"].(float64); errno != 0 {
			return nil, apiError(int(errno))
		}
		return payload, nil
	}

	_ = lastStatusErr
	return nil, baiduPanError("百度网盘请求失败")
}

func sleepBackoff(settings *config.Settings, attempt int) {
	delay := settings.BaiduRetryBaseDelaySec * pow2(attempt)
	if delay > settings.BaiduRetryMaxDelaySec {
		delay = settings.BaiduRetryMaxDelaySec
	}
	if delay > 0 {
		time.Sleep(time.Duration(delay * float64(time.Second)))
	}
}

func pow2(n int) float64 {
	result := 1.0
	for i := 0; i < n; i++ {
		result *= 2
	}
	return result
}

func apiError(errno int) error {
	switch errno {
	case -6:
		return baiduPanError("百度网盘访问凭证无效、过期或授权范围不足")
	case 111:
		return baiduPanError("百度网盘访问凭证已过期，请重新授权")
	default:
		return baiduPanError(fmt.Sprintf("百度网盘返回错误 %d", errno))
	}
}

func transportError(statusCode int) error {
	switch statusCode {
	case 401, 403:
		return baiduPanError("百度网盘访问凭证无效或已过期")
	case 429:
		return baiduPanError("百度网盘接口限流，请稍后重试")
	case 404:
		return baiduPanError("远程文件不存在")
	default:
		return baiduPanError("远程媒体暂时无法读取")
	}
}
