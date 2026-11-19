# Go 重写模式指南(供翻译执行者遵守)

本指南固化 `codex/go-leptos-rewrite` 分支上已建立的 Go 重写模式。所有新代码必须与现有 `backend/internal/**` 风格一致。

## 目录与包

```
backend/
├── cmd/server/main.go          # 入口:装配 config/pool/governor/http
├── internal/
│   ├── config/                 # Settings 全字段,env 解析(env.go)
│   ├── db/                     # pgxpool + embed 迁移(golang-migrate)
│   ├── models/                 # 7 张表全列 struct + 枚举常量
│   ├── repo/                   # 数据访问(手写 SQL + 显式列扫描)
│   ├── services/               # 服务层(对齐 app/services/*.py)
│   └── api/                    # HTTP 层(ServeMux 路由、响应助手、CORS)
└── internal/db/migrations/     # 0001_baseline(Alembic 终态)
```

## 核心模式

1. **配置注入**:不使用全局单例。`config.Settings` 由 main 一次性 Load,通过结构体字段注入服务层(Python 的 `get_settings()` 调用点全部改为读注入的 settings)。Python 包级单例(task_limiter/task_metrics/in_flight_derivatives/download_url_cache)中:TaskGovernor/InFlightRegistry 走注入;DownloadUrlCache 保持包级 var(行为等价)。
2. **错误类型**:每个服务错误定义为 `type XxxError struct{ Msg string }` + `Error() string`。**错误文案与 Python 版逐字一致**(出现在 API 响应 detail 里,是契约)。
3. **取消**:Python 的 `cancel_event: Event` → Go `context.Context`;`context.WithTimeout` 对应显式超时。
4. **数据库**:pgx/v5 直写 SQL;参数 `$N` 顺序编号;显式列清单 + `row.Scan(&field...)` 配对(repo/memories.go 的模式);不用 ORM 不用反射扫描。
5. **响应契约**:JSON 响应用**带 json tag 的 struct**(字段序与 FastAPI/pydantic 一致,Go map 序列化按字母序会破坏原文 diff);错误统一 `{"detail": "..."}`(api.ErrorDetail);校验错误 `{"detail": [{type,loc,msg,input}]}`(api.ValidationError)。
6. **HTTP 路由**:标准库 ServeMux,方法+路径模式(`"GET /api/v1/memories/{id}"`);不引第三方框架。
7. **测试**:
   - DB 测试用 `GO_TEST_DATABASE_URL`(默认 `postgres://media:media@limedia-baseline-db:5432/media`,limedia-dev 网络容器);参考 repo/memories_test.go 的 `testPool`(每测试独立临时库 + 迁移 + 种子)。
   - 涉及 ffmpeg 的测试先生成源文件(参考 services/memory_thumbnails_test.go 的 genTestImage)。
   - 错误文案用断言逐字对比(参考 services/baidu_test.go 的 TestErrorMessagesMatchContract)。
8. **日志**:标准库 log/slog,JSON handler。

## 验证命令(容器内)

```bash
docker exec limedia-go-dev sh -c 'go build ./... && go vet ./... && go test ./... -count=1'
```

全部必须通过才算完成。**不要 git commit**——由主会话验收后提交。

## 契约红线(来自 docs/contract-samples/)

- 枚举值、JSON 字段名、错误文案逐字一致;UUID 输出小写连字符(google/uuid 默认)。
- 时间戳:JSON 输出 RFC3339 UTC(time.Time MarshalJSON 默认),对齐 pydantic datetime 序列化(ISO8601,含微秒时 pydantic 不带 Z 后缀差异可接受,以样本 diff 为准按需调整)。
- 429 带 `Retry-After` 头;详情/直链 404 文案 `memory not found` / `memory file not found`。
- 公开口径:列表/推荐要求 home_derivative_ready(repo.HomeDerivativeReadyCondition);详情/直链/流要求 public visibility(repo.GetPublicVisibilityState)。
- admin 鉴权:除 login 外全部要求有效会话 cookie(`limedia_admin_session`),未登录 401。
