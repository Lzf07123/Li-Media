# Li&Media

> 基于百度网盘存储的公开回忆库，用于展示照片和视频等内容。当前仓库是生产基础框架，包含 FastAPI 后端、React 前端、数据库迁移和 Docker Compose 编排。

## 技术栈

- 后端：FastAPI + SQLAlchemy + Alembic + PostgreSQL + Redis
- 前端：React 19 + TypeScript + Vite + Tailwind CSS 4
- 设计：[Li&Design](packages/li-design/README.md) 模板实例化为 [design-system/limedia](design-system/limedia/BRAND.md)
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
```

```bash
cd backend
uvicorn app.main:app --reload
alembic upgrade head
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
```

## 当前进度

- 已完成：生产基础框架、本地上传、管理令牌、公开列表/详情接口、照片/视频详情展示、Docker Compose。
- 待完成：百度网盘同步、文件识别、后台审核、播放代理、认证与权限。

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
