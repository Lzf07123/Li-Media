# Li&Media

> 基于百度网盘存储的公开回忆库，用于展示照片和视频回忆。当前仓库包含 FastAPI 后端、React 前端、项目级设计系统、数据库迁移和 Docker Compose 编排。

## 技术栈

- 后端：FastAPI + SQLAlchemy + Alembic + PostgreSQL + Redis
- 前端：React 19 + TypeScript + Vite + Tailwind CSS 4
- 设计：首次设计以 [Li&Design](packages/li-design/README.md) 为参考，实例化为项目内 [design-system/limedia](design-system/limedia/BRAND.md)；运行时只使用 `frontend/src/index.css` 与 `frontend/src/lib/brand.ts`，不依赖模板仓库。
- 部署：Docker Compose + Nginx

## 本地启动

1. 复制环境变量模板：

```bash
cp .env.example .env
```

2. 启动服务：

```bash
docker compose up --build
```

3. 打开唯一 Nginx 入口：

```text
http://localhost:8080
```

默认部署中只有 Nginx 暴露宿主端口；backend、PostgreSQL 和 Redis 只在 Compose 网络内访问。API 文档默认由 Nginx 关闭；如需调试，可在 backend 容器内访问 `http://127.0.0.1:8000/api/docs`。

生产环境 TLS 仍由同一 Nginx 终止。需要证书挂载、`HTTPS_PORT` 映射和 443 监听配置时，先提供 Compose 覆盖文件，再在部署环境中启用：

```text
HTTPS_PORT=443
```

## 常用命令

```bash
cd frontend
npm run dev
npm run typecheck
npm run build
npm run test:e2e
```

```bash
cd backend
uvicorn app.main:app --reload
alembic upgrade head
```

### 质量门禁

一键运行后端测试、前端类型检查、生产构建、设计令牌/品牌来源检查和 Playwright 冒烟测试：

```bash
python3 scripts/check.py
```

在提交或部署前校验单入口端口边界；`--quiet` 只输出错误：

```bash
docker compose config --quiet
```

临时跳过浏览器测试时使用：

```bash
python3 scripts/check.py --skip-e2e
```

Playwright 默认使用本机 Chrome；已启动的前端可通过 `PLAYWRIGHT_BASE_URL` 复用。若要启用 Git 提交钩子，安装 [pre-commit](https://pre-commit.com/) 后执行：

```bash
pre-commit install
```

## 目录结构

```text
backend/
  app/                 FastAPI 应用
  alembic/             数据库迁移
  tests/               后端测试
frontend/
  src/                 React 前端
design-system/limedia/ 项目级设计方案
packages/li-design/    设计模板子模块
CHECKLIST.md          当前版本验收基线
```

## 运行时行为

- 公开首页是无限瀑布画布，保留版心两侧留白；每页 18 条，滚动接近底部时继续分段追加。
- 页面不提供搜索和排序入口；推荐内容按当前类型随机取 8 条，并置入画布最前且与列表去重。
- 公开列表和详情返回瘦身 DTO，只包含首页卡片和查看器需要的字段。
- 派生图矩阵为 240 / 480 / 768 / 1280px；首页按列宽和 DPR 选择最小可用尺寸，查看器移动端用 480px、桌面端用 1280px。
- 视频仅在用户触发播放后申请百度短时直链；直链只在应用内存中短期复用，失败后最多强制刷新一次再回退服务端流。
- 管理清理会移除本地索引、派生缓存、临时文件和 Nginx 派生图缓存，但不修改百度网盘资源。
- 扫描、直链探测、单帧派生和流回退分别受独立并发与队列上限治理；重复派生请求会合并，队列满时返回 `429`。运维指标位于 `GET /api/v1/admin/tasks/metrics`。
- 管理后台会汇总显示后端栈（API / 数据库 / Redis / 任务治理）、远端存储索引状态以及内存 / 线程 / PID / 临时文件 / 磁盘 / 队列资源状态；数据来自 `GET /api/v1/admin/system/status`。
- 管理后台可按尺寸和类型（全部 / 图片 / 视频）手动预热缩略图；所选范围内的全部候选都会进入任务，`limit=0` 表示不设数量上限。预热任务异步执行，避免公开首页冷缓存时集中触发派生。
- 首页媒体卡片在滚动进入/离开视口时交叉淡入淡出：缩略图就绪后淡入图片，未就绪时淡入占位符；动画只使用透明度和 transform，并尊重 `prefers-reduced-motion`。
- 后台媒体工作台采用分区卡片布局；筛选、当前范围操作、选中记录操作和横向滚动表格分离，窄屏时字段自动换行且不重叠。
- 前端对可见缩略图使用全局加载队列，最多同时发起 4 个图像请求；查看器大图高优先级，媒体切换或关闭时取消排队请求。
- Compose 对 backend / PostgreSQL / Redis / Nginx 设置 CPU、内存、PID 和日志轮转边界；backend 内存硬上限为 256m。远程首帧源读取、临时目录配额和 FFmpeg 子进程资源也有独立保护。基线见 [docs/resource-baseline.md](docs/resource-baseline.md)。

## 当前进度

- 单网关传输：同一域名和端口提供 SPA、API、健康检查和公开派生图；Nginx 不缓存短时直链或带凭证响应。
- Remote-First：百度网盘只作为存储源；服务端保存扫描任务、远程索引和可观测状态，不保存媒体本体。
- 已完成：公开瘦身列表/详情、`/api/v1/memories/recommend` 每次访问随机推荐、类型筛选、无限分段加载和 URL 驱动查看器。
- 已完成：递归分页扫描、增量去重、扫描检查点、限流退避、元数据回填、远程缩略图代理、按需媒体流转发和 Range 播放。
- 已完成：生产基础框架、Remote-Only 公开列表/详情接口、照片/视频详情展示、Docker Compose。
- 已完成：液态玻璃令牌、通用组件、无限瀑布流、分段加载、类型筛选、每次进入随机推荐、后台表格与删除确认、文件状态输出、明暗主题与 404 空态。
- 已完成：照片/视频元数据识别、远程扫描状态展示、服务端会话鉴权、登录限流和管理操作日志。
- 已完成：后台百度网盘 OAuth 授权、授权状态校验、服务端凭证保存、过期自动刷新和回调闭环。
- 已完成：Viewer-First 首页查看器、旧详情地址兼容重定向、照片 480/1280px 服务端派生缓存、视频海报分级派生、按需百度短时直链、播放/下载恢复和管理端确认式本地清理。
- 已完成：批量修改/发布/下架、整理报告导出和 Playwright 冒烟测试；状态类操作返回 `changed / skipped` 并保持幂等。本地上传接口已关闭。
- 已完成：视频播放直链应用内短时复用、并发请求合并和单一播放状态提示。
- 已完成：后台后端栈状态、远端存储状态与资源 / 队列状态面板。
- 已完成：缩略图手动预热与任务队列拒绝指标展示。
- 已完成：前端缩略图全局排队加载，公开页面冷缓存时不再瞬时打满派生队列。
- 已完成：分层并发限制、请求合并、任务指标、单帧派生资源边界、容器资源硬上限和清理中的活动临时文件保护。
- 已完成：后台媒体盘点、筛选一致计数、浏览器兼容筛选、批量发布/下线任务、页脚常驻和公开收录总量展示。
- 待完成：线上部署验收和真实大目录扫描观测。

## 公开接口

| 路径 | 说明 |
| --- | --- |
| `GET /api/v1/healthz` | 进程健康检查 |
| `GET /api/v1/readyz` | 数据库与 Redis 就绪检查 |
| `GET /api/v1/memories` | 公开瘦身列表；支持 `kind`、`page`、`page_size` |
| `GET /api/v1/memories/recommend` | 随机推荐；`limit` 最大 24，响应 `no-store` |
| `GET /api/v1/memories/:id` | 公开瘦身详情 |
| `GET /api/v1/memories/:id/thumbnail` | 派生图；`size=240|480|768|1280` |
| `GET /api/v1/memories/:id/direct-url` | 播放或下载短链；响应 `no-store` |
| `GET /api/v1/memories/:id/stream` | 直链失败时的流式回退 |
| `GET /api/v1/memories/public-counts` | 公开可浏览总数；使用与公开列表/推荐/详情相同的谓词 |

## 浏览器兼容矩阵

公开照片只需要展示健康；公开视频必须同时满足已发布、展示健康和浏览器可播放。兼容状态持久化在 `memory_files.browser_compatibility`，摘要、失败原因、探测时间和矩阵版本持久化在 `memory_files.browser_format_summary` / `browser_compatibility_error` / `browser_compatibility_checked_at` / `browser_compatibility_version`。

| 状态 | 判定 | 假设与来源 |
| --- | --- | --- |
| `supported` | MP4/M4V + H.264/AVC1；音频为 AAC/MP4A 或无音轨 | 依据当前主流浏览器对 HTML5 媒体的通用基线；profile 只作为摘要记录，不放宽到浏览器专属能力。 |
| `unsupported` | AVI、FLV、Matroska/MKV、MOV、MPEG-TS、WebM、WMV，或 HEVC/H.265/HVC1、MPEG-4 Part 2、MPEG-2、ProRes、VP8/VP9、AV1 | 保守矩阵按“无浏览器专属配置可播放”判定；Safari HEVC 等能力必须由后续客户端能力查询细化，不能默认放宽全站谓词。 |
| `unknown` | 容器/编码/音轨证据不足，或受控探测数据不足 | 默认不进入公开画布和推荐；只在管理员触发探测时使用远程前缀和 `ffprobe`，不完整下载源媒体，也不转码。 |

兼容状态变化会同步刷新计数、列表、详情、推荐和 Nginx 代理缓存。探测结果不保存源媒体副本、完整直链、Token 或 Cookie。

## 管理入口

1. 在 `.env` 中设置：

```bash
ADMIN_TOKEN=change-me
BAIDU_OAUTH_CLIENT_ID=your-app-key
BAIDU_OAUTH_CLIENT_SECRET=your-secret-key
BAIDU_OAUTH_REDIRECT_URI=http://127.0.0.1:8080/admin/baidu/callback
```

2. 在百度网盘开放平台把回调地址配置为同一值，并将媒体放入 `BAIDU_SYNC_DIR`。

3. 打开：

```text
http://127.0.0.1:8080/admin
```

4. 输入管理令牌后点击「开始授权」；百度回跳后系统会自动接收授权码、换取凭证并保存到服务端配置，然后返回管理页触发扫描。
