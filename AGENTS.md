# Li&Media 协作规范

## 事实来源

- 品牌文案：`frontend/src/lib/brand.ts`
- 视觉令牌：`frontend/src/index.css`
- 设计方案：`design-system/limedia/BRAND.md` 与 `design-system/limedia/MASTER.md`
- 设计模板：`packages/li-design`
- 设计边界：`packages/li-design` 仅做首次设计参考；前端不 import 或复制其他 Li& 项目文件。

## 技术约定

- 后端使用 FastAPI + SQLAlchemy 2 + Alembic。
- 前端使用 React + TypeScript + Vite + Tailwind CSS 4。
- 网盘凭据、下载链接和用户数据不写入仓库，只放 `.env` 或服务配置。
- 内容类型只做 `photo` 与 `video`，不做电影、剧集、动漫、纪录片或音乐 MV。
- 后端公开数据只返回 `published` 状态的回忆内容。
- 百度网盘地址必须由服务端短期解析，前端不得长期保存直链。
- 新增接口先落在 `/api/v1`，公开接口和后台接口分目录维护。
- 视觉令牌只写在 `frontend/src/index.css`；品牌与界面文案只写在 `frontend/src/lib/brand.ts`。
- 组件不硬编码颜色和品牌文案；动效尊重 `prefers-reduced-motion`，正文对比度达到 AA。

## 常用验证

```bash
cd backend
pytest

cd ..
python3 - <<'PY'
from pathlib import Path
for path in Path('frontend/src').rglob('*'):
    if path.suffix in {'.tsx', '.ts'} and path.name != 'brand.ts':
        text = path.read_text()
        if '#257' in text or '#7fd' in text or 'rgba(' in text:
            raise SystemExit(f'hardcoded color found: {path}')
PY

cd frontend
npm run typecheck
npm run build
```

## Git 约定

- 默认分支：`main`
- 任务分支：`codex/<kebab-case-task>`
- 提交主题使用中文，说明影响和原因。
- 一次提交只做一件事，不混入无关格式化或重构。
