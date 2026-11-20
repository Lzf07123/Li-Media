// 主题(逐语义对齐 lib/useTheme.ts):V1.5 暗夜档案馆,无存储偏好时
// 默认深色;切换走 html.dark 类;支持动效时经 View Transitions 整页
// 交叉淡入(快照合成),reduced-motion 下瞬时切换。
use leptos::prelude::*;
use wasm_bindgen::{closure::Closure, JsCast};

use crate::brand::Brand;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Theme {
    Light,
    Dark,
}

impl Theme {
    pub fn as_str(self) -> &'static str {
        match self {
            Theme::Light => "light",
            Theme::Dark => "dark",
        }
    }

    fn toggled(self) -> Self {
        match self {
            Theme::Light => Theme::Dark,
            Theme::Dark => Theme::Light,
        }
    }
}

thread_local! {
    static THEME: RwSignal<Theme> = RwSignal::new(read_stored_theme());
}

fn local_storage() -> Option<web_sys::Storage> {
    web_sys::window()
        .and_then(|window| window.local_storage().ok().flatten())
}

/// 无存储偏好时默认深色(与 index.html 内联 theme-init 同一规则)。
pub fn read_stored_theme() -> Theme {
    local_storage()
        .and_then(|storage| storage.get_item(Brand::THEME_STORAGE_KEY).ok().flatten())
        .map(|value| {
            if value == "light" {
                Theme::Light
            } else {
                Theme::Dark
            }
        })
        .unwrap_or(Theme::Dark)
}

/// 全局主题信号(单例;页面任意位置可读取)。
pub fn theme_signal() -> RwSignal<Theme> {
    THEME.with(|theme| *theme)
}

pub fn apply_theme_class(theme: Theme) {
    if let Some(element) = web_sys::window()
        .and_then(|window| window.document())
        .and_then(|document| document.document_element())
    {
        let _ = element.class_list().toggle_with_force("dark", theme == Theme::Dark);
    }
}

/// React useEffect 的对应物:主题变化同步 html.dark 类。
pub fn use_theme_effect() {
    Effect::new(move || {
        let theme = theme_signal().get();
        apply_theme_class(theme);
    });
}

fn prefers_reduced_motion() -> bool {
    web_sys::window()
        .and_then(|window| window.match_media("(prefers-reduced-motion: reduce)").ok())
        .flatten()
        .map(|query| query.matches())
        .unwrap_or(false)
}

/// 用户未显式选择主题时保持默认深色;显式选择后不再自动切换。
pub fn toggle_theme() {
    let theme = theme_signal();
    let next = theme.get_untracked().toggled();

    if let Some(storage) = local_storage() {
        let _ = storage.set_item(Brand::THEME_STORAGE_KEY, next.as_str());
    }

    // View Transitions 可用且允许动效时整页交叉淡入(快照合成,不逐元素
    // 过渡,无闪烁);否则保持瞬时切换。
    if prefers_reduced_motion() {
        theme.set(next);
        return;
    }

    let start_view_transition = web_sys::window()
        .and_then(|window| window.document())
        .and_then(|document| {
            js_sys::Reflect::get(document.as_ref(), &wasm_bindgen::JsValue::from_str(
                "startViewTransition",
            ))
            .ok()
        })
        .and_then(|value| value.dyn_into::<js_sys::Function>().ok());

    match start_view_transition {
        Some(start) => {
            if let Some(document) = web_sys::window().and_then(|window| window.document()) {
                let update = Closure::<dyn Fn()>::new(move || theme.set(next));
                let _ = start.call1(document.as_ref(), update.as_ref().unchecked_ref());
                // 回调由浏览器在捕获旧快照后异步调用,闭包必须常驻。
                std::mem::forget(update);
            }
        }
        None => theme.set(next),
    }
}
