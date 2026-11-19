// baidu_oauth.go 对齐原 app/services/baidu_oauth.py:授权 state 签名、
// 凭据持久化与访问令牌刷新。错误文案与 Python 版逐字一致(出现在响应里)。
package services

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"limedia/backend/internal/config"
)

// BaiduOAuthError OAuth 无法产出可用凭证。
type BaiduOAuthError struct{ Msg string }

func (e *BaiduOAuthError) Error() string { return e.Msg }

func oauthError(msg string) error { return &BaiduOAuthError{Msg: msg} }

// BaiduCredentials 百度网盘访问凭证。
type BaiduCredentials struct {
	AccessToken  string     `json:"access_token"`
	RefreshToken *string    `json:"refresh_token"`
	ExpiresAt    *time.Time `json:"expires_at"`
	Scope        *string    `json:"scope"`
}

// CreateBaiduOAuthState 生成一次性授权 state:nonce.过期时间戳,HMAC-SHA256 签名。
func CreateBaiduOAuthState(settings *config.Settings, lifetimeSeconds int) (string, error) {
	secret, err := stateSecret(settings)
	if err != nil {
		return "", err
	}
	if lifetimeSeconds < 60 {
		lifetimeSeconds = 60
	}
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("生成授权 state 失败: %w", err)
	}
	expiresAt := time.Now().Add(time.Duration(lifetimeSeconds) * time.Second).Unix()
	payload := []byte(hex.EncodeToString(nonce) + "." + strconv.FormatInt(expiresAt, 10))
	mac := hmac.New(sha256.New, secret)
	mac.Write(payload)
	signature := mac.Sum(nil)

	return base64.RawURLEncoding.EncodeToString(payload) + "." +
		base64.RawURLEncoding.EncodeToString(signature), nil
}

// VerifyBaiduOAuthState 校验 state:签名、nonce 长度与有效期。
func VerifyBaiduOAuthState(settings *config.Settings, state string) error {
	secret, err := stateSecret(settings)
	if err != nil {
		return err
	}
	encodedPayload, encodedSignature, found := strings.Cut(state, ".")
	if !found || strings.LastIndex(encodedPayload, ".") >= 0 {
		return oauthError("百度网盘授权状态无效")
	}
	payload, err1 := base64.RawURLEncoding.DecodeString(encodedPayload)
	signature, err2 := base64.RawURLEncoding.DecodeString(encodedSignature)
	if err1 != nil || err2 != nil {
		return oauthError("百度网盘授权状态无效")
	}

	mac := hmac.New(sha256.New, secret)
	mac.Write(payload)
	if subtle.ConstantTimeCompare(signature, mac.Sum(nil)) != 1 {
		return oauthError("百度网盘授权状态无效")
	}

	parts := strings.SplitN(string(payload), ".", 2)
	if len(parts) != 2 {
		return oauthError("百度网盘授权状态无效")
	}
	nonce, err := hex.DecodeString(parts[0])
	if err != nil || len(nonce) != 32 {
		return oauthError("百度网盘授权状态无效")
	}
	expiresAt, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || time.Now().Unix() >= expiresAt {
		return oauthError("百度网盘授权状态无效或已过期")
	}
	return nil
}

// BuildBaiduAuthorizeURL 拼接授权页地址。
func BuildBaiduAuthorizeURL(settings *config.Settings, state string) (string, error) {
	if settings.BaiduOAuthClientID == "" {
		return "", oauthError("百度网盘 OAuth AppKey 未配置")
	}
	params := url.Values{
		"response_type": {"code"},
		"client_id":     {settings.BaiduOAuthClientID},
		"redirect_uri":  {baiduRedirectURI(settings)},
		"scope":         {settings.BaiduOAuthScope},
		"display":       {"page"},
		"state":         {state},
	}
	return settings.BaiduOAuthAuthorizeURL + "?" + params.Encode(), nil
}

// ExchangeBaiduCode 用授权码换凭据。
func ExchangeBaiduCode(ctx context.Context, settings *config.Settings, code string) (*BaiduCredentials, error) {
	payload, err := requestToken(ctx, settings, map[string]string{
		"grant_type":   "authorization_code",
		"code":         code,
		"redirect_uri": baiduRedirectURI(settings),
	})
	if err != nil {
		return nil, err
	}
	return credentialsFromPayload(payload)
}

// LoadBaiduCredentials 从凭据文件加载;不存在或无效返回 nil。
func LoadBaiduCredentials(settings *config.Settings) *BaiduCredentials {
	data, err := os.ReadFile(settings.BaiduCredentialsPath)
	if err != nil {
		return nil
	}
	var raw struct {
		AccessToken  string     `json:"access_token"`
		RefreshToken *string    `json:"refresh_token"`
		ExpiresAt    *string    `json:"expires_at"`
		Scope        *string    `json:"scope"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil
	}
	if raw.AccessToken == "" {
		return nil
	}
	return &BaiduCredentials{
		AccessToken:  raw.AccessToken,
		RefreshToken: raw.RefreshToken,
		ExpiresAt:    parseFlexibleTime(raw.ExpiresAt),
		Scope:        raw.Scope,
	}
}

// GetBaiduAccessToken 取可用访问令牌:文件凭据优先,临期则刷新,
// 刷新失败回退文件内令牌(与 Python 版一致)。
func GetBaiduAccessToken(ctx context.Context, settings *config.Settings) string {
	credentials := LoadBaiduCredentials(settings)
	if credentials == nil {
		return settings.BaiduAccessToken
	}

	needsRefresh := credentials.ExpiresAt != nil &&
		credentials.ExpiresAt.Before(time.Now().Add(60*time.Second)) &&
		credentials.RefreshToken != nil
	if !needsRefresh {
		return credentials.AccessToken
	}

	refreshed, err := requestToken(ctx, settings, map[string]string{
		"grant_type":    "refresh_token",
		"refresh_token": *credentials.RefreshToken,
	})
	if err != nil {
		return credentials.AccessToken
	}
	newCredentials, err := credentialsFromPayload(refreshed)
	if err != nil {
		return credentials.AccessToken
	}
	if err := SaveBaiduCredentials(settings, newCredentials); err != nil {
		return credentials.AccessToken
	}
	return newCredentials.AccessToken
}

// SaveBaiduCredentials 原子落盘:临时文件 fsync 后 rename,权限 0600。
func SaveBaiduCredentials(settings *config.Settings, credentials *BaiduCredentials) error {
	path := settings.BaiduCredentialsPath
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("创建凭据目录失败: %w", err)
	}
	temporaryPath := filepath.Join(filepath.Dir(path),
		fmt.Sprintf(".%s.%d.tmp", filepath.Base(path), os.Getpid()))

	content, err := json.Marshal(map[string]any{
		"access_token":  credentials.AccessToken,
		"refresh_token": credentials.RefreshToken,
		"expires_at":    formatTime(credentials.ExpiresAt),
		"scope":         credentials.Scope,
		"updated_at":    formatTime(ptrTime(time.Now())),
	})
	if err == nil {
		err = os.WriteFile(temporaryPath, content, 0o600)
		if err == nil {
			err = os.Rename(temporaryPath, path)
		}
	}
	_ = os.Remove(temporaryPath)
	if err != nil {
		return fmt.Errorf("写入凭据失败: %w", err)
	}
	return nil
}

func requestToken(ctx context.Context, settings *config.Settings, payload map[string]string) (map[string]any, error) {
	if settings.BaiduOAuthClientID == "" || settings.BaiduOAuthClientSecret == "" {
		return nil, oauthError("百度网盘 OAuth AppKey/SecretKey 未配置")
	}
	params := url.Values{}
	for k, v := range payload {
		params.Set(k, v)
	}
	params.Set("client_id", settings.BaiduOAuthClientID)
	params.Set("client_secret", settings.BaiduOAuthClientSecret)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		settings.BaiduOAuthTokenURL+"?"+params.Encode(), nil)
	if err != nil {
		return nil, oauthError("百度网盘授权服务暂时不可用")
	}
	req.Header.Set("User-Agent", "Li&Media")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, oauthError("百度网盘授权服务暂时不可用")
	}
	defer resp.Body.Close()

	// 请求 URL 含 client_secret:错误不携带响应细节,防凭证进日志。
	if resp.StatusCode >= 400 {
		return nil, oauthError("百度网盘授权服务返回错误")
	}
	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, oauthError("百度网盘授权服务暂时不可用")
	}
	if _, hasError := result["error"]; hasError {
		return nil, oauthError("百度网盘授权被拒绝，请检查应用配置和权限")
	}
	if _, ok := result["access_token"]; !ok {
		return nil, oauthError("百度网盘授权服务未返回访问凭证")
	}
	return result, nil
}

func credentialsFromPayload(payload map[string]any) (*BaiduCredentials, error) {
	accessToken, _ := payload["access_token"].(string)
	if accessToken == "" {
		return nil, oauthError("百度网盘授权服务未返回访问凭证")
	}
	credentials := &BaiduCredentials{AccessToken: accessToken}
	if v, ok := payload["refresh_token"]; ok {
		if s := fmt.Sprintf("%v", v); s != "" && s != "<nil>" {
			credentials.RefreshToken = &s
		}
	}
	if expiresIn, ok := payload["expires_in"].(float64); ok {
		at := time.Now().Add(time.Duration(expiresIn) * time.Second)
		credentials.ExpiresAt = &at
	}
	if v, ok := payload["scope"]; ok && v != nil {
		if s := fmt.Sprintf("%v", v); s != "" {
			credentials.Scope = &s
		}
	}
	return credentials, nil
}

func baiduRedirectURI(settings *config.Settings) string {
	if settings.BaiduOAuthRedirectURI != "" {
		return settings.BaiduOAuthRedirectURI
	}
	return strings.TrimRight(settings.PublicBaseURL, "/") + "/admin/baidu/callback"
}

func stateSecret(settings *config.Settings) ([]byte, error) {
	// 不回退到 admin_token:授权 state 的签名密钥必须独立且足够强,
	// 复用管理令牌会把两个安全域耦合在一起。
	if settings.BaiduOAuthClientSecret == "" {
		return nil, oauthError("百度网盘授权签名密钥未配置")
	}
	return []byte(settings.BaiduOAuthClientSecret), nil
}

func parseFlexibleTime(value *string) *time.Time {
	if value == nil || *value == "" {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339, *value)
	if err != nil {
		return nil
	}
	return &parsed
}

func formatTime(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format(time.RFC3339Nano)
	return &s
}

func ptrTime(t time.Time) *time.Time { return &t }

var _ = errors.New // 保留 errors 导入位(部分分支未使用时保持编译稳定)
