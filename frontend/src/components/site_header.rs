// 沉浸式页眉:超过 8px 切换同源雾化层;导航激活由 kind 查询参数判定
// (对齐 SiteHeader.tsx 的语义,M7 补菜单 details 交互)。
use leptos::prelude::*;
use leptos_router::hooks::use_query_map;
use leptos_router::hooks::use_location;
use wasm_bindgen::JsCast;

use crate::brand::Brand;

const SCROLLED_THRESHOLD_PX: f64 = 8.0;

#[component]
pub fn SiteHeader() -> impl IntoView {
    let scrolled = RwSignal::new(false);

    let update = move || {
        if let Some(window) = web_sys::window() {
            scrolled.set(window.scroll_y().unwrap_or(0.0) > SCROLLED_THRESHOLD_PX);
        }
    };
    update();

    if let Some(window) = web_sys::window() {
        let update_boxed = std::rc::Rc::new(update);
        let cb_update = update_boxed.clone();
        let on_scroll: wasm_bindgen::closure::Closure<dyn Fn()> =
            wasm_bindgen::closure::Closure::new(move || cb_update());
        let _ = window.add_event_listener_with_callback(
            "scroll",
            on_scroll.as_ref().unchecked_ref(),
        );
        std::mem::forget(on_scroll);
    }

    let _location = use_location();
    let query = use_query_map();
    let kind = move || {
        query
            .get()
            .get_str("kind")
            .map(|s| s.to_string())
            .unwrap_or_default()
    };
    let _ = kind;

    view! {
        <header class={move || format!("site-header{}", if scrolled.get() { " is-scrolled" } else { "" })}>
            <div class="site-header-inner mx-auto flex w-full max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
                <a class="brand flex min-h-11 items-center gap-2 rounded-md text-lg font-semibold" href="/">
                    <span aria-hidden="true" class="brand-halo size-5 text-primary">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%">
                            <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
                            <circle cx="12" cy="13" r="3" />
                        </svg>
                    </span>
                    <span class="brand-name-text">{Brand::NAME}</span>
                </a>

                <nav aria-label=crate::brand::copy::NAV_LABEL class="site-nav ml-auto hidden items-center gap-1 sm:flex">
                    {Brand::NAV.iter().map(|(label, href)| {
                        view! { <a class="flex min-h-11 items-center rounded-md px-3 text-sm transition text-muted hover:text-foreground" href=*href>{*label}</a> }
                    }).collect_view()}
                </nav>

                <div class="ml-auto flex items-center gap-1 sm:ml-0">
                    <nav aria-label=crate::brand::copy::NAV_LABEL class="mobile-nav-primary">
                        <a class="mobile-nav-link" href="/">{Brand::NAV[0].0}</a>
                        <a class="site-menu-trigger" href="/admin" aria-label=crate::brand::copy::ADMIN_ENTRY>
                            {crate::brand::copy::ADMIN_ENTRY}
                        </a>
                    </nav>
                </div>
            </div>
            <span aria-hidden="true" class="flow-rule" />
        </header>
    }
}
