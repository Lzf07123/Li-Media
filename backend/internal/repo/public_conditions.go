// public_conditions.go 把 display_health.go 的 SQL 谓词构建器以导出包装
// 暴露给 services 层(admin 聚合、系统状态与预热统计复用同一口径)。
// 只包装既有未导出的 sqlBuilder,不改变任何谓词语义。
package repo

// SQLCond 公开口径谓词的导出包装:跨包组装带参数编号的 WHERE 片段,
// 参数按调用顺序累积,由 Args() 统一取回。
type SQLCond struct {
	b *sqlBuilder
}

// NewSQLCond 新建谓词构建器。
func NewSQLCond() *SQLCond { return &SQLCond{b: &sqlBuilder{}} }

// Placeholder 登记参数并返回 $N 占位符。
func (c *SQLCond) Placeholder(v any) string { return c.b.placeholder(v) }

// Args 已登记参数,按占位符顺序。
func (c *SQLCond) Args() []any { return c.b.args }

// DisplayableFilesCondition 有可用公开表面的文件谓词(别名 m/f)。
func (c *SQLCond) DisplayableFilesCondition() string {
	return c.b.displayableFilesCondition()
}

// BrowserPlayableFilesCondition 公开口径仅排除 unsupported 与 unknown 的视频。
func (c *SQLCond) BrowserPlayableFilesCondition() string {
	return c.b.browserPlayableFilesCondition()
}

// PublicFilesCondition 展示健康与浏览器兼容双双通过才可公开。
func (c *SQLCond) PublicFilesCondition() string {
	return c.b.PublicFilesCondition()
}

// HomeDerivativeReadyCondition 首页尺寸派生图已持久化就绪(别名 m/f)。
func (c *SQLCond) HomeDerivativeReadyCondition(derivativeVersion string, maxSize int) string {
	return c.b.HomeDerivativeReadyCondition(derivativeVersion, maxSize)
}
