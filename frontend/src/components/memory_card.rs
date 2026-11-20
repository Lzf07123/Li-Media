// MemoryCard(逐语义对齐 components/MemoryCard.tsx):IntersectionObserver
// 240px 预载带 + 滚出滞回带挂起 + 队列加载缩略图 + 自动退避重试 + 交错入场。
use std::cell::Cell;
use std::rc::Rc;

use leptos::prelude::*;
use wasm_bindgen::{closure::Closure, JsCast};

use crate::api::{append_query_param, resolve_thumbnail_url};
use crate::api::types::MemorySummary;
use crate::brand::copy;
use crate::components::ui::icons::{icon_image, icon_play, icon_rotate_ccw, icon_video};
use crate::lib::format::{format_date, format_duration};
use crate::lib::image_load_queue::{
    load_queued_image, ImageLoadError, ImageLoadOptions, ImageLoadPriority,
};
use crate::lib::media_state::{
    is_failure_media_state, reduce_media_lifecycle, MediaLifecycleAction,
    MediaLifecycleActionType, MediaLifecycleMap, MediaScope,
};

const AUTO_RETRY_LIMIT: u32 = 3;
const AUTO_RETRY_DELAYS_MS: [i32; 3] = [1000, 2000, 4000];
// 滚出视口超过该距离后挂起排队中的缩略图任务,释放队列槽位给当前
// 可见的卡片;滞后于 240px 预载带,避免在边界上反复取消/重启。
const SUSPEND_MARGIN_PX: f64 = 900.0;
// 画布可见性以 240px 预热就绪为门槛。
const PRELOAD_BAND_PX: f64 = 240.0;
// 卡片固定取 240px 派生图:预热即所得,公开画布零按需生成。
const CARD_THUMBNAIL_SIZE: &str = "240";

/// preview 通道的状态派发(useReducer 对应物)。
fn dispatch_preview(map: &RwSignal<MediaLifecycleMap>, kind: MediaLifecycleActionType) {
    map.set(reduce_media_lifecycle(
        &map.get_untracked(),
        MediaLifecycleAction::Scoped {
            scope: MediaScope::Preview,
            kind,
        },
    ));
}

#[component]
pub fn MemoryCard(
    memory: MemorySummary,
    on_open: Callback<String>,
    #[prop(into)] on_prefetch: Option<Callback<()>>,
    #[prop(default = false)] priority: bool,
    /// 画布交错入场的全局序号:映射为 --card-enter-index,延迟上限由 CSS 收口。
    #[prop(default = 0)] enter_index: u32,
) -> impl IntoView {
    let media_state = RwSignal::new(MediaLifecycleMap::new());
    let thumbnail_failed = RwSignal::new(false);
    let natural_size: RwSignal<Option<(f64, f64)>> = RwSignal::new(None);
    let queued_thumbnail_url: RwSignal<Option<String>> = RwSignal::new(None);
    let show_shimmer = RwSignal::new(false);
    let is_intersecting = RwSignal::new(priority);
    let is_in_view = RwSignal::new(priority);
    let load_suspended = RwSignal::new(false);
    let retry_attempt = RwSignal::new(0u32);
    let visibility_tick = RwSignal::new(0u64);

    let card_ref = NodeRef::<leptos::html::Div>::new();

    let thumbnail_url = memory
        .thumbnail_url
        .as_deref()
        .and_then(|path| resolve_thumbnail_url(Some(path), CARD_THUMBNAIL_SIZE));
    let thumbnail_url_for_memo = thumbnail_url.clone();
    let retry_thumbnail_url = Memo::new(move |_| {
        let attempt = retry_attempt.get();
        (attempt > 0)
            .then(|| {
                thumbnail_url_for_memo
                    .as_ref()
                    .map(|url| append_query_param(url, "retry", &attempt.to_string()))
            })
            .flatten()
    });

    let known_size = match (memory.width, memory.height) {
        (Some(width), Some(height)) if width > 0 && height > 0 => {
            Some((width as f64, height as f64))
        }
        _ => None,
    };
    let media_style = move || {
        match known_size.or(natural_size.get()) {
            Some((width, height)) => format!("aspect-ratio: {} / {}", width, height),
            None => "min-height: 160px".to_string(),
        }
    };

    // IntersectionObserver:进入 240px 预载带才允许加载(不可用时直接可见)。
    Effect::new(move || {
        let is_intersecting_signal = is_intersecting;
        let callback: Closure<dyn Fn(Vec<web_sys::IntersectionObserverEntry>, web_sys::IntersectionObserver)> =
            Closure::new(
                move |entries: Vec<web_sys::IntersectionObserverEntry>,
                      observer: web_sys::IntersectionObserver| {
                let in_view = entries.iter().any(|entry| entry.is_intersecting());
                if in_view {
                    is_intersecting_signal.set(true);
                    observer.disconnect();
                }
                },
            );
        let mut options = web_sys::IntersectionObserverInit::new();
        options.root_margin("240px 0px");
        options.threshold(&wasm_bindgen::JsValue::from_f64(0.01));
        match web_sys::IntersectionObserver::new_with_options(
            callback.as_ref().unchecked_ref(),
            &options,
        ) {
            Ok(observer) => {
                if let Some(card) = card_ref.get() {
                    observer.observe(card.unchecked_ref::<web_sys::Element>());
                }
                // 回调闭包随 observer 常驻(页面生命周期级别)。
                std::mem::forget(callback);
                let observer = send_wrapper::SendWrapper::new(observer);
                on_cleanup(move || observer.disconnect());
            }
            Err(_) => {
                // 对齐 typeof IntersectionObserver === "undefined" 的降级。
                is_intersecting.set(true);
                std::mem::forget(callback);
            }
        }
    });

    // 滚动/缩放监听:rAF 节流(reactivity 批处理等效)经 visibility_tick
    // 驱动下方 effect 重新求值可见性(对齐 scheduleVisibility)。
    Effect::new(move || {
        let tick = visibility_tick;
        tick.update(|value| *value += 1);
        let schedule: Closure<dyn Fn()> = Closure::new(move || {
            tick.update(|value| *value += 1);
        });
        let schedule_ref = schedule.as_ref().unchecked_ref();
        if let Some(window) = web_sys::window() {
            let scroll_options = {
                let mut options = web_sys::AddEventListenerOptions::new();
                options.passive(true);
                options
            };
            let _ = window.add_event_listener_with_callback_and_add_event_listener_options(
                "scroll",
                schedule_ref,
                &scroll_options,
            );
            let _ = window.add_event_listener_with_callback("resize", schedule_ref);
        }
        let schedule = send_wrapper::SendWrapper::new(schedule);
        on_cleanup(move || {
            if let Some(window) = web_sys::window() {
                let _ = window.remove_event_listener_with_callback(
                    "scroll",
                    schedule.as_ref().unchecked_ref(),
                );
                let _ = window.remove_event_listener_with_callback(
                    "resize",
                    schedule.as_ref().unchecked_ref(),
                );
            }
        });
    });

    // 可见性 / 挂起带求值:updateVisibility。
    Effect::new(move || {
        let _ = visibility_tick.get();
        let Some(window) = web_sys::window() else {
            return;
        };
        let Some(card) = card_ref.get() else {
            return;
        };
        let inner_height = window
            .inner_height()
            .ok()
            .and_then(|value| value.as_f64())
            .unwrap_or(0.0);
        let rect = card
            .unchecked_ref::<web_sys::Element>()
            .get_bounding_client_rect();
        let top = rect.top();
        let bottom = rect.bottom();
        is_in_view.set(bottom > -PRELOAD_BAND_PX && top < inner_height + PRELOAD_BAND_PX);
        load_suspended.set(bottom < -SUSPEND_MARGIN_PX || top > inner_height + SUSPEND_MARGIN_PX);
    });

    // 队列加载缩略图:依赖 isIntersecting / loadSuspended / retryAttempt;
    // effect 重跑前 cleanup 先 abort 队列任务释放槽位。
    let thumbnail_url_for_loader = thumbnail_url.clone();
    Effect::new(move || {
        let intersecting = is_intersecting.get();
        let suspended = load_suspended.get();
        let retry = retry_attempt.get();
        let retry_url = (retry > 0)
            .then(|| {
                thumbnail_url_for_loader
                    .as_ref()
                    .map(|url| append_query_param(url, "retry", &retry.to_string()))
            })
            .flatten();

        let Some(thumbnail_url) = thumbnail_url_for_loader.clone() else {
            queued_thumbnail_url.set(None);
            media_state.set(MediaLifecycleMap::new());
            return;
        };
        if !intersecting {
            queued_thumbnail_url.set(None);
            media_state.set(MediaLifecycleMap::new());
            return;
        }

        // 卡片滚出滞回带后 park 在 queued 状态;滚回时重新入队。
        if suspended {
            dispatch_preview(&media_state, MediaLifecycleActionType::Queued);
            return;
        }

        dispatch_preview(&media_state, MediaLifecycleActionType::Queued);
        dispatch_preview(&media_state, MediaLifecycleActionType::Load);
        thumbnail_failed.set(false);
        natural_size.set(None);
        queued_thumbnail_url.set(None);

        let request_url = retry_url.unwrap_or_else(|| thumbnail_url.clone());
        let handle = load_queued_image(
            &request_url,
            ImageLoadOptions {
                retries: 4,
                priority: if priority {
                    ImageLoadPriority::High
                } else {
                    ImageLoadPriority::Normal
                },
            },
        );

        // 自动重试定时器与 abort 句柄都挂到本轮 effect 清理上。
        let auto_retry_timer: Rc<Cell<Option<i32>>> = Rc::new(Cell::new(None));
        let abort_handle = send_wrapper::SendWrapper::new(handle.clone());
        let timer_for_cleanup = send_wrapper::SendWrapper::new(auto_retry_timer.clone());
        on_cleanup(move || {
            abort_handle.abort();
            if let Some(timer_id) = (**timer_for_cleanup).take() {
                if let Some(window) = web_sys::window() {
                    let _ = window.clear_timeout_with_handle(timer_id);
                }
            }
        });

        let media_state_for_load = media_state;
        let natural_size_for_load = natural_size;
        let queued_for_load = queued_thumbnail_url;
        let thumbnail_url_for_load = thumbnail_url.clone();
        wasm_bindgen_futures::spawn_local(async move {
            match handle.await {
                Ok(image) => {
                    queued_for_load.set(Some(thumbnail_url_for_load));
                    let width = image.natural_width();
                    let height = image.natural_height();
                    if width > 0 && height > 0 {
                        natural_size_for_load.set(Some((width as f64, height as f64)));
                    }
                    dispatch_preview(&media_state_for_load, MediaLifecycleActionType::Ready);
                }
                Err(ImageLoadError::Aborted) => {}
                Err(_) => {
                    thumbnail_failed.set(true);
                    dispatch_preview(&media_state_for_load, MediaLifecycleActionType::Fail);

                    if retry < AUTO_RETRY_LIMIT {
                        let delay = AUTO_RETRY_DELAYS_MS[(retry as usize).min(AUTO_RETRY_DELAYS_MS.len() - 1)];
                        let media_state_for_retry = media_state_for_load;
                        let retry_attempt_for_retry = retry_attempt;
                        let timer_for_retry = auto_retry_timer.clone();
                        let callback: Closure<dyn Fn()> = Closure::new(move || {
                            dispatch_preview(&media_state_for_retry, MediaLifecycleActionType::Retry);
                            retry_attempt_for_retry.set(retry + 1);
                        });
                        if let Some(window) = web_sys::window() {
                            let timer_id = window
                                .set_timeout_with_callback_and_timeout_and_arguments_0(
                                    callback.as_ref().unchecked_ref(),
                                    delay,
                                )
                                .ok();
                            timer_for_retry.set(timer_id);
                        }
                        std::mem::forget(callback);
                    }
                }
            }
        });
    });

    // 加载超过 150ms 才亮起 shimmer,避免快速命中时的闪烁。
    Effect::new(move || {
        let preview = media_state.get().preview;
        if preview != crate::lib::media_state::MediaLifecycleState::Loading {
            show_shimmer.set(false);
            return;
        }
        let show_shimmer_signal = show_shimmer;
        let callback: Closure<dyn Fn()> = Closure::new(move || {
            show_shimmer_signal.set(true);
        });
        let timer_id = web_sys::window().and_then(|window| {
            window
                .set_timeout_with_callback_and_timeout_and_arguments_0(
                    callback.as_ref().unchecked_ref(),
                    150,
                )
                .ok()
        });
        std::mem::forget(callback);
        on_cleanup(move || {
            if let Some(timer_id) = timer_id {
                if let Some(window) = web_sys::window() {
                    let _ = window.clear_timeout_with_handle(timer_id);
                }
            }
        });
    });

    // 卡片不展示标题文字,可访问名称是唯一的身份信息:有标题用标题,
    // 无标题回退通用"回忆预览",避免整屏读出同一句。
    let accessible_name = if memory.title.is_empty() {
        copy::DETAIL_PREVIEW_ALT.to_string()
    } else {
        memory.title.clone()
    };
    let accessible_name_for_view = accessible_name.clone();
    // hover 信息层次行:地点 · 拍摄日期(缺省项自动省略)。
    let caption_meta = [memory.location.clone(), format_date(memory.captured_at.as_deref())]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<String>>()
        .join(" · ");
    let video_duration = format_duration(memory.duration_seconds);
    let video_badge_label = match video_duration {
        Some(duration) => format!("{} {}", copy::VIDEO_KIND, duration),
        None => copy::VIDEO_KIND.to_string(),
    };
    let kind_is_video = memory.kind == "video";
    let has_thumbnail = thumbnail_url.is_some();

    let retry_preview = {
        let thumbnail_url = thumbnail_url.clone();
        move || {
            if thumbnail_url.is_none() {
                return;
            }
            dispatch_preview(&media_state, MediaLifecycleActionType::Retry);
            thumbnail_failed.set(false);
            natural_size.set(None);
            queued_thumbnail_url.set(None);
            retry_attempt.update(|current| *current += 1);
        }
    };
    let retry_preview_callback = Callback::new(move |_: ()| retry_preview());
    let prefetch_callback = move || {
        if let Some(on_prefetch) = on_prefetch {
            on_prefetch.run(());
        }
    };

    view! {
        <div
            class="post-card relative block w-full overflow-hidden"
            data-preview-state={move || media_state.get().preview.as_str()}
            on:focus=move |_: web_sys::FocusEvent| prefetch_callback()
            on:pointerenter=move |_: web_sys::PointerEvent| prefetch_callback()
            node_ref={card_ref}
            style={move || format!("--card-enter-index: {}", enter_index)}
        >
            <button
                aria-label={accessible_name.clone()}
                class="block w-full cursor-pointer text-left"
                on:click=move |_: web_sys::MouseEvent| on_open.run(memory.id.clone())
                type="button"
            >
                {move || {
                    let accessible_name = accessible_name_for_view.clone();
                    let failed = thumbnail_failed.get();
                    let retry_url = retry_thumbnail_url.get();
                    let has_cover = has_thumbnail && (!failed || retry_url.is_some());
                    if has_cover {
                        view! {
                            <span class="post-cover-link block media-frame" style={media_style()}>
                                <span
                                    aria-hidden="true"
                                    class={move || format!(
                                        "media-placeholder media-crossfade {} {}",
                                        if is_in_view.get() && media_state.get().preview != crate::lib::media_state::MediaLifecycleState::Ready {
                                            "is-visible"
                                        } else {
                                            "is-hidden"
                                        },
                                        if show_shimmer.get() { "card-shimmer" } else { "" },
                                    )}
                                >
                                    {icon_image("size-8 opacity-40")}
                                </span>
                                <img
                                    alt={accessible_name.clone()}
                                    class={move || format!(
                                        "post-cover media-reveal media-crossfade {}",
                                        if media_state.get().preview == crate::lib::media_state::MediaLifecycleState::Ready && is_in_view.get() {
                                            "is-visible"
                                        } else {
                                            "is-hidden"
                                        },
                                    )}
                                    decoding="async"
                                    fetchpriority={if priority { "high" } else { "low" }}
                                    height={memory.height.map(|value| value.to_string())}
                                    width={memory.width.map(|value| value.to_string())}
                                    loading={if priority { "eager" } else { "lazy" }}
                                    on:error=move |_: web_sys::ErrorEvent| {
                                        dispatch_preview(&media_state, MediaLifecycleActionType::Fail);
                                        thumbnail_failed.set(true);
                                    }
                                    on:load=move |event: web_sys::Event| {
                                        if let Some(image) = event
                                            .target()
                                            .and_then(|target| {
                                                target.dyn_into::<web_sys::HtmlImageElement>().ok()
                                            })
                                        {
                                            let width = image.natural_width();
                                            let height = image.natural_height();
                                            if width > 0 && height > 0 {
                                                natural_size.set(Some((width as f64, height as f64)));
                                            }
                                        }
                                        dispatch_preview(&media_state, MediaLifecycleActionType::Ready);
                                    }
                                    src={move || retry_thumbnail_url.get().or_else(|| queued_thumbnail_url.get())}
                                />
                            </span>
                        }
                        .into_any()
                    } else {
                        let show_error = failed
                            || is_failure_media_state(media_state.get().preview);
                        view! {
                            <span
                                aria-hidden="true"
                                class="media-frame flex items-center justify-center rounded-xl bg-surface-2 text-muted"
                                style={media_style()}
                            >
                                {if show_error && memory.thumbnail_url.is_some() {
                                    icon_image("size-8").into_any()
                                } else if kind_is_video {
                                    icon_play("size-8").into_any()
                                } else {
                                    icon_image("size-8").into_any()
                                }}
                                {show_error.then(|| {
                                    view! {
                                        <span class="mt-2 flex items-center gap-1 text-xs font-medium">
                                            {icon_rotate_ccw("size-3.5")}
                                            {copy::RETRY_PREVIEW}
                                        </span>
                                    }
                                })}
                            </span>
                        }
                        .into_any()
                    }
                }}
                {kind_is_video.then(|| {
                    view! {
                        <span class="waterfall-badge">
                            {icon_video("size-3.5")}
                            {video_badge_label.clone()}
                        </span>
                    }
                })}
                {(!caption_meta.is_empty()).then(|| {
                    // 文字层装饰化:按钮的 aria-label 已含完整可读名,避免双重朗读
                    view! {
                        <span aria-hidden="true" class="card-caption">
                            <span class="card-caption-title">{memory.title.clone()}</span>
                            <span class="card-caption-meta">{caption_meta.clone()}</span>
                        </span>
                    }
                })}
            </button>
            {move || {
                let show_error = thumbnail_failed.get()
                    || is_failure_media_state(media_state.get().preview);
                show_error.then(|| {
                    view! {
                        <button
                            aria-label={copy::RETRY_PREVIEW}
                            class="absolute inset-x-2 bottom-2 flex min-h-11 items-center justify-center gap-1 rounded-lg bg-surface/90 text-xs font-medium text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                            on:click=move |_: web_sys::MouseEvent| retry_preview_callback.run(())
                            type="button"
                        >
                            {icon_rotate_ccw("size-3.5")}
                            {copy::RETRY_PREVIEW}
                        </button>
                    }
                })
            }}
        </div>
    }
}
