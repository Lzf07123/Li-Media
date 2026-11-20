// Modal(对齐 components/ui/Modal.tsx):backdrop 点击关闭、Escape 关闭、
// Tab 焦点圈定、打开时锁定 body 滚动并保存/恢复焦点。
use std::sync::atomic::{AtomicU32, Ordering};

use leptos::prelude::*;
use wasm_bindgen::JsCast;

use crate::brand::copy;
use super::icon_button::IconButton;
use super::icons::icon_x;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ModalTone {
    Danger,
    Warning,
    Success,
    #[default]
    Info,
}

impl ModalTone {
    pub fn as_class(self) -> &'static str {
        match self {
            ModalTone::Danger => "modal-danger",
            ModalTone::Warning => "modal-warning",
            ModalTone::Success => "modal-success",
            ModalTone::Info => "modal-info",
        }
    }
}

static MODAL_TITLE_SEQUENCE: AtomicU32 = AtomicU32::new(1);

fn next_modal_title_id() -> String {
    format!("modal-title-{}", MODAL_TITLE_SEQUENCE.fetch_add(1, Ordering::Relaxed))
}

fn focusable_elements(panel: &web_sys::Element) -> Vec<web_sys::HtmlElement> {
    let Ok(node_list) = panel.query_selector_all(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
    ) else {
        return Vec::new();
    };
    let length = node_list.length();
    let mut focusable = Vec::with_capacity(length as usize);
    for index in 0..length {
        if let Some(node) = node_list.item(index) {
            if let Some(element) = node.dyn_ref::<web_sys::HtmlElement>() {
                if element.get_attribute("disabled").is_none() {
                    focusable.push(element.clone());
                }
            }
        }
    }
    focusable
}

#[component]
pub fn Modal(
    open: Signal<bool>,
    #[prop(into)] title: String,
    on_close: Callback<()>,
    #[prop(optional)] children: Option<ChildrenFn>,
    #[prop(optional, into)] panel_class: Option<String>,
    #[prop(default = ModalTone::Info)] tone: ModalTone,
) -> impl IntoView {
    let title_id = next_modal_title_id();
    let panel_ref = NodeRef::<leptos::html::Div>::new();

    Effect::new(move || {
        let is_open = open.get();
        if !is_open {
            return;
        }

        let Some(document) = web_sys::window().and_then(|window| window.document()) else {
            return;
        };
        let Some(body) = document.body() else {
            return;
        };
        let document_for_keydown = document.clone();
        let previous_active = document.active_element();
        let previous_overflow = body
            .style()
            .get_property_value("overflow")
            .unwrap_or_default();

        if let Some(panel) = panel_ref.get() {
            let _ = panel.focus();
        }

        let handle_keydown = move |event: web_sys::KeyboardEvent| {
            if event.key() == "Escape" {
                on_close.run(());
                return;
            }

            if event.key() == "Tab" {
                let Some(panel) = panel_ref.get() else {
                    return;
                };
                let focusable = focusable_elements(panel.unchecked_ref::<web_sys::Element>());
                if focusable.is_empty() {
                    return;
                }
                let first = focusable[0].clone();
                let last = focusable[focusable.len() - 1].clone();
                let active = document_for_keydown
                    .active_element()
                    .and_then(|element| element.dyn_ref::<web_sys::HtmlElement>().cloned());
                let is_first = active == Some(first.clone());
                let is_last = active == Some(last.clone());
                if event.shift_key() && is_first {
                    event.prevent_default();
                    let _ = last.focus();
                } else if !event.shift_key() && is_last {
                    event.prevent_default();
                    let _ = first.focus();
                }
            }
        };

        let keydown_listener: wasm_bindgen::closure::Closure<dyn Fn(web_sys::KeyboardEvent)> =
            wasm_bindgen::closure::Closure::new(handle_keydown);
        let _ = document.add_event_listener_with_callback(
            "keydown",
            keydown_listener.as_ref().unchecked_ref(),
        );
        let _ = body.style().set_property("overflow", "hidden");

        // on_cleanup 要求 Send:wasm 对象经 SendWrapper 桥接(CSR 单线程)。
        let document = send_wrapper::SendWrapper::new(document);
        let body = send_wrapper::SendWrapper::new(body);
        let keydown_listener = send_wrapper::SendWrapper::new(keydown_listener);
        let previous_active = previous_active.map(send_wrapper::SendWrapper::new);

        on_cleanup(move || {
            let _ = document.remove_event_listener_with_callback(
                "keydown",
                keydown_listener.as_ref().unchecked_ref(),
            );
            let _ = body.style().set_property("overflow", &previous_overflow);
            if let Some(previous) = previous_active
                .and_then(|element| element.dyn_ref::<web_sys::HtmlElement>().cloned())
            {
                let _ = previous.focus();
            }
        });
    });

    let backdrop_on_close = on_close;
    let tone_class = tone.as_class();
    let panel_class_value = panel_class.unwrap_or_default();

    view! {
        {move || {
            if !open.get() {
                return None;
            }
            Some(view! {
                <div
                    class="modal-backdrop modal-backdrop-in"
                    on:click=move |_: web_sys::MouseEvent| backdrop_on_close.run(())
                >
                    <div
                        aria-labelledby={title_id.clone()}
                        aria-modal="true"
                        class={format!(
                            "modal-panel modal-panel-in {} p-5 sm:p-6 {}",
                            tone_class,
                            panel_class_value
                        )}
                        on:click=move |event: web_sys::MouseEvent| event.stop_propagation()
                        node_ref={panel_ref}
                        role="dialog"
                        tabindex="-1"
                    >
                        <div class="flex items-start gap-3">
                            <h2 class="text-lg font-semibold" id={title_id.clone()}>
                                {title.clone()}
                            </h2>
                            <IconButton
                                aria_label={copy::CLOSE.to_string()}
                                class="ml-auto"
                                disabled={false}
                                on_click={Callback::new(move |_| backdrop_on_close.run(()))}
                            >
                                {icon_x("")}
                            </IconButton>
                        </div>
                        {children.as_ref().map(|children| children())}
                    </div>
                </div>
            })
        }}
    }
}
