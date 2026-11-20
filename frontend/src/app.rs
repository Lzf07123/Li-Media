// 路由壳:对齐原 App.tsx 的布局与路由表。
use leptos::prelude::*;
use leptos_router::components::{Redirect, Route, Router, Routes};
use leptos_router::hooks::use_params_map;
use leptos_router::{ParamSegment, StaticSegment, WildcardSegment};

use crate::components::{ambient_background::AmbientBackground, back_to_top::BackToTop, site_footer::SiteFooter, site_header::SiteHeader};
use crate::pages::{baidu_callback::BaiduCallbackPage, home::HomePage, not_found::NotFoundPage};

#[component]
fn MemoryRedirect() -> impl IntoView {
    // /memories/:memoryId → /?viewer=<id>
    let params = use_params_map();
    let viewer = params
        .get()
        .get_str("memoryId")
        .map(|s| s.to_string())
        .unwrap_or_default();
    let target = format!("/?viewer={}", viewer);
    view! { <Redirect path=format!("/?viewer={}", viewer) /> }
}

#[component]
pub fn App() -> impl IntoView {
    view! {
        // Router 包裹整个布局:页眉/页脚的 hooks(use_location 等)依赖路由上下文。
        <Router>
            <div class="flex min-h-dvh flex-col bg-background text-foreground">
                <AmbientBackground />
                <SiteHeader />
                <main
                    class="page-shell relative z-10 mx-auto w-full max-w-7xl flex-1 px-4 sm:px-6 lg:px-8"
                    id="main"
                >
                    <Routes fallback={NotFoundPage}>
                        <Route path={StaticSegment("/")} view={HomePage} />
                        <Route
                            path={(StaticSegment("memories"), ParamSegment("memoryId"))}
                            view={MemoryRedirect}
                        />
                        <Route path={StaticSegment("admin")} view={crate::pages::admin::AdminPage} />
                        <Route
                            path={(StaticSegment("admin"), StaticSegment("baidu"), StaticSegment("callback"))}
                            view={BaiduCallbackPage}
                        />
                        <Route path={WildcardSegment("any")} view={NotFoundPage} />
                    </Routes>
                </main>
                <SiteFooter />
                <BackToTop />
            </div>
        </Router>
    }
}
