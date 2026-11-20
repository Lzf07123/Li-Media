// HeroFeature(逐语义对齐 components/HeroFeature.tsx):全出血主图
// LQIP→高清渐进升级、「接下来」条、Ken Burns 自动轮换(四路暂停 +
// reduced-motion 不启动)、结构镜像骨架。
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use leptos::prelude::*;
use wasm_bindgen::{closure::Closure, JsCast};

use crate::api::{append_query_param, resolve_thumbnail_url};
use crate::api::types::MemorySummary;
use crate::brand::copy;
use crate::components::ui::blur_text::BlurText;
use crate::components::ui::blur_text::BlurTextTag;
use crate::components::ui::icons::{icon_image, icon_pause, icon_play, icon_video};
use crate::lib::canvas_composition::read_canvas_composition;
use crate::lib::format::{format_date, format_duration};
use crate::lib::image_load_queue::{
    load_queued_image, ImageLoadError, ImageLoadOptions, ImageLoadPriority,
};

// 全出血主图渐进加载(LQIP):先 240 预热档,1280 高清档就绪后原地升级。
const FEATURED_THUMBNAIL_SIZE: &str = "1280";
const LQIP_THUMBNAIL_SIZE: &str = "240";
const STRIP_THUMBNAIL_SIZE: &str = "240";
const UP_NEXT_COUNT: usize = 4;
// 精选自动轮播节奏:与 Ken Burns 同一「以动衬静」口径;切换间隔与
// .hero-upnext-progress 时长一致。
const HERO_ADVANCE_MS: i32 = 9000;
// 残影层移除延时(>700ms 淡入时长)。
const CROSSFADE_REMOVAL_MS: i32 = 900;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TileImageState {
    Queued,
    Ready,
    Failed,
}

impl TileImageState {
    fn as_str(self) -> &'static str {
        match self {
            TileImageState::Queued => "queued",
            TileImageState::Ready => "ready",
            TileImageState::Failed => "failed",
        }
    }
}

/// hero 各槽位的定时器槽位:闭包不泄漏,下一轮 effect 时统一回收。
struct TimerSlot {
    id: Cell<Option<i32>>,
    callback: RefCell<Option<Closure<dyn Fn()>>>,
}

impl TimerSlot {
    fn new() -> Rc<Self> {
        Rc::new(Self {
            id: Cell::new(None),
            callback: RefCell::new(None),
        })
    }

    fn install(&self, delay: i32, callback: Closure<dyn Fn()>) {
        self.release_callback();
        let callback_ref = callback.as_ref().unchecked_ref();
        let id = web_sys::window().and_then(|window| {
            window
                .set_timeout_with_callback_and_timeout_and_arguments_0(callback_ref, delay)
                .ok()
        });
        *self.callback.borrow_mut() = Some(callback);
        self.id.set(id);
    }

    fn release_callback(&self) {
        if let Some(callback) = self.callback.borrow_mut().take() {
            drop(callback);
        }
    }

    fn clear(&self) {
        if let Some(id) = self.id.replace(None) {
            if let Some(window) = web_sys::window() {
                let _ = window.clear_timeout_with_handle(id);
            }
        }
        self.release_callback();
    }
}

/// 队列加载 + 退避重试的共享逻辑:hero 各槽位与画布同一失败哲学。
fn use_queued_thumbnail(
    thumbnail_url: Option<String>,
    priority: ImageLoadPriority,
) -> (RwSignal<TileImageState>, RwSignal<Option<String>>) {
    let load_state = RwSignal::new(TileImageState::Queued);
    let loaded_url = RwSignal::new(None::<String>);
    let retry_attempt = RwSignal::new(0u32);

    Effect::new(move || {
        let retry = retry_attempt.get();
        let request_url = if retry > 0 {
            thumbnail_url
                .as_ref()
                .map(|url| append_query_param(url, "retry", &retry.to_string()))
        } else {
            thumbnail_url.clone()
        };
        let Some(request_url) = request_url else {
            return;
        };

        load_state.set(TileImageState::Queued);
        let handle = load_queued_image(
            &request_url,
            ImageLoadOptions {
                retries: 4,
                priority,
            },
        );
        let abort_handle = send_wrapper::SendWrapper::new(handle.clone());
        on_cleanup(move || abort_handle.abort());

        let load_state_for_task = load_state;
        let loaded_url_for_task = loaded_url;
        let thumbnail_url_for_task = thumbnail_url.clone();
        let retry_attempt_for_task = retry_attempt;
        let timer = TimerSlot::new();
        let timer_for_cleanup = send_wrapper::SendWrapper::new(timer.clone());
        on_cleanup(move || timer_for_cleanup.clear());

        wasm_bindgen_futures::spawn_local(async move {
            match handle.await {
                Ok(_) => {
                    loaded_url_for_task.set(thumbnail_url_for_task);
                    load_state_for_task.set(TileImageState::Ready);
                }
                Err(ImageLoadError::Aborted) => {}
                Err(_) => {
                    // 队列已完成 4 次退避重试;再手补 2 次长退避后进入
                    // 安静降级(低对比图标占位,与画布卡片同一失败哲学)。
                    if retry < 2 {
                        let timer_for_retry = timer.clone();
                        let callback: Closure<dyn Fn()> = Closure::new(move || {
                            retry_attempt_for_task.set(retry + 1);
                        });
                        timer_for_retry.install(4000, callback);
                    } else {
                        load_state_for_task.set(TileImageState::Failed);
                    }
                }
            }
        });
    });

    (load_state, loaded_url)
}

/// 全出血主图:LQIP 模糊先行淡入,1280 就绪后原地淡入覆盖(极慢 Ken Burns)。
#[component]
fn FeaturedMedia(
    memory: MemorySummary,
    on_open: Callback<String>,
    /// 上一主图残影垫底期间不显示占位闪光,避免盖住残影层。
    crossfading: impl Fn() -> bool + Send + 'static,
) -> impl IntoView {
    let lqip_url = memory
        .thumbnail_url
        .as_deref()
        .and_then(|path| resolve_thumbnail_url(Some(path), LQIP_THUMBNAIL_SIZE));
    let hq_url = memory
        .thumbnail_url
        .as_deref()
        .and_then(|path| resolve_thumbnail_url(Some(path), FEATURED_THUMBNAIL_SIZE));
    // 同为高优先级:hook 顺序保证 240 先入队,1280 随后并行派生。
    let (lqip_state, _lqip_loaded_url) = use_queued_thumbnail(lqip_url.clone(), ImageLoadPriority::High);
    let (hq_state, _hq_loaded_url) = use_queued_thumbnail(hq_url.clone(), ImageLoadPriority::High);
    let accessible_name = if memory.title.is_empty() {
        copy::DETAIL_PREVIEW_ALT.to_string()
    } else {
        memory.title.clone()
    };

    let overall_state = Memo::new(move |_| {
        let lqip = lqip_state.get();
        let hq = hq_state.get();
        let all_failed = lqip == TileImageState::Failed && hq == TileImageState::Failed;
        let any_ready = lqip == TileImageState::Ready || hq == TileImageState::Ready;
        if all_failed {
            TileImageState::Failed
        } else if any_ready {
            TileImageState::Ready
        } else {
            TileImageState::Queued
        }
    });

    view! {
        <button
            aria-label={accessible_name}
            class="hero-stage-media"
            data-preview-state={move || overall_state.get().as_str()}
            on:click=move |_: web_sys::MouseEvent| on_open.run(memory.id.clone())
            type="button"
        >
            {move || {
                lqip_url.clone().map(|url| {
                    view! {
                        <img
                            alt=""
                            aria-hidden="true"
                            class={move || format!(
                                "hero-feature-img is-lqip {} {}",
                                if hq_state.get() == TileImageState::Ready { "is-covered" } else { "is-primary" },
                                if lqip_state.get() == TileImageState::Ready { "is-ready" } else { "is-loading" },
                            )}
                            decoding="async"
                            fetchpriority="high"
                            loading="eager"
                            src={url.clone()}
                        />
                    }
                })
            }}
            {move || {
                hq_url.clone().map(|url| {
                    view! {
                        <img
                            alt=""
                            aria-hidden="true"
                            class={move || format!(
                                "hero-feature-img {}",
                                if hq_state.get() == TileImageState::Ready {
                                    "is-ready is-primary"
                                } else {
                                    "is-loading"
                                },
                            )}
                            decoding="async"
                            fetchpriority="high"
                            loading="eager"
                            src={url.clone()}
                        />
                    }
                })
            }}
            {move || {
                (overall_state.get() == TileImageState::Queued && !crossfading()).then(|| {
                    view! {
                        <span
                            aria-hidden="true"
                            class="hero-stage-placeholder media-placeholder media-crossfade is-visible card-shimmer"
                        />
                    }
                })
            }}
            {move || {
                (overall_state.get() == TileImageState::Failed).then(|| {
                    view! {
                        <span aria-hidden="true" class="hero-stage-fallback">
                            {if memory.kind == "video" {
                                icon_play("size-10 opacity-40").into_any()
                            } else {
                                icon_image("size-10 opacity-40").into_any()
                            }}
                        </span>
                    }
                })
            }}
        </button>
    }
}

/// 「接下来」条小瓦:240 预热档(预热即所得),点击切换主图。
#[component]
fn StripTile(
    memory: MemorySummary,
    active: impl Fn() -> bool + Send + 'static,
    on_select: Callback<()>,
    /// 自动轮播进行中且本瓦是当前主图:底部进度发丝线(transform 动画)。
    show_progress: impl Fn() -> bool + Send + 'static,
) -> impl IntoView {
    let thumbnail_url = memory
        .thumbnail_url
        .as_deref()
        .and_then(|path| resolve_thumbnail_url(Some(path), STRIP_THUMBNAIL_SIZE));
    let (load_state, loaded_url) = use_queued_thumbnail(thumbnail_url, ImageLoadPriority::Normal);
    let accessible_name = if memory.title.is_empty() {
        copy::DETAIL_PREVIEW_ALT.to_string()
    } else {
        memory.title.clone()
    };
    let kind_is_video = memory.kind == "video";

    view! {
        <button
            aria-label={accessible_name}
            aria-pressed={move || active().to_string()}
            class="hero-upnext-tile"
            data-preview-state={move || load_state.get().as_str()}
            on:click=move |_: web_sys::MouseEvent| on_select.run(())
            type="button"
        >
            {move || {
                let state = load_state.get();
                if state != TileImageState::Failed {
                    view! {
                        <img
                            alt=""
                            class={move || format!(
                                "hero-upnext-img {}",
                                if load_state.get() == TileImageState::Ready { "is-ready" } else { "is-loading" },
                            )}
                            decoding="async"
                            loading="lazy"
                            on:error=move |_: web_sys::ErrorEvent| load_state.set(TileImageState::Failed)
                            on:load=move |_: web_sys::Event| load_state.set(TileImageState::Ready)
                            src={loaded_url.get()}
                        />
                    }
                    .into_any()
                } else {
                    view! {
                        <span aria-hidden="true" class="hero-upnext-fallback">
                            {if kind_is_video {
                                icon_play("size-4 opacity-60").into_any()
                            } else {
                                icon_image("size-4 opacity-60").into_any()
                            }}
                        </span>
                    }
                    .into_any()
                }
            }}
            {move || {
                show_progress().then(|| {
                    view! { <span aria-hidden="true" class="hero-upnext-progress" /> }
                })
            }}
        </button>
    }
}

/// 结构镜像骨架:比例框 + 文本条 + 接下来条,禁止一整块均色。
fn hero_feature_skeleton() -> impl IntoView {
    // 上次精选的真实宽高来自构图缓存;首次访问回退居中 3:2 比例框。
    let hero_size = read_canvas_composition().hero;
    let stage_style = hero_size
        .map(|size| format!("aspect-ratio: {} / {}", size.width, size.height));

    view! {
        <div class="hero-feature is-skeleton" data-testid="hero-feature-skeleton">
            <div class="hero-stage hero-stage-skeleton">
                <span
                    aria-hidden="true"
                    class="hero-stage-frame card-shimmer"
                    style={stage_style}
                />
                <div aria-hidden="true" class="hero-overlay hero-overlay-skeleton">
                    <span class="hero-skel-line hero-skel-meta card-shimmer" />
                    <span class="hero-skel-line hero-skel-title card-shimmer" />
                    <span class="hero-skel-line hero-skel-desc card-shimmer" />
                    <span class="hero-skel-chip card-shimmer" />
                </div>
                <div aria-hidden="true" class="hero-upnext hero-upnext-skeleton">
                    <span class="hero-skel-label card-shimmer" />
                    <div class="hero-upnext-list">
                        {(0..UP_NEXT_COUNT)
                            .map(|_| {
                                view! { <span class="hero-upnext-tile card-shimmer" /> }
                            })
                            .collect_view()}
                    </div>
                </div>
            </div>
        </div>
    }
}

#[component]
pub fn HeroFeature(
    /// 首屏捕获的精选回忆(≤5 条,捕获后保持稳定)。
    memories: Vec<MemorySummary>,
    /// 首屏列表尚未返回时展示结构镜像骨架。
    loading: impl Fn() -> bool + Send + 'static,
    /// CTA「进入回忆库」:滚动画布区。
    on_enter: Callback<()>,
    on_open: Callback<String>,
) -> impl IntoView {
    let featured_index = RwSignal::new(0usize);
    // 自动轮播的四路暂停:用户开关、悬停、键盘聚焦、标签页隐藏;
    // reduced-motion 下整个机制不启动(档案室允许的环境动效上限)。
    let user_paused = RwSignal::new(false);
    let hover_paused = RwSignal::new(false);
    let focus_paused = RwSignal::new(false);
    let hidden_paused = RwSignal::new(false);
    let reduced_motion = RwSignal::new(false);
    // 精选切换交叉淡出:旧主图的高清档作为残影层垫底,新图 700ms 淡入覆盖。
    let previous_featured = RwSignal::new(Option::<(String, String)>::None);
    // 上一帧精选的身份与 src(渲染期捕获比对;对齐 lastFeaturedRef)。
    let last_featured = StoredValue::new(Option::<(String, Option<String>)>::None);

    let memories = Arc::new(memories);
    let memories_for_memo = memories.clone();
    let auto_advance_supported =
        Memo::new(move |_| memories_for_memo.len() > 1 && !reduced_motion.get());
    let paused_now =
        Memo::new(move |_| user_paused.get() || hover_paused.get() || focus_paused.get() || hidden_paused.get());
    let advance_active = Memo::new(move |_| auto_advance_supported.get() && !paused_now.get());

    // reduced-motion 跟随系统变化。
    Effect::new(move || {
        let Some(window) = web_sys::window() else {
            return;
        };
        let Ok(Some(query)) = window.match_media("(prefers-reduced-motion: reduce)") else {
            return;
        };
        let reduced_motion_signal = reduced_motion;
        let update: Closure<dyn Fn()> = Closure::new(move || {
            if let Some(query) = web_sys::window()
                .and_then(|window| window.match_media("(prefers-reduced-motion: reduce)").ok())
                .flatten()
            {
                reduced_motion_signal.set(query.matches());
            }
        });
        let _ = query.add_event_listener_with_callback("change", update.as_ref().unchecked_ref());
        if let Some(query_now) = web_sys::window()
            .and_then(|window| window.match_media("(prefers-reduced-motion: reduce)").ok())
            .flatten()
        {
            reduced_motion.set(query_now.matches());
        }
        let update = send_wrapper::SendWrapper::new(update);
        on_cleanup(move || {
            if let Ok(Some(query)) = window.match_media("(prefers-reduced-motion: reduce)") {
                let _ = query.remove_event_listener_with_callback(
                    "change",
                    update.as_ref().unchecked_ref(),
                );
            }
        });
    });

    // 标签页隐藏时暂停自动轮换。
    Effect::new(move || {
        let Some(document) = web_sys::window().and_then(|window| window.document()) else {
            return;
        };
        let hidden_paused_signal = hidden_paused;
        let on_visibility: Closure<dyn Fn()> = Closure::new(move || {
            let hidden = web_sys::window()
                .and_then(|window| window.document())
                .map(|document| document.visibility_state() != web_sys::VisibilityState::Visible)
                .unwrap_or(false);
            hidden_paused_signal.set(hidden);
        });
        let _ = document.add_event_listener_with_callback(
            "visibilitychange",
            on_visibility.as_ref().unchecked_ref(),
        );
        let document = send_wrapper::SendWrapper::new(document);
        let on_visibility = send_wrapper::SendWrapper::new(on_visibility);
        on_cleanup(move || {
            let _ = document.remove_event_listener_with_callback(
                "visibilitychange",
                on_visibility.as_ref().unchecked_ref(),
            );
        });
    });

    // 定时器与进度线同生命周期:featuredIndex / advanceActive 任一变化都
    // 重开一个完整周期,保证发丝线从 0 重新铺满时与真实切换时刻对齐。
    let memories_for_timer = memories.clone();
    Effect::new(move || {
        let active = advance_active.get();
        let index = featured_index.get();
        let _ = index;
        if !active {
            return;
        }
        let len = memories_for_timer.len();
        let slot = TimerSlot::new();
        let slot_for_callback = slot.clone();
        let callback: Closure<dyn Fn()> = Closure::new(move || {
            // 信号更新推迟到微任务:避免 effect 同步重跑时回收正在执行的闭包。
            let index_signal = featured_index;
            let slot_to_release = slot_for_callback.clone();
            wasm_bindgen_futures::spawn_local(async move {
                let next = (index_signal.get_untracked() + 1) % len;
                index_signal.set(next);
                let _ = slot_to_release;
            });
        });
        slot.install(HERO_ADVANCE_MS, callback);
        let slot_for_cleanup = send_wrapper::SendWrapper::new(slot);
        on_cleanup(move || slot_for_cleanup.clear());
    });

    // 残影层 900ms 后移除(>淡入时长)。
    Effect::new(move || {
        let pending = previous_featured.get();
        if pending.is_none() {
            return;
        }
        let slot = TimerSlot::new();
        let slot_for_callback = slot.clone();
        let callback: Closure<dyn Fn()> = Closure::new(move || {
            let previous_featured_signal = previous_featured;
            let slot_to_release = slot_for_callback.clone();
            wasm_bindgen_futures::spawn_local(async move {
                previous_featured_signal.set(None);
                let _ = slot_to_release;
            });
        });
        slot.install(CROSSFADE_REMOVAL_MS, callback);
        let slot_for_cleanup = send_wrapper::SendWrapper::new(slot);
        on_cleanup(move || slot_for_cleanup.clear());
    });

    let memories_len = memories.len();
    let strip_items: Vec<MemorySummary> = memories
        .iter()
        .skip(1)
        .take(UP_NEXT_COUNT)
        .cloned()
        .collect();

    view! {
        {move || {
            if loading() {
                return hero_feature_skeleton().into_any();
            }
            if memories.is_empty() {
                // 空库与加载失败不伪造图像(品牌铁律):hero 直接退场。
                return ().into_any();
            }

            // 嵌套 move 闭包各自持有克隆句柄;外层闭包保持 FnMut。
            let memories_for_featured = memories.clone();
            let memories_for_meta = memories.clone();
            let memories_for_meta_kind = memories.clone();

            view! {
                <div class="hero-feature" data-testid="hero-feature">
                    <div
                        class="hero-stage"
                        on:blur=move |event: web_sys::FocusEvent| {
                            let related_in_stage = event
                                .related_target()
                                .zip(event.current_target())
                                .map(|(related, current)| {
                                    current
                                        .unchecked_into::<web_sys::Node>()
                                        .contains(Some(related.unchecked_ref::<web_sys::Node>()))
                                })
                                .unwrap_or(false);
                            if !related_in_stage {
                                focus_paused.set(false);
                            }
                        }
                        on:focus=move |_: web_sys::FocusEvent| focus_paused.set(true)
                        on:mouseenter=move |_: web_sys::MouseEvent| hover_paused.set(true)
                        on:mouseleave=move |_: web_sys::MouseEvent| hover_paused.set(false)
                    >
                        {move || {
                            previous_featured.get().map(|(_, src)| {
                                view! {
                                    <img
                                        alt=""
                                        aria-hidden="true"
                                        class="hero-feature-img is-previous is-ready"
                                        src={src.clone()}
                                    />
                                }
                            })
                        }}
                        {move || {
                            // key 随精选切换重挂载:LQIP→高清交叉淡入与 Ken Burns
                            // 从新主图重新起拍。渲染期捕获 outgoing(对齐 React
                            // render-phase capture)。
                            let index = featured_index.get().min(memories_len - 1);
                            let featured = memories_for_featured[index].clone();
                            let last = last_featured.read_value().as_ref().cloned();
                            if last.as_ref().map(|(id, _)| id.as_str()) != Some(featured.id.as_str()) {
                                if let Some((outgoing_id, Some(outgoing_src))) = last {
                                    previous_featured.set(Some((outgoing_id, outgoing_src)));
                                }
                                let hq_src = featured
                                    .thumbnail_url
                                    .as_deref()
                                    .and_then(|path| resolve_thumbnail_url(Some(path), FEATURED_THUMBNAIL_SIZE));
                                last_featured.set_value(Some((featured.id.clone(), hq_src)));
                            }
                            let crossfading = move || previous_featured.get().is_some();
                            view! {
                                <FeaturedMedia
                                    crossfading={crossfading}
                                    memory={featured.clone()}
                                    on_open={on_open}
                                />
                            }
                        }}
                        <span aria-hidden="true" class="hero-stage-scrim" />

                        <div class="hero-overlay">
                            // 自动轮播不进 aria-live:每 9s 朗读元数据是噪声;
                            // 手动切换的状态变化由瓦片 aria-pressed 表达
                            <p class="hero-meta tnum">
                                <span class="hero-meta-index">
                                    {move || {
                                        let index = featured_index.get().min(memories_len - 1);
                                        format!("{:02}", index + 1)
                                    }}
                                </span>
                                <span aria-hidden="true">
                                    {move || {
                                        let index = featured_index.get().min(memories_len - 1);
                                        let featured = &memories_for_meta[index];
                                        let featured_meta = [
                                            featured.location.clone(),
                                            format_date(featured.captured_at.as_deref()),
                                        ]
                                        .into_iter()
                                        .flatten()
                                        .filter(|part| !part.is_empty())
                                        .collect::<Vec<String>>()
                                        .join(" · ");
                                        if featured_meta.is_empty() {
                                            format!("/ {}", copy::HERO_FEATURED_LABEL)
                                        } else {
                                            format!("/ {} · {}", copy::HERO_FEATURED_LABEL, featured_meta)
                                        }
                                    }}
                                </span>
                                {move || {
                                    let index = featured_index.get().min(memories_len - 1);
                                    let featured = &memories_for_meta_kind[index];
                                    let video_duration = format_duration(featured.duration_seconds);
                                    match (featured.kind == "video", video_duration) {
                                        (true, Some(duration)) => Some(view! {
                                            <span class="hero-meta-kind">
                                                {icon_video("size-3.5")}
                                                {format!("{} {}", copy::VIDEO_KIND, duration)}
                                            </span>
                                        }),
                                        _ => None,
                                    }
                                }}
                            </p>
                            <BlurText
                                class="hero-title"
                                id="library-title"
                                tag={BlurTextTag::H1}
                                text={copy::LIBRARY_TITLE.to_string()}
                            />
                            <p class="hero-description">{copy::LIBRARY_DESCRIPTION}</p>
                            <button
                                class="hero-cta"
                                on:click=move |_: web_sys::MouseEvent| on_enter.run(())
                                type="button"
                            >
                                {copy::HERO_ENTER_LABEL}
                            </button>
                        </div>

                        {(!strip_items.is_empty()).then(|| {
                            view! {
                                <div class="hero-upnext">
                                    <div class="hero-upnext-head">
                                        <span aria-hidden="true" class="hero-upnext-label">
                                            {copy::HERO_UP_NEXT_LABEL}
                                        </span>
                                        {move || {
                                            auto_advance_supported.get().then(|| {
                                                view! {
                                                    <button
                                                        aria-label={copy::HERO_AUTO_TOGGLE}
                                                        aria-pressed={move || (!user_paused.get()).to_string()}
                                                        class="hero-auto-toggle"
                                                        on:click=move |_: web_sys::MouseEvent| {
                                                            user_paused.update(|current| *current = !*current);
                                                        }
                                                        title={move || {
                                                            if user_paused.get() {
                                                                copy::HERO_AUTO_RESUME.to_string()
                                                            } else {
                                                                copy::HERO_AUTO_PAUSE.to_string()
                                                            }
                                                        }}
                                                        type="button"
                                                    >
                                                        {move || {
                                                            if user_paused.get() {
                                                                icon_play("size-3.5").into_any()
                                                            } else {
                                                                icon_pause("size-3.5").into_any()
                                                            }
                                                        }}
                                                    </button>
                                                }
                                            })
                                        }}
                                    </div>
                                    <ul class="hero-upnext-list">
                                        {strip_items
                                            .iter()
                                            .enumerate()
                                            .map(|(index, memory)| {
                                                let active = move || featured_index.get() == index + 1;
                                                let show_progress = move || {
                                                    advance_active.get() && featured_index.get() == index + 1
                                                };
                                                let memory = memory.clone();
                                                view! {
                                                    <li>
                                                        <StripTile
                                                            active={active}
                                                            memory={memory}
                                                            on_select={Callback::new(move |_| {
                                                                featured_index.set(index + 1);
                                                            })}
                                                            show_progress={show_progress}
                                                        />
                                                    </li>
                                                }
                                            })
                                            .collect_view()}
                                    </ul>
                                </div>
                            }
                        })}

                        <span aria-hidden="true" class="hero-scroll-cue">
                            <span class="hero-scroll-cue-track">
                                <span class="hero-scroll-cue-dot" />
                            </span>
                        </span>
                    </div>
                </div>
            }
            .into_any()
        }}
    }
}
