// Leptos/WASM 构建是单一产物,不存在按路由分包的 JS chunk。
// 本文件保留 MediaViewer 分包的请求契约:首页加载时即获取查看器模块
// (对齐 React 版 lazy import 的预取行为)。AdminPage 分包不预取,
// 因此不提供同名资源——懒加载边界由单包构建天然满足。
