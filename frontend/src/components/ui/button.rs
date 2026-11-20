// Button(对齐 components/ui/Button.tsx):variant 类名 + 按压涟漪。
use leptos::prelude::*;
use wasm_bindgen::JsCast;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ButtonVariant {
    #[default]
    Primary,
    Secondary,
    Danger,
    Ghost,
}

impl ButtonVariant {
    pub fn as_class(self) -> &'static str {
        match self {
            ButtonVariant::Primary => "btn-primary",
            ButtonVariant::Secondary => "btn-secondary",
            ButtonVariant::Danger => "btn-danger",
            ButtonVariant::Ghost => "btn-ghost",
        }
    }
}

/// 与 IconButton 共用的按压涟漪:以点击点为圆心铺满按钮短边两倍直径。
pub(crate) fn spawn_ripple(button: &web_sys::HtmlElement, client_x: f64, client_y: f64) {
    let Some(document) = web_sys::window().and_then(|window| window.document()) else {
        return;
    };
    let rect = button.get_bounding_client_rect();
    let size = rect.width().max(rect.height()) * 2.0;
    let Ok(ripple) = document.create_element("span") else {
        return;
    };
    let _ = ripple.set_attribute("class", "btn-ripple");
    let _ = ripple.set_attribute(
        "style",
        &format!(
            "width: {}px; height: {}px; left: {}px; top: {}px",
            size,
            size,
            client_x - rect.left() - size / 2.0,
            client_y - rect.top() - size / 2.0,
        ),
    );
    let ripple_element = ripple.clone();
    let on_animation_end: wasm_bindgen::closure::Closure<dyn Fn()> =
        wasm_bindgen::closure::Closure::new(move || {
            let _ = ripple_element.remove();
        });
    let _ = ripple.add_event_listener_with_callback(
        "animationend",
        on_animation_end.as_ref().unchecked_ref(),
    );
    // 一次性监听:动画结束后元素移除,闭包随元素进入垃圾回收边界。
    std::mem::forget(on_animation_end);
    let _ = button.append_child(&ripple);
}

#[component]
pub fn Button(
    #[prop(optional, into)] class: String,
    #[prop(default = ButtonVariant::Primary)] variant: ButtonVariant,
    #[prop(optional, into)] button_type: Option<String>,
    #[prop(into)] disabled: Signal<bool>,
    #[prop(optional, into)] title: Option<String>,
    #[prop(optional, into)] aria_label: Option<String>,
    #[prop(optional)] on_click: Option<Callback<web_sys::MouseEvent>>,
    #[prop(optional)] on_pointer_down: Option<Callback<web_sys::PointerEvent>>,
    children: Children,
) -> impl IntoView {
    let node_ref = NodeRef::<leptos::html::Button>::new();

    let handle_pointer_down = move |event: web_sys::PointerEvent| {
        if let Some(button) = node_ref.get() {
            spawn_ripple(
                button.unchecked_ref::<web_sys::HtmlElement>(),
                event.client_x() as f64,
                event.client_y() as f64,
            );
        }
        if let Some(on_pointer_down) = on_pointer_down {
            on_pointer_down.run(event);
        }
    };

    view! {
        <button
            node_ref={node_ref}
            class={format!("btn {} {}", variant.as_class(), class)}
            on:pointerdown=handle_pointer_down
            on:click=move |event: web_sys::MouseEvent| {
                if let Some(on_click) = on_click {
                    on_click.run(event);
                }
            }
            type={move || button_type.clone().unwrap_or_else(|| "button".to_string())}
            title={move || title.clone()}
            aria-label={move || aria_label.clone()}
            disabled={move || disabled.get().then(|| "disabled".to_string())}
        >
            {children()}
        </button>
    }
}
