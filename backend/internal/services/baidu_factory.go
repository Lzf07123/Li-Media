package services

import (
	"limedia/backend/internal/config"
)

// BaiduPanClientFactory 每请求构造客户端(构造时解析访问令牌,
// 与 Python 版 BaiduPanClient(settings) 行为一致)。
type BaiduPanClientFactory struct {
	Settings *config.Settings
}

// New 构造客户端;凭证缺失返回 BaiduPanError(502 语义)。
func (f *BaiduPanClientFactory) New() (*BaiduPanClient, error) {
	return NewBaiduPanClient(f.Settings)
}
