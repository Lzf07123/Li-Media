// Input / TextArea(对齐 components/ui/Input.tsx):label 包裹的表单控件。
use leptos::prelude::*;

#[component]
pub fn Input(
    #[prop(into)] id: String,
    label: ChildrenFn,
    #[prop(optional, into)] class: Option<String>,
    #[prop(optional, into)] input_type: Option<String>,
    #[prop(optional, into)] value: Option<String>,
    #[prop(optional, into)] placeholder: Option<String>,
    #[prop(optional, into)] disabled: bool,
    #[prop(optional)] on_input: Option<Callback<web_sys::Event>>,
    #[prop(optional)] on_change: Option<Callback<web_sys::Event>>,
) -> impl IntoView {
    view! {
        <label class="flex flex-col gap-2 text-sm" for={id.clone()}>
            {label()}
            <input
                class={format!("input min-h-11 {}", class.unwrap_or_default())}
                id={id.clone()}
                prop:value={move || value.clone().unwrap_or_default()}
                type={move || input_type.clone().unwrap_or_else(|| "text".to_string())}
                placeholder={move || placeholder.clone()}
                disabled={move || disabled.then(|| "disabled".to_string())}
                on:input=move |event: web_sys::Event| {
                    if let Some(on_input) = on_input {
                        on_input.run(event);
                    }
                }
                on:change=move |event: web_sys::Event| {
                    if let Some(on_change) = on_change {
                        on_change.run(event);
                    }
                }
            />
        </label>
    }
}

#[component]
pub fn TextArea(
    #[prop(into)] id: String,
    label: ChildrenFn,
    #[prop(optional, into)] class: Option<String>,
    #[prop(optional, into)] value: Option<String>,
    #[prop(optional, into)] placeholder: Option<String>,
    #[prop(optional, into)] disabled: bool,
    #[prop(optional)] on_input: Option<Callback<web_sys::Event>>,
) -> impl IntoView {
    view! {
        <label class="flex flex-col gap-2 text-sm" for={id.clone()}>
            {label()}
            <textarea
                class={format!("input min-h-28 {}", class.unwrap_or_default())}
                id={id.clone()}
                prop:value={move || value.clone().unwrap_or_default()}
                placeholder={move || placeholder.clone()}
                disabled={move || disabled.then(|| "disabled".to_string())}
                on:input=move |event: web_sys::Event| {
                    if let Some(on_input) = on_input {
                        on_input.run(event);
                    }
                }
            />
        </label>
    }
}
