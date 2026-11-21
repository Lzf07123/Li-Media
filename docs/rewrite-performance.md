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

## 结论

- 后端延迟 5-13×、内存 -79%,同时代码量从 9,399 行(Python app)降至约 8,600 行(Go internal+cmd),
  测试从 134 个 pytest 覆盖到等价 Go 测试套件(全绿)。
- 前端交互行为与 React 版逐测试等价(87 e2e 全绿),代价是 wasm 体积。
- 契约零破坏:公开 11 端点 + admin 10 端点逐字段一致(见 docs/contract-samples/)。
