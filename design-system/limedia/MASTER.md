# Li&Media Master

> 实现速览。当前版本是基础骨架，页面优先保证结构、状态和无障碍可用。
> 相关：[BRAND.md](BRAND.md) · `frontend/src/index.css`

## 技术栈

- React 19 + TypeScript
- Vite 7
- Tailwind CSS 4
- React Router 7
- lucide-react

## 令牌

- 文件：`frontend/src/index.css`
- 前缀：`--limedia-*`
- 主题：基于 `.dark` class 的明暗双主题
- 语义层：`background / surface / foreground / muted / border / primary / secondary / success / warning / destructive`

## 组件

| 组件 | 状态 | 说明 |
| --- | --- | --- |
| SiteHeader | 已落基础版 | 品牌位、主导航、sticky surface |
| SiteFooter | 已落基础版 | 品牌名、站点描述 |
| MemoryCard | 已落基础版 | 缩略图、标题、拍摄时间/类型、空缩略图占位 |
| HomePage | 已落基础版 | 加载骨架、空状态、错误状态、媒体网格 |
| MediaDetailPage | 已落基础版 | 海报、标题、原名、简介 |
| NotFoundPage | 已落基础版 | 404 状态 |

## 页面模式

1. **首页**：标题 + slogan + 媒体网格；加载中显示骨架，空库显示空状态。
2. **详情页**：左侧缩略图，右侧说明和拍摄信息；后续扩展文件与播放区。
3. **后台**：后续落在独立路由，公开站和后台不共用复杂页面结构。

## 验证

```bash
cd frontend
npm run typecheck
npm run build
```

上线前还需检查：

- 明暗主题下正文对比度均达到 AA。
- 键盘焦点可见。
- 移动端不出现横向滚动。
- 空状态、加载状态、错误状态均可见。
