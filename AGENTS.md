# Li&Media 协作规范

## 事实来源

- 品牌文案：`frontend/src/lib/brand.ts`
- 视觉令牌：`frontend/src/index.css`
- 设计方案：`design-system/limedia/BRAND.md` 与 `design-system/limedia/MASTER.md`
- 设计模板：`packages/li-design`

## 技术约定

- 后端使用 FastAPI + SQLAlchemy 2 + Alembic。
- 前端使用 React + TypeScript + Vite + Tailwind CSS 4。
- 网盘凭据、下载链接和用户数据不写入仓库，只放 `.env` 或服务配置。
- 内容类型只做 `photo` 与 `video`，不做电影、剧集、动漫、纪录片或音乐 MV。
- 后端公开数据只返回 `published` 状态的回忆内容。
- 百度网盘地址必须由服务端短期解析，前端不得长期保存直链。
- 新增接口先落在 `/api/v1`，公开接口和后台接口分目录维护。

## 常用验证

```bash
cd backend
pytest

cd frontend
npm run typecheck
npm run build
```

## Git 约定

- 默认分支：`main`
- 任务分支：`codex/<kebab-case-task>`
- 提交主题使用中文，说明影响和原因。
- 一次提交只做一件事，不混入无关格式化或重构。
