# Li&Media 协作规范

## 事实来源

- 品牌文案:`frontend/src/lib/brand.ts`(**Rust 侧 `frontend/src/brand.rs` 由脚本从 brand.ts 生成,勿手改值;变更文案先改 brand.ts 再同步生成**)
- 视觉令牌:`frontend/src/index.css`
- 设计方案:`design-system/limedia/BRAND.md` 与 `design-system/limedia/MASTER.md`
- 设计模板:`packages/li-design`
- 设计边界:`packages/li-design` 仅做首次设计参考;前端不 import 或复制其他 Li& 项目文件。

## 技术约定

- 后端使用 Go 1.23(标准库 net/http + pgx/v5 + golang-migrate 内嵌迁移),不再使用 FastAPI。
- 前端使用 Leptos 0.8(Rust→WASM,trunk 构建),不再使用 React/Vite;`frontend/src` 下 `.rs` 为源,React 遗留文件在迁移完成后清理。
- 网盘凭据、下载链接和用户数据不写入仓库,只放 `.env` 或服务配置。
- 内容类型只做 `photo` 与 `video`,不做电影、剧集、动漫、纪录片或音乐 MV。
- 后端公开数据只返回 `published` 状态的回忆内容。
- 百度网盘地址必须由服务端短期解析,前端不得长期保存直链;直链缓存只存在进程内存。
- 新增接口先落在 `/api/v1`,公开接口和后台接口分目录维护。
- 视觉令牌只写在 `frontend/src/index.css`;品牌与界面文案只写在 `frontend/src/lib/brand.ts`。
- 组件不硬编码颜色和品牌文案;动效尊重 `prefers-reduced-motion`,正文对比度达到 AA。
- API 契约是行为规格:响应 JSON 字段名/顺序、错误文案(`{"detail": ...}`)、状态码必须与
  `docs/contract-samples/` 基线一致;改动需同步更新样本并说明原因。

## 开发环境(Docker 化,宿主无需装工具链)

```bash
# 固定子网网络(避免宿主 DNS 污染):db=172.30.0.10 redis=172.30.0.11
docker network create --subnet 172.30.0.0/24 --gateway 172.30.0.1 limedia-dev
# Go 开发容器(backend/ 挂载 /work,网络 limedia-dev,宿主 18000→8000)
# Rust 开发容器(frontend/ 挂载 /work,wasm32 target + trunk 0.21,宿主 14173→4173)
```

## 常用验证

```bash
# 后端
docker exec limedia-go-dev sh -c 'cd /work && go build ./... && go vet ./... && go test ./... -count=1'

# 前端(编译 + 构建产物)
docker exec limedia-rust-dev sh -c 'cd /work && cargo check --target wasm32-unknown-unknown 2>&1 | grep -cE "^error" && trunk build'

# e2e(宿主;需 trunk serve 与 Go server 运行中)
cd frontend
PLAYWRIGHT_BASE_URL=http://127.0.0.1:14173 npx playwright test

# 设计令牌与品牌来源检查(brand.rs 之外的 .rs 不得硬编码 --limedia-*)
python3 scripts/check_frontend_sources.py
```

## Git 约定

- 默认分支:`main`
- 任务分支:`codex/<kebab-case-task>`
- 提交主题使用中文,说明影响和原因。
- 一次提交只做一件事,不混入无关格式化或重构。
