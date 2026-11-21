// 预热任务卡:逐语义对齐 ThumbnailPreheatCard.tsx(尺寸预设/类型/上限/
// 预估/任务进度与派生明细)。
use leptos::prelude::*;

use crate::api::admin::{preview_thumbnail_preheat, ThumbnailPreheatJob};
use crate::brand::{self, Brand};
use crate::components::ui::button::{Button, ButtonVariant};
use crate::components::ui::icons::{icon_images, icon_refresh_cw};
use crate::components::ui::progress_bar::{ProgressBar, ProgressBarTone};
use crate::lib::format::format_bytes;

#[derive(Clone, Debug)]
pub struct PreheatStartPayload {
    pub sizes: Vec<String>,
    pub kind: Option<String>,
    pub limit: u32,
    pub include_failed: bool,
}

#[component]
pub fn ThumbnailPreheatCard(
    job: Signal<Option<ThumbnailPreheatJob>>,
    is_starting: Signal<bool>,
    is_cancelling: Signal<bool>,
    on_cancel: Callback<()>,
    on_start: Callback<PreheatStartPayload>,
) -> impl IntoView {
    let size_preset = RwSignal::new("home".to_string());
    let selected_kind = RwSignal::new(String::new());
    let limit_input = RwSignal::new("0".to_string());
    let include_failed = RwSignal::new(false);
    let preview_total = RwSignal::new(Option::<u32>::None);

    // 启动前预估影响面:尺寸/类型/包含失败项变化即重估(300ms 防抖)。
    Effect::new(move |_| {
        let preset = size_preset.get();
        let kind_value = selected_kind.get();
        let include_failed_value = include_failed.get();
        preview_total.set(None);
        let sizes: Vec<String> = if preset == "detail" {
            vec!["480".to_string(), "1280".to_string()]
        } else {
            vec!["240".to_string()]
        };
        let kind_ref = (!kind_value.is_empty()).then_some(kind_value);

        let timer: Rc<Cell<Option<i32>>> = Rc::new(Cell::new(None));
        let callback: Closure<dyn Fn()> = {
            let preview_total = preview_total;
            let timer_for_callback = timer.clone();
            let sizes = sizes.clone();
            let kind_ref = kind_ref.clone();
            Closure::new(move || {
                timer_for_callback.set(None);
                let sizes = sizes.clone();
                let kind_ref = kind_ref.clone();
                wasm_bindgen_futures::spawn_local(async move {
                    let size_refs: Vec<&str> = sizes.iter().map(|s| s.as_str()).collect();
                    let total = preview_thumbnail_preheat(&size_refs, kind_ref.as_deref())
                        .await
                        .ok();
                    preview_total.set(total);
                });
            })
        };
        if let Some(window) = web_sys::window() {
            let id = window
                .set_timeout_with_callback_and_timeout_and_arguments_0(
                    callback.as_ref().unchecked_ref(),
                    300,
                )
                .ok();
            timer.set(id);
        }
        let timer = send_wrapper::SendWrapper::new(timer);
        let callback = send_wrapper::SendWrapper::new(callback);
        on_cleanup(move || {
            if let Some(id) = (**timer).get() {
                if let Some(window) = web_sys::window() {
                    let _ = window.clear_timeout_with_handle(id);
                }
            }
            drop(callback);
        });
    });

    let start = Callback::new(move |_: web_sys::MouseEvent| {
        let preset = size_preset.get_untracked();
        let sizes: Vec<String> = if preset == "detail" {
            vec!["480".to_string(), "1280".to_string()]
        } else {
            vec!["240".to_string()]
        };
        let kind_value = selected_kind.get_untracked();
        let kind = (!kind_value.is_empty()).then_some(kind_value);
        let limit = limit_input
            .get_untracked()
            .parse::<u32>()
            .unwrap_or(0)
            .min(5000);
        on_start.run(PreheatStartPayload {
            sizes,
            kind,
            limit,
            include_failed: include_failed.get_untracked(),
        });
    });

    let is_job_active = move || {
        job.get()
            .is_some_and(|j| j.status == "queued" || j.status == "running")
    };
    let scope_copy = move || match selected_kind.get().as_str() {
        "photo" => brand::copy::ADMIN_PREHEAT_PHOTO.to_string(),
        "video" => brand::copy::ADMIN_PREHEAT_VIDEO.to_string(),
        _ => brand::copy::ADMIN_PREHEAT_ALL_KINDS.to_string(),
    };

    view! {
        <div class="card mt-4 p-4">
            <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="flex items-start gap-2">
                    {icon_images("mt-1 size-4 text-primary")}
                    <div>
                        <h3 class="text-sm font-semibold">{brand::copy::ADMIN_PREHEAT_TITLE}</h3>
                        <p class="mt-1 text-xs text-muted">{brand::copy::ADMIN_PREHEAT_DESCRIPTION}</p>
                    </div>
                </div>
                <div class="flex gap-2">
                    {move || {
                        is_job_active().then(|| {
                            view! {
                                <Button
                                    disabled=move || is_cancelling.get()
                                    on_click=Callback::new(move |_: web_sys::MouseEvent| on_cancel.run(()))
                                    variant=ButtonVariant::Danger
                                >
                                    {move || {
                                        if is_cancelling.get() {
                                            brand::copy::ADMIN_PREHEAT_CANCELLING.to_string()
                                        } else {
                                            brand::copy::ADMIN_PREHEAT_CANCEL.to_string()
                                        }
                                    }}
                                </Button>
                            }
                        })
                    }}
                    <Button
                        disabled=move || is_starting.get() || is_job_active()
                        on_click=start
                        variant=ButtonVariant::Primary
                    >
                        {move || {
                            if is_starting.get() || is_job_active() {
                                brand::copy::ADMIN_PREHEAT_STARTING.to_string()
                            } else {
                                brand::copy::ADMIN_PREHEAT_START.to_string()
                            }
                        }}
                    </Button>
                </div>
            </div>

            <div class="mt-4 grid gap-3 sm:grid-cols-3">
                <label class="flex flex-col gap-2 text-sm" for="preheat-size">
                    {brand::copy::ADMIN_PREHEAT_SIZE}
                    <select
                        class="select min-h-11"
                        id="preheat-size"
                        on:change=move |e| {
                            let select = e.target().and_then(|t| t.dyn_into::<web_sys::HtmlSelectElement>().ok());
                            if let Some(select) = select {
                                size_preset.set(select.value());
                            }
                        }
                        prop:value=move || size_preset.get()
                    >
                        <option value="home">{brand::copy::ADMIN_PREHEAT_HOME}</option>
                        <option value="detail">{brand::copy::ADMIN_PREHEAT_DETAIL}</option>
                    </select>
                </label>

                <label class="flex flex-col gap-2 text-sm" for="preheat-kind">
                    {brand::copy::ADMIN_PREHEAT_KIND}
                    <select
                        class="select min-h-11"
                        id="preheat-kind"
                        on:change=move |e| {
                            let select = e.target().and_then(|t| t.dyn_into::<web_sys::HtmlSelectElement>().ok());
                            if let Some(select) = select {
                                selected_kind.set(select.value());
                            }
                        }
                        prop:value=move || selected_kind.get()
                    >
                        <option value="">{brand::copy::ADMIN_PREHEAT_ALL_KINDS}</option>
                        <option value="photo">{brand::copy::ADMIN_PREHEAT_PHOTO}</option>
                        <option value="video">{brand::copy::ADMIN_PREHEAT_VIDEO}</option>
                    </select>
                </label>

                <label class="flex flex-col gap-2 text-sm" for="preheat-limit">
                    {brand::copy::ADMIN_PREHEAT_LIMIT_LABEL}
                    <input
                        class="input min-h-11"
                        id="preheat-limit"
                        inputmode="numeric"
                        max="5000"
                        min="0"
                        on:input=move |e| {
                            let input = e.target().and_then(|t| t.dyn_into::<web_sys::HtmlInputElement>().ok());
                            if let Some(input) = input {
                                limit_input.set(input.value());
                            }
                        }
                        prop:value=move || limit_input.get()
                        type="number"
                    />
                    <span class="text-xs text-muted">{brand::copy::ADMIN_PREHEAT_LIMIT_HINT}</span>
                </label>
            </div>

            <p class="mt-3 text-xs text-muted">
                {brand::copy::ADMIN_PREHEAT_SCOPE}
                {": "}
                {move || scope_copy()}
                {move || {
                    let estimated = preview_total.get().map(|total| {
                        let limit = limit_input.get().parse::<u32>().unwrap_or(0).min(5000);
                        if limit > 0 { limit.min(total) } else { total }
                    });
                    estimated.map(|total| {
                        view! {
                            <span class="ml-2">
                                {brand::copy::ADMIN_PREHEAT_ESTIMATED
                                    .replace("{total}", &total.to_string())}
                            </span>
                        }
                    })
                }}
            </p>

            <label class="mt-2 flex items-start gap-2 text-xs text-muted">
                <input
                    checked=move || include_failed.get()
                    class="mt-0.5 size-4 shrink-0"
                    on:change=move |e| {
                        let input = e.target().and_then(|t| t.dyn_into::<web_sys::HtmlInputElement>().ok());
                        if let Some(input) = input {
                            include_failed.set(input.checked());
                        }
                    }
                    type="checkbox"
                />
                <span>
                    {brand::copy::ADMIN_PREHEAT_INCLUDE_FAILED}
                    <span class="ml-1">{brand::copy::ADMIN_PREHEAT_INCLUDE_FAILED_HINT}</span>
                </span>
            </label>

            {move || {
                let current = job.get()?;
                let status_text = match current.status.as_str() {
                    "queued" => brand::copy::ADMIN_PREHEAT_QUEUED.to_string(),
                    "running" => brand::copy::ADMIN_PREHEAT_RUNNING.to_string(),
                    "completed" => brand::copy::ADMIN_PREHEAT_COMPLETED.to_string(),
                    "cancelled" => brand::copy::ADMIN_PREHEAT_CANCELLED.to_string(),
                    _ => brand::copy::ADMIN_PREHEAT_FAILED.to_string(),
                };
                Some(view! {
                    <div class="mt-4">
                        <div class="flex flex-wrap items-center justify-between gap-2">
                            <span class="text-xs text-muted">
                                {brand::copy::ADMIN_PREHEAT_STATUS}
                                {": "}
                                {status_text}
                            </span>
                            <span class="text-xs text-muted">
                                {format!(
                                    "{}/{}",
                                    current.processed,
                                    if current.total > 0 { current.total } else { current.limit },
                                )}
                            </span>
                        </div>
                        <ProgressBar
                            label=brand::copy::ADMIN_PREHEAT_TITLE.to_string()
                            tone={if current.status == "failed" { ProgressBarTone::Danger } else { ProgressBarTone::Primary } }
                            value={if current.total > 0 { (current.processed as f64 / current.total as f64) * 100.0 } else { 0.0 } }
                        />
                        <dl class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-9">
                            <div>
                                <dt class="text-xs text-muted">{brand::copy::ADMIN_PREHEAT_GENERATED}</dt>
                                <dd class="text-sm font-medium">{current.generated}</dd>
                            </div>
                            <div>
                                <dt class="text-xs text-muted">{brand::copy::ADMIN_PREHEAT_CACHED}</dt>
                                <dd class="text-sm font-medium">{current.cached}</dd>
                            </div>
                            <div>
                                <dt class="text-xs text-muted">{brand::copy::ADMIN_PREHEAT_FAILED_COUNT}</dt>
                                <dd class="text-sm font-medium">{current.failed}</dd>
                            </div>
                            <div>
                                <dt class="text-xs text-muted">{brand::copy::ADMIN_PREHEAT_SKIPPED}</dt>
                                <dd class="text-sm font-medium">{current.skipped}</dd>
                            </div>
                            <div>
                                <dt class="text-xs text-muted">{brand::copy::ADMIN_PREHEAT_SIZE}</dt>
                                <dd class="text-sm font-medium">
                                    {format!("{}px", current.sizes.iter().map(|s| s.to_string()).collect::<Vec<_>>().join(" / "))}
                                </dd>
                            </div>
                            <div>
                                <dt class="text-xs text-muted">{brand::copy::ADMIN_PREHEAT_SOURCE_BYTES}</dt>
                                <dd class="text-sm font-medium">
                                    {format_bytes(Some(current.source_bytes_downloaded))
                                        .unwrap_or_else(|| "-".to_string())}
                                </dd>
                            </div>
                            <div>
                                <dt class="text-xs text-muted">{brand::copy::ADMIN_PREHEAT_DURATION}</dt>
                                <dd class="text-sm font-medium">{format!("{}ms", current.derivative_duration_ms)}</dd>
                            </div>
                            <div>
                                <dt class="text-xs text-muted">{brand::copy::ADMIN_PREHEAT_CONCURRENCY}</dt>
                                <dd class="text-sm font-medium">{current.concurrency}</dd>
                            </div>
                            <div>
                                <dt class="text-xs text-muted">{brand::copy::ADMIN_PREHEAT_QUEUE_LIMIT}</dt>
                                <dd class="text-sm font-medium">{current.queue_limit}</dd>
                            </div>
                        </dl>
                        {current.message.as_ref().map(|message| {
                            view! { <p class="mt-3 break-all text-xs text-muted">{message.clone()}</p> } })}
                        <SizeResultChips job=current.clone() />
                    </div>
                })
            }}
        </div>
    }
}

// 读取 Closure 类型(本文件内使用)。
use std::cell::Cell;
use std::rc::Rc;
use wasm_bindgen::closure::Closure;
use wasm_bindgen::JsCast;

#[component]
fn SizeResultChips(job: ThumbnailPreheatJob) -> impl IntoView {
    let size_results = job
        .size_results
        .as_object()
        .cloned()
        .unwrap_or_default();
    let chips: Vec<_> = job
        .sizes
        .iter()
        .filter_map(|size| {
            let result = size_results.get(&size.to_string())?;
            let generated = result.get("generated").and_then(|v| v.as_i64()).unwrap_or(0);
            let cached = result.get("cached").and_then(|v| v.as_i64()).unwrap_or(0);
            let failed = result.get("failed").and_then(|v| v.as_i64()).unwrap_or(0);
            let skipped = result.get("skipped").and_then(|v| v.as_i64()).unwrap_or(0);
            let mut parts = vec![
                format!("{} {}", brand::copy::ADMIN_PREHEAT_GENERATED, generated),
                format!("{} {}", brand::copy::ADMIN_PREHEAT_CACHED, cached),
                format!("{} {}", brand::copy::ADMIN_PREHEAT_FAILED_COUNT, failed),
            ];
            if skipped > 0 {
                parts.push(format!("{} {}", brand::copy::ADMIN_PREHEAT_SKIPPED, skipped));
            }
            Some(format!("{}px · {}", size, parts.join(" · ")))
        })
        .collect();
    {(!chips.is_empty()).then(|| {
        let items: Vec<_> = chips
            .into_iter()
            .map(|chip| view! { <span class="badge badge-muted">{chip}</span> })
            .collect();
        view! { <div class="mt-3 flex flex-wrap gap-2">{items}</div> }
    })}
}

// icon_refresh_cw 备用:预热卡片无旋转图标,保留导入面一致。
#[allow(dead_code)]
fn icon_unused() -> impl IntoView {
    icon_refresh_cw("")
}
