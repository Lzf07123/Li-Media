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

3. 打开站点：

```text
http://localhost:8080
```

后端 API 文档在：

```text
http://127.0.0.1:8000/api/docs
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
CHECKLIST.md          下一阶段待办清单
```

## 当前进度

- Remote-First：百度网盘只作为存储源；服务端保存扫描任务、远程索引和可观测状态，不保存媒体本体。
- 已完成：递归分页扫描、增量去重、扫描检查点、限流退避、元数据回填、远程缩略图代理、按需媒体流转发和 Range 播放。
- 已完成：生产基础框架、Remote-Only 公开列表/详情接口、照片/视频详情展示、Docker Compose。
- 已完成：液态玻璃令牌、通用组件、回忆瀑布流、分页搜索、后台表格与删除确认、文件状态输出、明暗主题与 404 空态。
- 已完成：照片/视频元数据识别、远程扫描状态展示、服务端会话鉴权、登录限流和管理操作日志。
- 已完成：后台百度网盘 OAuth 授权、授权状态校验、服务端凭证保存、过期自动刷新和回调闭环。
- 已完成：Viewer-First 首页查看器、旧详情地址兼容重定向、照片 480/1280px 服务端派生缓存、视频海报分级派生、按需百度短时直链、播放/下载恢复和管理端确认式本地清理。
- 已完成：批量修改/发布/下架、整理报告导出和 Playwright 冒烟测试；本地上传接口已关闭。
- 待完成：后台审核、发布流程增强和线上部署验收。

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
http://127.0.0.1:5173/admin
```

4. 输入管理令牌后点击「开始授权」；百度回跳后系统会自动接收授权码、换取凭证并保存到服务端配置，然后返回管理页触发扫描。
