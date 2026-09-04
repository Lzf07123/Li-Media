# Li&Media

> 基于百度网盘存储的公开媒体库。当前仓库是生产基础框架，包含 FastAPI 后端、React 前端、数据库迁移和 Docker Compose 编排。

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

- 已完成：生产基础框架、健康检查、公开媒体列表/详情接口、前端骨架、Docker Compose。
- 待完成：百度网盘同步、刮削 Worker、后台审核、播放代理、认证与权限。
