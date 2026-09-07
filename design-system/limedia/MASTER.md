# Li&Media Master

> 版本：V1.1 ｜ 日期：2026-09-06 ｜ 状态：实现快照。与代码冲突时以代码为准，并回写本文档。
> 相关：[BRAND.md](BRAND.md) · `frontend/src/index.css` · `frontend/src/lib/brand.ts`

## 技术栈与路由

- React 19 + TypeScript + Vite 7 + Tailwind CSS 4 + React Router 7 + lucide-react。
- 路由：`/`（回忆库和 `?viewer=<memoryId>` 查看器）、`/memories/:memoryId`（兼容重定向到查看器）、`/admin`（后台）、`*`（404）。
- API：`/api/v1/memories`、`/api/v1/memories/recommend`、`/api/v1/memories/:id`、`/api/v1/memories/:id/thumbnail`、`/api/v1/memories/:id/direct-url`、`/api/v1/memories/:id/stream`、`/api/v1/admin/memories`、`/api/v1/admin/cleanup`。

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
| 反馈 | `Badge`、`StatusBadge`、`FileStatusBadge`、`Notice`、`Toast`、`Modal`、`ProgressBar`、`EmptyState`、`MediaSkeleton`、`SearchSkeleton`、`StatusDot` |
| 氛围 | `AmbientBackground`（软极光 + 科技光效层）、`BlurText`、`FlowRule`（CSS 类） |
| 内容组件 | `MemoryCard`、`MediaViewer`、`VideoPlayer`、`AdminLoginCard` |
| 外壳 | `SiteHeader`、`SiteFooter`、`BackToTop`、`Breadcrumb` |

## 页面与状态

| 页面 | 关键状态 |
| --- | --- |
| `HomePage` | 类型导航、居中紧凑筛选条、推荐置顶且与列表去重、无限分段加载、媒体骨架、加载失败、空库、真实封面瀑布流、URL 驱动查看器、旧链接兼容、滚动恢复 |
| `AdminPage` | 登录态、分区工作台、自适应搜索筛选、当前范围/选中记录操作分离、状态徽章、浏览器兼容、批量进度、发布、下架、删除确认、远程扫描、确认式本地清理 |
| `NotFoundPage` | 空态图标、返回首页 |

## 布局与响应式

- 公开内容使用 `.masonry`：1600 六列、1280 五列、1024 四列、768 三列、640 两列；画布保留版心两侧留白。
- 桌面导航在 769px 显示；768px 及以下显示外露首页和二级菜单，菜单项与图标按钮均为 44px 热区。
- 320px 隐藏品牌文字，仅保留品牌图标；所有主视图不允许横向溢出。
- 响应式覆盖放在 `@layer components` 之外，避免 utilities 覆盖。
- 全站使用 `AmbientBackground` 软氛围层；表格、正文和媒体内容保持前景层优先，移动端隐藏光束与光点。

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

上线前还需检查：明暗正文 AA、320/390/768/769/1280/1600 无横向溢出、焦点可见、空态/加载/失败/404、发布后公开列表即时展示、下架后公开页隐藏、Compose 服务健康。
