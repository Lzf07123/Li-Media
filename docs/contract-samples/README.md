# M0 重构基线(golang/leptos 重写前)

> **历史基线说明（2026-11-22）**：FastAPI 实现与其 pytest 套件已随迁移完成从仓库移除。
> `fastapi/` 样本仍是公开 API 的行为契约基准，`go-samples/` 与 `go-admin/` 为 Go 实现
> 抓取的对照样本；下文“复现环境”中的 Python 步骤仅作历史记录。当前契约验证请用
> `scripts/contract-capture.sh` 对 Go 服务抓取后运行 `scripts/contract-diff.py`。

记录日期:2026-11-20。分支:`codex/go-leptos-rewrite`。

## 现有测试基线(全绿)

| 套件 | 结果 | 耗时 |
|---|---|---|
| backend pytest | **134 passed** | 3.93s |
| frontend `npm run typecheck` + `build` | 通过 | tsc 无错 / vite 1.45s |
| frontend Playwright | **84 passed + 2 skipped** | 46.8s |

## 性能基线(本地 uvicorn + postgres/redis 容器,8 并发 × 200 请求)

见 `baseline-perf.json`。核心数字:

| 端点 | P50 | P95 |
|---|---|---|
| GET /memories(默认) | 31.7ms | 57.2ms |
| GET /memories?sort=random | 41.3ms | 76.7ms |
| GET /memories/recommend | 21.3ms | 43.9ms |
| GET /memories/public-counts | 16.7ms | 23.7ms |
| GET /memories/{id} | 13.2ms | 20.0ms |
| uvicorn 进程 RSS | 110.7 MB | — |

前端构建产物基线:CSS 117.6kB(gzip 19.6kB)、主 JS 310.1kB(gzip 99.5kB)、AdminPage 68.7kB、MediaViewer 16.4kB、SpaceGallery 17.5kB。

## 契约样本

`fastapi/*.json` 由 `scripts/contract-capture.sh` 抓取(`.meta` 内含状态码与路径)。种子数据 `seed-baseline.sql`(6 memories / 8 files / 6 derivatives / 1 scan,覆盖 display_health 各状态组合)。

关键契约行为(重写必须逐条对齐):

1. **公开列表/推荐/详情/直链都要求 `home_derivative_ready` 或公开口径**:
   - 列表与 recommend:`require_home_derivative=True`(240px 派生图就绪,版本 `20260906-ratio-v1`)
   - 详情与 direct-url:published + 至少一个 baidupan 文件 + `public_visibility_state != excluded` → 否则 404 `{"detail": "memory not found"}`
   - browser unsupported 的 video 在公开口径下 excluded(即使 displayable)
2. **错误结构**:FastAPI 风格 `{"detail": "..."}`;401/404/422/502 均已采样。
3. **登录成功返回 204**(无 body);未登录访问 admin 返回 401。
4. **缓存头**:匿名列表 `public, max-age=15, stale-while-revalidate=30`;random/带 cookie `no-store`;recommend `no-store`;public-counts `public, max-age=15`。
5. **百度未配置时** direct-url/thumbnail 代理返回 502 + detail(样本 15/16)。

## 复现环境(供 M5 契约 diff 复用)

```bash
docker run -d --name limedia-baseline-db -e POSTGRES_USER=media -e POSTGRES_PASSWORD=media \
  -e POSTGRES_DB=media -p 55432:5432 docker.m.daocloud.io/library/postgres:16-alpine \
  -c shared_buffers=64MB -c max_connections=20
docker run -d --name limedia-baseline-redis -p 56379:6379 \
  docker.m.daocloud.io/library/redis:7-alpine --appendonly yes
cd backend && DATABASE_URL=postgresql+psycopg://media:media@127.0.0.1:55432/media \
  REDIS_URL=redis://127.0.0.1:56379/0 .venv/bin/alembic upgrade head
docker exec -i limedia-baseline-db psql -U media -d media < docs/contract-samples/seed-baseline.sql
DATABASE_URL=... REDIS_URL=... .venv/bin/uvicorn app.main:app --port 8001
scripts/contract-capture.sh http://127.0.0.1:8001 docs/contract-samples/fastapi
```

镜像拉取注意:本地网络 USTC 源不可达时用 `docker.m.daocloud.io/library/...`;docker build 内 APT 源同理(docker-compose 全栈构建在 M0 期间因网络搁置,M9 收尾时统一处理镜像源)。
