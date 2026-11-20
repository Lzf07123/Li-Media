// 沉浸式页眉:超过 8px 切换同源雾化层;导航激活由 kind 查询参数判定
// (对齐 SiteHeader.tsx 的语义,M7 补菜单 details 交互)。
use leptos::prelude::*;
use leptos_router::hooks::use_query_map;
use leptos_router::hooks::use_location;
use wasm_bindgen::JsCast;

use crate::brand::{self, Brand};
use crate::lib::theme::{theme_signal, toggle_theme, use_theme_effect};

const SCROLLED_THRESHOLD_PX: f64 = 8.0;

#[component]
pub fn SiteHeader() -> impl IntoView {
    let scrolled = RwSignal::new(false);
    use_theme_effect();
    let theme = theme_signal();

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
                        <details class="site-menu">
                            <summary aria-label={crate::brand::copy::MORE_MENU.to_string()} class="site-menu-trigger">
                                <span class="visually-hidden">{crate::brand::copy::MORE_MENU}</span>
                            </summary>
                            <nav aria-label={crate::brand::copy::MORE_MENU.to_string()} class="site-menu-panel">
                                {Brand::NAV.iter().skip(1).map(|(label, href)| {
                                    view! { <a class="site-menu-item" href=*href>{*label}</a> }
                                }).collect_view()}
                                <span aria-hidden="true" class="site-menu-sep" />
                                <a class="site-menu-item" href="/admin">{crate::brand::copy::ADMIN_ENTRY}</a>
                            </nav>
                        </details>
                    </nav>

                    <button
                        aria-label={move || if theme.get() == crate::lib::theme::Theme::Dark {
                            crate::brand::copy::THEME_LIGHT.to_string()
                        } else {
                            crate::brand::copy::THEME_DARK.to_string()
                        }}
                        title={move || if theme.get() == crate::lib::theme::Theme::Dark {
                            crate::brand::copy::THEME_LIGHT.to_string()
                        } else {
                            crate::brand::copy::THEME_DARK.to_string()
                        }}
                        class="inline-flex min-h-11 items-center justify-center rounded-md px-2 text-foreground"
                        on:click=move |_| toggle_theme()
                    >
                        {move || if theme.get() == crate::lib::theme::Theme::Dark {
                            view! {
                                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em">
                                    <circle cx="12" cy="12" r="4" />
                                    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
                                </svg>
                            }.into_any()
                        } else {
                            view! {
                                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em">
                                    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
                                </svg>
                            }.into_any()
                        }}
                    </button>
                </div>
            </div>
            <span aria-hidden="true" class="flow-rule" />
        </header>
    }
}
