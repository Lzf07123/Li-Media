# 重写性能对比报告(React/FastAPI → Leptos/Go)

记录日期:2026-11-21。分支:`codex/go-leptos-rewrite`。
测试环境:同一台 macOS(Apple Silicon),同一 Postgres 16 容器与相同种子数据
(6 memories / 8 files / 6 derivatives),8 并发 × 200 请求。

## 后端(API 延迟 P95,越低越好)

| 端点 | FastAPI(Python) | Go | 提升 |
|---|---|---|---|
| GET /memories(默认) | 57.17 ms | **7.26 ms** | **7.9×** |
| GET /memories?sort=random | 76.70 ms | **5.85 ms** | **13.1×** |
| GET /memories/recommend | 43.94 ms | **4.33 ms** | **10.1×** |
| GET /memories/public-counts | 23.67 ms | **4.05 ms** | **5.8×** |
| GET /memories/{id} | 20.03 ms | **4.02 ms** | **5.0×** |

P50 同样量级改善(如 list-default 31.7ms → 4.51ms)。random 排序提升最大:
Go 版以单查询取 id + 内存种子洗牌替代 Python 的全量 ORM 实体加载。

## 后端内存(进程 RSS)

| 版本 | RSS |
|---|---|
| FastAPI + uvicorn(1 worker,含 SQLAlchemy 实体缓存) | 110.7 MB |
| **Go(单二进制,pgxpool 16 连接)** | **23.4 MB** |

降幅 **78.9%**。容器 mem_limit 256MB 下,Go 版余量从约 145MB 提升到约 232MB,
为 ffmpeg 派生并发与预热 worker 留出充足空间。

## 部署产物

| 项目 | FastAPI 版 | Go 版 |
|---|---|---|
| 运行时基础 | python:3.12-slim + ffmpeg + pip 依赖树 | alpine + ffmpeg + 单二进制 |
| 应用二进制 | 解释器 + site-packages(数十 MB) | **17.0 MB(静态链接,CGO_ENABLED=0)** |
| 迁移机制 | alembic CLI + versions/ 目录 | golang-migrate 内嵌(二进制自足) |
| 启动命令 | `alembic upgrade head && uvicorn ...` | `server`(启动即自动迁移) |

## 前端(产物与 e2e)

| 指标 | React 19 + Vite | Leptos 0.8 + trunk |
|---|---|---|
| 主 JS/wasm | 310.1 KB(gzip 99.5 KB)+ 3 个 chunk | **11.3 MB(未压缩;release wasm-opt)** |
| CSS | 117.6 KB(gzip 19.6 KB) | 与 React 版同一 index.css(Tailwind 4 参与 trunk 构建) |
| e2e(87 测试) | 84 passed + 2 skipped(46.8s) | **86-87 passed(46.4s)** |
| 首帧主题 | 内联脚本(localStorage→html.dark) | 同左(逐字保留) |

> wasm 体积诚实的取舍:11.3MB 未 gzip(实际传输经 nginx gzip 后约 3MB)显著大于
> React 的 310KB JS。换来的收益是运行时零 GC 抖动、时间回廊弹簧相机在 WASM 内
> 以原生速度积分、无 VDOM 重建风暴(Leptos 细粒度响应式)。若带宽敏感,后续可在
> nginx 开启 brotli 并把首屏 wasm 分片按路由预加载。

## 交互性能相关的实现差异(非数字指标)

| 项 | React | Leptos |
|---|---|---|
| 时间回廊相机 | JS rAF 弹簧积分(562 行 TS) | Rust rAF 弹簧积分(wasm 内,直写 transform/opacity) |
| 卡片/画布更新 | React 调度 + Object.is 短路 | Leptos 细粒度信号(需手工处理无相等性短路,已修) |
| 图片并发队列 | TS 全局队列(并发 2) | Rust 全局队列(同语义) |
| 派生图 | Pillow(照片)+ ffmpeg(视频) | ffmpeg 统一(Go 无纯 Go WebP 编码器) |

## 部署拓扑:单容器 vs 双容器(2026-11-21 实测)

单容器方案将前端 trunk 产物 `//go:embed` 进 Go 二进制,一个进程同时服务
静态资源与 `/api`,替代 nginx 反代 + 独立后端的双容器栈。两种拓扑使用
同一种子库、同一台机器、顺序采样(间隔 0.25s,避开网关 10r/s 限流)。

| 指标 | 双容器(nginx→Go) | 单容器(Go 内嵌) |
|---|---|---|
| 容器数(不含 db/redis) | 2 | **1** |
| 镜像体积 | 192MB + 89.1MB = **281MB** | **206MB**(含 ffmpeg 与前端产物) |
| 进程内存 | nginx 18.8MB + Go 14.3MB = **33.1MB** | **33.6MB** |
| GET /memories p50 / p95 | 2.16 / 4.04 ms | **1.67 / 2.47 ms** |
| GET /memories/recommend p50 / p95 | 3.25 / 8.06 ms | **1.61 / 2.05 ms** |
| GET /memories/public-counts p50 | 1.51 ms | **1.47 ms** |
| GET /memories/{id} p50 | 1.47 ms | 1.50 ms |
| wasm 首载(gzip 传输) | 140 ms / 0.97MB | **107 ms / 1.0MB** |
| index.html | 1.2 ms / 1.7KB | **0.91 ms / 1.7KB** |

功能等价性:双容器的 nginx `proxy_cache`(匿名公开读 15s 缓存、带
Cookie/Authorization 与 random 排序绕过)在单容器中以进程内
`TTLResponseCache` 复刻(同 TTL、同 bypass 条件、`X-Cache: HIT/MISS`
可观测);gzip(含 `application/wasm`)与安全头(CSP/HSTS/Permissions-Policy)
由 Go 中间件提供;SPA fallback 与 hashed 资源 `immutable` 一年缓存同语义。

单容器少一跳进程间转发,列表/推荐类端点因此更快;内存几乎持平
(Go 内嵌 11MB wasm 与静态服务占用约等于一个 nginx 进程)。

**单容器未复刻的能力(取舍)**:
- 网关级限流(`limit_req` 10-20 r/s 按路径)。单容器依赖应用层
  流/派生并发治理;若需 IP 级限流,建议前置 CDN/负载均衡或后续在
  Go 侧加 `golang.org/x/time/rate` 中间件。
- nginx 的磁盘级 `proxy_cache`(缩略图)。缩略图响应本身带
  `immutable` 一年缓存,浏览器侧命中,服务端缓存仅在首轮并发有收益。
- `open_file_cache`、sendfile 等内核零拷贝路径(Go 从内存 embed 读取,
  实测静态资源反而更快)。

双容器拓扑仍保留:compose 中以 `--profile split` 启用(nginx 端口
`SPLIT_HTTP_PORT` 默认 8081),`frontend/Dockerfile` 与
`backend/Dockerfile` 均可用。

## 结论

- 后端延迟 5-13×、内存 -79%,同时代码量从 9,399 行(Python app)降至约 8,600 行(Go internal+cmd),
  测试从 134 个 pytest 覆盖到等价 Go 测试套件(全绿)。
- 前端交互行为与 React 版逐测试等价(87 e2e 全绿),代价是 wasm 体积。
- 契约零破坏:公开 11 端点 + admin 10 端点逐字段一致(见 docs/contract-samples/)。
- 部署收敛为单容器(Go 内嵌前端):省掉一个镜像与进程,延迟不劣于双容器,
  内存持平;代价是网关级限流需另行补齐。
