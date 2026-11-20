// 预热任务卡:对齐 ThumbnailPreheatCard.tsx 的交互与类名。
use leptos::prelude::*;
use wasm_bindgen::JsCast;

use crate::api::admin::ThumbnailPreheatJob;
use crate::brand::{self, Brand};
use crate::components::ui::button::{Button, ButtonVariant};

#[component]
pub fn ThumbnailPreheatCard(
    job: Signal<Option<ThumbnailPreheatJob>>,
    is_starting: Signal<bool>,
    is_cancelling: Signal<bool>,
    on_cancel: Callback<()>,
    on_start: Callback<PreheatStartPayload>,
) -> impl IntoView {
    let selected_sizes = RwSignal::new(vec!["240".to_string()]);
    let selected_kind = RwSignal::new(String::new());
    let limit_input = RwSignal::new(String::new());
    let include_failed = RwSignal::new(false);

    let start = Callback::new(move |_: web_sys::MouseEvent| {
        let sizes = selected_sizes.get();
        let kind = {
            let k = selected_kind.get();
            if k.is_empty() {
                None
            } else {
                Some(k)
            }
        };
        let limit = limit_input.get().parse::<u32>().unwrap_or(0);
        on_start.run(PreheatStartPayload {
            sizes,
            kind,
            limit,
            include_failed: include_failed.get(),
        });
    });

    view! {
        <section aria-labelledby="preheat-title" class="card mt-6 p-6">
            <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 class="text-lg font-semibold" id="preheat-title">
                        {brand::copy::ADMIN_PREHEAT_TITLE}
                    </h2>
                    <p class="mt-2 text-sm text-muted">{brand::copy::ADMIN_PREHEAT_DESCRIPTION}</p>
                </div>
                {move || job.get().as_ref().map(|j| {
                    let status_text = match j.status.as_str() {
                        "queued" => brand::copy::ADMIN_PREHEAT_QUEUED.to_string(),
                        "running" => brand::copy::ADMIN_PREHEAT_RUNNING.to_string(),
                        "completed" => brand::copy::ADMIN_PREHEAT_COMPLETED.to_string(),
                        "cancelled" => brand::copy::ADMIN_PREHEAT_CANCELLED.to_string(),
                        _ => brand::copy::ADMIN_PREHEAT_FAILED.to_string(),
                    };
                    view! {
                        <span class="text-sm text-muted">
                            {format!("{} {}/{}", status_text, j.processed, j.total)}
                        </span>
                    }
                })}
            </div>

            <div class="mt-4 flex flex-wrap items-center gap-2">
                {["240", "480", "768", "1280"].iter().map(|size| {
                    let size_value = size.to_string();
                    let checked = move || selected_sizes.get().iter().any(|s| s == size);
                    view! {
                        <label class="inline-flex min-h-11 items-center gap-2 rounded-md border border-border px-3 text-sm">
                            <input
                                type="checkbox"
                                checked=checked()
                                on:change=move |e| {
                                    let input = e.target().and_then(|t| t.dyn_into::<web_sys::HtmlInputElement>().ok());
                                    if let Some(input) = input {
                                        let mut current = selected_sizes.get();
                                        if input.checked() {
                                            if !current.contains(&size_value) {
                                                current.push(size_value.clone());
                                            }
                                        } else {
                                            current.retain(|s| s != &size_value);
                                        }
                                        selected_sizes.set(current);
                                    }
                                }
                            />
                            {size.to_string()}
                        </label>
                    }
                }).collect_view()}
            </div>

            <div class="mt-3 flex flex-wrap items-center gap-2">
                <select
                    aria-label={brand::copy::ADMIN_PREHEAT_KIND_LABEL}
                    class="min-h-11 rounded-md border border-border bg-surface px-3 text-sm"
                    on:change=move |e| {
                        let select = e.target().and_then(|t| t.dyn_into::<web_sys::HtmlSelectElement>().ok());
                        if let Some(select) = select {
                            selected_kind.set(select.value());
                        }
                    }
                >
                    <option value="">{brand::copy::ADMIN_PREHEAT_KIND_ALL}</option>
                    <option value="photo">{brand::copy::ADMIN_PREHEAT_KIND_PHOTO}</option>
                    <option value="video">{brand::copy::ADMIN_PREHEAT_KIND_VIDEO}</option>
                </select>
                <input
                    aria-label={brand::copy::ADMIN_PREHEAT_LIMIT_LABEL}
                    class="min-h-11 rounded-md border border-border bg-surface px-3 text-sm"
                    placeholder="0 = 全部"
                    type="number"
                    on:input=move |e| {
                        let input = e.target().and_then(|t| t.dyn_into::<web_sys::HtmlInputElement>().ok());
                        if let Some(input) = input {
                            limit_input.set(input.value());
                        }
                    }
                />
                <label class="inline-flex min-h-11 items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked=move || include_failed.get()
                        on:change=move |e| {
                            let input = e.target().and_then(|t| t.dyn_into::<web_sys::HtmlInputElement>().ok());
                            if let Some(input) = input {
                                include_failed.set(input.checked());
                            }
                        }
                    />
                    {brand::copy::ADMIN_PREHEAT_INCLUDE_FAILED}
                </label>
                <Button disabled=move || is_starting.get() on_click=start variant=ButtonVariant::Primary>
                    {if is_starting.get() {
                        brand::copy::ADMIN_PREHEAT_STARTING.to_string()
                    } else {
                        brand::copy::ADMIN_PREHEAT_START.to_string()
                    }}
                </Button>
                {move || job.get().as_ref().and_then(|j| {
                    (j.status == "running" || j.status == "queued").then(|| {
                        view! {
                            <Button disabled=move || is_cancelling.get() on_click=Callback::new(move |_| on_cancel.run(())) variant=ButtonVariant::Secondary>
                                {if is_cancelling.get() {
                                    brand::copy::ADMIN_PREHEAT_CANCELLING.to_string()
                                } else {
                                    brand::copy::ADMIN_PREHEAT_CANCEL.to_string()
                                }}
                            </Button>
                        }
                    })
                })}
            </div>
        </section>
    }
}

#[derive(Clone, Debug)]
pub struct PreheatStartPayload {
    pub sizes: Vec<String>,
    pub kind: Option<String>,
    pub limit: u32,
    pub include_failed: bool,
}
