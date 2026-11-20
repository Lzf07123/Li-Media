// IconButton(对齐 components/ui/IconButton.tsx):与 Button 同一按压涟漪。
use leptos::prelude::*;
use wasm_bindgen::JsCast;

use super::button::spawn_ripple;

#[component]
pub fn IconButton(
    #[prop(optional, into)] class: String,
    #[prop(optional, into)] button_type: Option<String>,
    #[prop(into)] disabled: Signal<bool>,
    #[prop(optional, into)] title: Option<String>,
    #[prop(optional, into)] aria_label: Option<String>,
    #[prop(optional, into)] aria_disabled: Option<bool>,
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
            class={format!("icon-btn {}", class)}
            on:pointerdown=handle_pointer_down
            on:click=move |event: web_sys::MouseEvent| {
                if let Some(on_click) = on_click {
                    on_click.run(event);
                }
            }
            type={move || button_type.clone().unwrap_or_else(|| "button".to_string())}
            title={move || title.clone()}
            aria-label={move || aria_label.clone()}
            aria-disabled={move || aria_disabled.map(|value| value.to_string())}
            disabled={move || disabled.get().then(|| "disabled".to_string())}
        >
            {children()}
        </button>
    }
}
