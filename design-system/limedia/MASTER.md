# Li&Media Master

> 版本：V1.5 ｜ 日期：2026-11-07 ｜ 状态：实现快照。与代码冲突时以代码为准，并回写本文档。
> 相关：[BRAND.md](BRAND.md) · `frontend/src/index.css` · `frontend/src/lib/brand.ts`

## 技术栈与路由

- React 19 + TypeScript + Vite 7 + Tailwind CSS 4 + React Router 7 + lucide-react。
- 路由：`/`（回忆库和 `?viewer=<memoryId>` 查看器）、`/memories/:memoryId`（兼容重定向到查看器）、`/admin`（后台）、`*`（404）。
- API：`/api/v1/memories`、`/api/v1/memories/recommend`、`/api/v1/memories/:id`、`/api/v1/memories/:id/thumbnail`、`/api/v1/memories/:id/direct-url`、`/api/v1/memories/:id/stream`、`/api/v1/admin/memories`、`/api/v1/admin/cleanup`。公开列表与推荐只返回 **240px 派生图就绪**的内容（未预热不做占位兜底，直接不出现）；详情/直链/流不受此过滤，查看器直链仍可达。

## 令牌快照

- 文件：`frontend/src/index.css`，是颜色、阴影、缓动和动效时长唯一事实来源。
- 前缀：`--limedia-*`；主题：`:root` 浅色（次要）、`.dark` 深色（主打，近黑 `#0D1110` 底）；无存储偏好时默认深色。
- 语义层：background / surface / surface-2 / foreground / muted / border / primary / secondary / success / warning / destructive / ring / 六组 accent。
- 辅助层：`--limedia-shadow-*`、`--limedia-ease-*`、`--limedia-motion-*`（含 `motion-cinematic` 与 `ken-burns`）、`--limedia-glass-*`、`--limedia-flow-gradient`。V1.5 起移除 `--limedia-aurora-*` 与 `--limedia-tech-*`（氛围层收敛为静态胶片颗粒）。
- 展示排版：`--font-display` 系统衬线栈（New York / Songti SC / Georgia），`--text-hero` 系 clamp 字号生成 `text-hero` utility；元数据行 tnum + 大写字距。
- Tailwind 组件只引用 `bg-primary`、`text-muted`、`border-border`、`.card` 等语义类；不硬编码颜色值。
- 深色带文字软底使用 `--limedia-*-soft-solid` 与 `--limedia-*-soft-fg`。

## 组件快照

| 类别 | 组件 / 类 |
| --- | --- |
| 交互控件 | `Button`、`IconButton`、`Input`、`TextArea`、`DropdownMenu`、`Pagination` |
| 反馈 | `Badge`、`StatusBadge`、`FileStatusBadge`、`Notice`、`Toast`、`Modal`、`ProgressBar`、`EmptyState`、`MediaSkeleton`、`SearchSkeleton`、`StatusDot` |
| 氛围 | `AmbientBackground`（静态胶片颗粒 + 单枚极淡光晕，V1.5 起无极光/科技层）、`BlurText`、`FlowRule`（CSS 类） |
| 内容组件 | `MemoryCard`（无边框纯图瓦 + 底部渐变说明层，占位按 `memory.width/height` 实时计算）、`HeroFeature`（电影感单幅首屏：全出血精选图 1280/768 派生图走共享队列、极慢 Ken Burns、双层渐变遮罩、衬线巨字标题压图、「接下来」条切换主图、捕获 ≤5 条后稳定、窄屏露 3 枚、空库退场）、`MediaViewer`、`VideoPlayer`、`AdminLoginCard` |
| 骨架 | `MediaSkeleton`（数据驱动：按真实图像宽高逐条实时计算 `aspect-ratio`，尺寸解析链 = 内存 items → `limedia-canvas-composition` 构图缓存 → 多样比例兜底；与真实画布同构零位移）、`HeroFeature` 内结构镜像骨架（非一整块均色） |
| 外壳 | `SiteHeader`（沉浸式 V1.7：`.site-header`/`.site-header-inner`/`.is-scrolled`）、`SiteFooter`（模板 V1.5：`mt-auto` 贴底 56px）、`BackToTop`、`Breadcrumb` |

## 页面与状态

| 页面 | 关键状态 |
| --- | --- |
| `HomePage` | 电影感单幅 hero（图像先行：全出血精选图 + 衬线巨字标题压图 + 元数据行 + CTA +「接下来」条切换主图；首屏捕获 ≤5 条后保持稳定，换批/筛选/翻页不影响；窄屏露 3 枚；空库退场并渲染兜底 h1）、类型导航、编辑部风统计行、居中紧凑筛选条、推荐置顶且与列表去重、无限分段加载、数据驱动媒体骨架（按真实宽高）、加载失败、空库（预热未到终态时显示「回忆预览正在准备」）、画布仅展示 240px 预热就绪内容（卡片固定请求 240px）、预热到终态且用户在顶部附近时自动补图刷新一次、「已收录媒体」为可展示口径（与画布一致）、真实封面瀑布流、URL 驱动查看器、旧链接兼容、滚动恢复、hero 存在时页眉压图浅色配色（`.has-hero` + `data-on-hero`） |
| `AdminPage` | 登录态、分区工作台、自适应搜索筛选、当前范围/选中记录操作分离、状态徽章、浏览器兼容、批量进度、发布、下架、删除确认、远程扫描、确认式本地清理 |
| `NotFoundPage` | 空态图标、返回首页 |

## 布局与响应式

- 页眉为模板 V1.7 沉浸式：顶部背景/边框/雾化全透明，`scrollY > 8px` 切换 `.is-scrolled`（92% 同源底色 + `blur(18px) saturate(145%)` 浅色 / 135% 深色 + 极淡边界与细阴影）；桌面内容高 72px、≤768px 64px，滚动前后高度不变；不支持 `backdrop-filter` 时回退不透明页面底色；页眉底部流光线透明度 0 → 0.2。
- 页脚为模板 V1.5 规格：文档流 `mt-auto` 贴底、单行高 56px（`min-h-14` 兜底）、半透明表面 + backdrop-blur；链接 muted→foreground（V1.5.1 铁律）；版权/备案/链接全部由 `brand.ts` 驱动。
- `page-shell` 底部留白 96px（模板视觉刷新口径）。
- 公开内容使用 `.masonry`：1600 六列、1280 五列、1024 四列、768 三列、640 两列；画布保留版心两侧留白。
- 桌面导航在 769px 显示；768px 及以下显示外露首页和二级菜单，菜单项与图标按钮均为 44px 热区。
- 360px 隐藏品牌文字，仅保留品牌图标；所有主视图不允许横向溢出。
- 响应式覆盖放在 `@layer components` 之外，避免 utilities 覆盖。
- 全站使用 `AmbientBackground` 静态胶片颗粒氛围层（无动画，不参与 reduced-motion 分支）；表格、正文和媒体内容保持前景层优先。

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
