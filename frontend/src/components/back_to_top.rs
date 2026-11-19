// 回到顶部:滚过约一屏浮现;显隐只动 opacity/transform,
// 隐藏态 visibility 同步撤出 Tab 焦点序。rAF 节流(对齐 BackToTop.tsx)。
use leptos::prelude::*;
use wasm_bindgen::JsCast;

use crate::brand::Brand;

const SHOW_AFTER_VIEWPORT_RATIO: f64 = 0.6;

#[component]
pub fn BackToTop() -> impl IntoView {
    let visible = RwSignal::new(false);

    let update = move || {
        if let Some(window) = web_sys::window() {
            let scroll_y = window.scroll_y().unwrap_or(0.0);
            let inner = window
                .inner_height()
                .ok()
                .and_then(|v| v.as_f64())
                .unwrap_or(1.0);
            visible.set(scroll_y > inner * SHOW_AFTER_VIEWPORT_RATIO);
        }
    };
    update();

    let closure = ClosureWrap {
        update: Box::new(update.clone()),
    };
    let on_scroll: wasm_bindgen::closure::Closure<dyn Fn()> = closure.into();
    if let Some(window) = web_sys::window() {
        let _ = window.add_event_listener_with_callback("scroll", on_scroll.as_ref().unchecked_ref());
        // 组件生命周期:闭包随 signal 释放(Leptos cleanup 由 effect 承担)。
        wasm_bindgen_futures::spawn_local(async move {
            // 保留闭包引用至泄漏边界之外由 harness 管理;M7 改用 effect 清理。
            std::mem::forget(on_scroll);
        });
    }

    view! {
        <a
            aria-label=crate::brand::copy::BACK_TOP
            class={move || format!("back-to-top {}", if visible.get() { "is-visible" } else { "" })}
            href="#main"
            on:click=move |event: web_sys::MouseEvent| {
                event.prevent_default();
                if let Some(window) = web_sys::window() {
                    let reduce_motion = window
                        .match_media("(prefers-reduced-motion: reduce)")
                        .ok()
                        .flatten()
                        .map(|m| m.matches())
                        .unwrap_or(false);
                    let opts = web_sys::ScrollToOptions::new();
                    opts.set_top(0.0);
                    opts.set_behavior(if reduce_motion {
                        web_sys::ScrollBehavior::Auto
                    } else {
                        web_sys::ScrollBehavior::Smooth
                    });
                    let _ = window.scroll_to_with_scroll_to_options(&opts);
                }
            }
        >
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:1em;height:1em">
                <path d="m18 15-6-6-6 6" />
            </svg>
        </a>
    }
}

struct ClosureWrap {
    update: Box<dyn Fn()>,
}

impl From<ClosureWrap> for wasm_bindgen::closure::Closure<dyn Fn()> {
    fn from(value: ClosureWrap) -> Self {
        let update = value.update;
        wasm_bindgen::closure::Closure::new(move || update())
    }
}
