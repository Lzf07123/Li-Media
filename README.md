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

- 已完成：生产基础框架、本地上传、公开列表/详情接口、照片/视频详情展示、Docker Compose。
- 已完成：液态玻璃令牌、通用组件、回忆瀑布流、分页搜索、后台表格与删除确认、文件状态输出、明暗主题与 404 空态。
- 已完成：照片/视频元数据识别、服务端缩略图、百度网盘最小同步、同步状态展示、服务端会话鉴权、登录限流和管理操作日志。
- 待完成：播放代理、后台审核、批量导入整理和发布流程增强。

## 管理入口

1. 在 `.env` 中设置：

```bash
ADMIN_TOKEN=change-me
```

2. 打开：

```text
http://127.0.0.1:5173/admin
```

3. 输入管理令牌后即可上传照片、视频，并控制发布/下架。
