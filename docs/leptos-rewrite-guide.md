# Leptos 前端迁移指南(codex/go-leptos-rewrite 分支)

React 19 + TS → Leptos 0.8(CSR)+ Rust 的组件迁移约定。已打通的骨架见 `frontend/src/*.rs`。

## 已验证的工具链与 API(踩坑记录,直接照用)

- 构建容器:`docker exec limedia-rust-dev sh -c 'cd /work && cargo check --target wasm32-unknown-unknown'`;产物:`trunk build`(dev profile wasm ~5.8MB,release 由 M8 优化)。
- **leptos_router 0.8**:segment 类型从 crate 根导入:`use leptos_router::{StaticSegment, ParamSegment, WildcardSegment}`(**没有** DynamicSegment;动态段叫 ParamSegment);多段组合用**元组** `path={(StaticSegment("admin"), StaticSegment("baidu"))}`,没有 `.add()`;`use_query_map() -> Memo<ParamsMap>`(`get_str`)、`use_params_map()`、`use_location()`;`<Redirect path={String}/>`;`<Routes fallback={组件}>`。
- **brand.rs**:`crate::brand::Brand::XXX`(标量)+ `crate::brand::copy::XXX`(文案嵌套);不要在 impl 里写 mod(不合法)。文案缺的键从 `frontend/src/lib/brand.ts` 补译,命名 snake_case 大写。
- **api 层**:`crate::api::{get, post, request, ApiError}` 已封装(credentials include/60s 超时/detail 解析);类型在 `crate::api::types`;`resolve_trusted_media_url/resolve_thumbnail_url/resolve_thumbnail_src_set` 直接复用。
- **web_sys**:inner_height/scroll_y 返回 `Result<JsValue>`,用 `.ok().and_then(|v| v.as_f64())`;features 已补 Url/ScrollToOptions/ScrollBehavior/AbortController/IntersectionObserver 等,新增能力进 Cargo.toml features。
- **view! 里的事件**:`on:click=move |e: web_sys::MouseEvent| {...}`;DOM 直写(时间回廊相机)用 `web_sys::window()` + `NodeRef` + `element.set_attribute`/`style` 属性操作,绕过响应式层。
- **样式**:index.css 原样复用(勿改);类名必须与 React 版逐字一致,这是 Playwright 测试跑绿的前提。

## 迁移要求

1. 每个组件对照 React 源逐行迁移:类名、aria-*、data-*、交互语义(reduced-motion 分支、rAF 直写路径)全部保留。
2. lucide-react 图标 → 内联 `<svg>`(取 lucide 对应图标的 path 数据,可简写为最小 path)。
3. 状态:URL 是唯一事实源(HomePage 的 ?kind/?keyword/?viewer/?view=space);Leptos 用 `use_query_map` + 信号 + `window.history` 推导航(或 leptos_router 的 use_navigate)。
4. React 的 useEffect → Leptos 的 `Effect::new`/`on_mount`;清理逻辑(事件监听/rAF)在 cleanup 中完成。
5. 不要删除 React 文件(legacy 由主会话在 M8 统一处理);不要改 index.css;不要 git commit。
6. 每完成一个组件跑:`docker exec limedia-rust-dev sh -c 'cd /work && cargo check --target wasm32-unknown-unknown 2>&1 | grep -cE "^error"'`,保持 0 错误。

## 待迁移清单(按序)

| React 源 | 行数 | 目标 Rust | 要点 |
|---|---|---|---|
| components/ui/*(15 个) | ~550 | src/components/ui/* | Button/Modal/Toast/Pagination 等无头件 |
| lib/image-load-queue.ts | 251 | src/lib/image_load_queue.rs | 全局并发 2 限流队列+优先级 |
| lib/canvas-composition.ts | 112 | src/lib/canvas_composition.rs | 骨架屏比例 |
| lib/format.ts / media-state.ts / useTheme.ts | ~207 | src/lib/* | 主题切换走 dataset.theme |
| components/MemoryCard.tsx | 339 | src/components/memory_card.rs | IntersectionObserver+srcset |
| components/HeroFeature.tsx | 479 | src/components/hero_feature.rs | Ken Burns 自动轮换 |
| components/MediaViewer.tsx + VideoPlayer.tsx | 1120 | src/components/media_viewer.rs | 缩放/swipe/预取/剪贴板 |
| components/space/*(3 个) | 1480 | src/components/space/* | **时间回廊**:相机弹簧 rAF 直写 DOM(wasm 内积分),preserve-3d/reduced-motion 降级 |
| pages/HomePage.tsx | 1241 | src/pages/home.rs | URL 驱动状态+无限分段加载 |
| pages/AdminPage.tsx + 后台组件 | ~3200 | src/pages/admin.rs + src/components/admin/* | 登录/同步/预热/批量/状态仪表盘 |
| pages/BaiduCallbackPage.tsx | 90 | src/pages/baidu_callback.rs | code/state 上报 |
| pages/NotFoundPage.tsx | 24 | src/pages/not_found.rs | 已有骨架,补文案交互 |
