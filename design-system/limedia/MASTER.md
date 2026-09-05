# Li&Media Master

> 版本：V1.0 ｜ 日期：2026-09-05 ｜ 状态：实现快照。与代码冲突时以代码为准，并回写本文档。
> 相关：[BRAND.md](BRAND.md) · `frontend/src/index.css` · `frontend/src/lib/brand.ts`

## 技术栈与路由

- React 19 + TypeScript + Vite 7 + Tailwind CSS 4 + React Router 7 + lucide-react。
- 路由：`/`（回忆库）、`/memories/:memoryId`（回忆详情）、`/admin`（后台）、`*`（404）。
- API：`/api/v1/memories`、`/api/v1/memories/:id`、`/api/v1/memories/:id/file`、`/api/v1/admin/memories`。

## 令牌快照

- 文件：`frontend/src/index.css`，是颜色、阴影、缓动和动效时长唯一事实来源。
- 前缀：`--limedia-*`；主题：`:root` 浅色、`.dark` 深色。
- 语义层：background / surface / surface-2 / foreground / muted / border / primary / secondary / success / warning / destructive / ring / 六组 accent。
- 辅助层：`--limedia-shadow-*`、`--limedia-ease-*`、`--limedia-motion-*`、`--limedia-glass-*`、`--limedia-aurora-*`、`--limedia-tech-*`、`--limedia-flow-gradient`。
- Tailwind 组件只引用 `bg-primary`、`text-muted`、`border-border`、`.card` 等语义类；不硬编码颜色值。
- 深色带文字软底使用 `--limedia-*-soft-solid` 与 `--limedia-*-soft-fg`。

## 组件快照

| 类别 | 组件 / 类 |
| --- | --- |
| 交互控件 | `Button`、`IconButton`、`Input`、`TextArea`、`DropdownMenu`、`Pagination` |
| 反馈 | `Badge`、`StatusBadge`、`FileStatusBadge`、`Notice`、`Toast`、`Modal`、`ProgressBar`、`EmptyState`、`MediaSkeleton` |
| 内容组件 | `MemoryCard`、`PhotoPreview`、`VideoPlayer`、`MemoryUploadForm`、`AdminLoginCard` |
| 外壳 | `SiteHeader`、`SiteFooter`、`BackToTop`、`Breadcrumb` |

## 页面与状态

| 页面 | 关键状态 |
| --- | --- |
| `HomePage` | 关键词搜索、类型导航、分页、骨架屏、加载失败、空库、搜索空态、真实封面瀑布流 |
| `MemoryDetailPage` | 加载骨架、照片预览或视频播放、说明、拍摄信息、文件信息、404 |
| `AdminPage` | 登录态、上传表单、上传中、上传成功/失败、表格列表、状态徽章、发布、下架、删除确认 |
| `NotFoundPage` | 空态图标、返回首页 |

## 布局与响应式

- 公开内容使用 `.masonry`：1440/1024 三列，768 两列，640 一列。
- 桌面导航在 769px 显示；768px 及以下显示外露首页和二级菜单，菜单项与图标按钮均为 44px 热区。
- 320px 隐藏品牌文字，仅保留品牌图标；所有主视图不允许横向溢出。
- 响应式覆盖放在 `@layer components` 之外，避免 utilities 覆盖。

## 资产与品牌单点

- 品牌名、slogan、描述、导航、界面文案、页脚版权/备案/链接和资产规格：`frontend/src/lib/brand.ts`。
- favicon：`frontend/public/favicon.svg`。
- Logo 目标规格：透明底 512x512 WebP，最小 32px；正式资产放入 `frontend/public/brand-logo.webp`。
- HTML title、description、theme-color 与品牌定位一致，首帧脚本使用 `limedia-theme`。

## 验证

```bash
cd frontend
npm run typecheck
npm run build
cd ../backend
../.venv/bin/pytest -q
```

上线前还需检查：明暗正文 AA、320/390/768/769/1440 无横向溢出、焦点可见、空态/加载/失败/404、上传后公开列表即时展示、下架后公开页隐藏、Compose 服务健康。
