// SpacePane(逐语义对齐 components/space/SpacePane.tsx):时间回廊的
// 单张瓦片。回廊窗口模式远端固定 240px 档(与画布同口径,预热即所得),
// 落定档位 ±2 档内升 480px 近景档,交叉淡入换源;flat 时间线走原生
// lazy loading。挂载时向雾化注册表登记(元素 → 世界 Z),卸载时注销。
use std::sync::Arc;

use leptos::prelude::*;
use wasm_bindgen::JsCast;

use crate::api::resolve_thumbnail_url;
use crate::api::types::MemorySummary;
use crate::brand::copy;
use crate::components::space::camera::{lock_fog, FogTarget, FogTargets};
use crate::components::ui::icons::{icon_image, icon_play};
use crate::lib::format::{format_date, format_duration};
use crate::lib::image_load_queue::{
    load_queued_image, ImageLoadError, ImageLoadOptions, ImageLoadPriority,
};

// 回廊窗口模式:远端固定 240px 档(与画布同口径,预热即所得),
// 落定档位 ±2 档内升 480px 近景档,交叉淡入换源;查看器内再取高清。
const NEAR_TIER: &str = "480";
const FAR_TIER: &str = "240";

#[component]
pub fn SpacePane(
    memory: MemorySummary,
    index: usize,
    /// 世界坐标 Z(px,负值):几何唯一事实,同时用于雾化注册
    world_z: f64,
    /// 所在墙面:false = 左壁 / true = 右壁(几何量本体在 CSS 令牌)
    is_right_wall: bool,
    /// 近景升档:落定档位 ±2 档内取 480px
    #[prop(into)] enhanced: Signal<bool>,
    /// true = 3D 窗口模式(走共享队列);false = flat 时间线(原生 lazy)
    #[prop(into)] windowed: Signal<bool>,
    /// 几何拾取的悬停态(3D 下 pane 不参与 DOM 命中,由舞台代理写入)
    #[prop(into)] hovered: Signal<bool>,
    fog_targets: FogTargets,
) -> impl IntoView {
    let loaded_240: RwSignal<Option<String>> = RwSignal::new(None);
    let loaded_480: RwSignal<Option<String>> = RwSignal::new(None);
    let flat_ready = RwSignal::new(false);
    let failed = RwSignal::new(false);
    let pane_ref = NodeRef::<leptos::html::Button>::new();

    let url_240 = resolve_thumbnail_url(memory.thumbnail_url.as_deref(), FAR_TIER);
    let url_480 = resolve_thumbnail_url(memory.thumbnail_url.as_deref(), NEAR_TIER);

    // 240px 基础档:窗口模式走共享队列;失败置 failed 保留占位。
    {
        let url_240 = url_240.clone();
        Effect::new(move |_| {
        let windowed = windowed.get();
        let url = url_240.clone();
        if !windowed || url.is_none() {
            return;
        }
        let url = url.unwrap();
        failed.set(false);
        let handle = load_queued_image(
            &url,
            ImageLoadOptions {
                priority: ImageLoadPriority::Normal,
                retries: 4,
            },
        );
        let abort_handle = send_wrapper::SendWrapper::new(handle.clone());
        on_cleanup(move || abort_handle.abort());

        let loaded_240 = loaded_240;
        let failed = failed;
        wasm_bindgen_futures::spawn_local(async move {
            match handle.await {
                Ok(_) => loaded_240.set(Some(url)),
                Err(ImageLoadError::Aborted) => {}
                Err(_) => failed.set(true),
            }
        });
        });
    }

    // 480px 近景升档:升档失败保持 240px 档,不打扰浏览。
    Effect::new(move |_| {
        let windowed = windowed.get();
        let enhanced = enhanced.get();
        let url = url_480.clone();
        if !windowed || !enhanced || url.is_none() {
            return;
        }
        let url = url.unwrap();
        if loaded_480.get_untracked().as_deref() == Some(url.as_str()) {
            return;
        }
        let handle = load_queued_image(
            &url,
            ImageLoadOptions {
                priority: ImageLoadPriority::High,
                retries: 2,
            },
        );
        let abort_handle = send_wrapper::SendWrapper::new(handle.clone());
        on_cleanup(move || abort_handle.abort());

        let loaded_480 = loaded_480;
        wasm_bindgen_futures::spawn_local(async move {
            if handle.await.is_ok() {
                loaded_480.set(Some(url));
            }
        });
    });

    // 雾化注册:挂载时登记,卸载/换绑时注销(对齐 React 19 ref cleanup)。
    Effect::new(move |_| {
        let Some(element) = pane_ref.get() else {
            return;
        };
        let element: web_sys::HtmlElement =
            element.unchecked_ref::<web_sys::HtmlElement>().clone();
        lock_fog(&fog_targets).push(FogTarget {
            element: element.clone(),
            world_z,
            last_fog: None,
        });
        let element = send_wrapper::SendWrapper::new(element);
        let fog_targets = fog_targets.clone();
        on_cleanup(move || {
            lock_fog(&fog_targets).retain(|target| target.element != *element);
        });
    });

    let side_value = if is_right_wall { 1.0 } else { -1.0 };
    // Arc<dyn Fn>:视图闭包(Send+Sync)内部要再捕获,闭包本体不可 Copy。
    let url_240_for_shown = url_240.clone();
    let shown_src: Arc<dyn Fn() -> Option<String> + Send + Sync> = Arc::new(move || {
        if windowed.get() {
            loaded_240.get()
        } else {
            url_240_for_shown.clone()
        }
    });
    let ready: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || {
        if windowed.get() {
            loaded_240.get().is_some()
        } else {
            flat_ready.get() || url_240.is_none()
        }
    });
    let accessible_name = [
        if memory.title.is_empty() {
            copy::DETAIL_PREVIEW_ALT.to_string()
        } else {
            memory.title.clone()
        },
        memory.location.clone().unwrap_or_default(),
        format_date(memory.captured_at.as_deref()).unwrap_or_default(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<String>>()
    .join(" · ");
    let caption_meta = [memory.location.clone().unwrap_or_default(), {
        format_date(memory.captured_at.as_deref()).unwrap_or_default()
    }]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<String>>()
    .join(" · ");
    let video_duration = format_duration(memory.duration_seconds);
    let video_badge_label = match video_duration {
        Some(duration) => format!("{} {}", copy::VIDEO_KIND, duration),
        None => copy::VIDEO_KIND.to_string(),
    };
    let kind_is_video = memory.kind == "video";
    let pane_style = {
        let aspect_part = match (memory.width, memory.height) {
            (Some(width), Some(height)) if width > 0 && height > 0 => {
                format!("; --pane-aspect: {} / {}", width, height)
            }
            _ => String::new(),
        };
        format!(
            "--space-side: {}; --space-y: 0px; --space-z: {}px{}",
            side_value, world_z, aspect_part
        )
    };

    // 每个动态视图闭包各自持一份 Arc(view! 静态结构只构建一次,闭包按
    // move 捕获;运行期再 clone 供内部嵌套闭包使用)。
    let ready_for_img = ready.clone();
    let shown_src_for_img = shown_src.clone();
    let ready_for_placeholder = ready.clone();
    let shown_src_for_placeholder = shown_src.clone();

    view! {
        <button
            aria-label={accessible_name.clone()}
            class="space-pane"
            data-hovered={move || hovered.get().then(|| "true".to_string())}
            data-space-index={index.to_string()}
            node_ref={pane_ref}
            style={pane_style}
            type="button"
        >
            {move || {
                let ready = ready_for_img.clone();
                shown_src_for_img().map(|src| {
                    view! {
                        <img
                            alt=""
                            aria-hidden="true"
                            class={move || {
                                format!(
                                    "space-pane-img media-reveal media-crossfade {}",
                                    if ready() { "is-visible" } else { "is-hidden" },
                                )
                            }}
                            decoding="async"
                            loading={(!windowed.get()).then(|| "lazy".to_string())}
                            on:load=move |_: web_sys::Event| {
                                flat_ready.set(true);
                            }
                            src={src}
                        />
                    }
                })
            }}
            {move || {
                loaded_480.get().map(|src| {
                    view! {
                        <img
                            alt=""
                            aria-hidden="true"
                            class="space-pane-img media-crossfade is-visible"
                            decoding="async"
                            src={src}
                        />
                    }
                })
            }}
            {move || {
                let ready = ready_for_placeholder.clone();
                let shown_src = shown_src_for_placeholder.clone();
                let is_ready = ready();
                let is_failed = failed.get();
                let shown = shown_src();
                (!is_ready || is_failed || shown.is_none()).then(|| {
                    view! {
                        <span
                            aria-hidden="true"
                            class={move || {
                                let is_ready = ready();
                                let is_failed = failed.get();
                                let shown = shown_src();
                                format!(
                                    "media-placeholder media-crossfade {}",
                                    if is_ready && !is_failed && shown.is_some() {
                                        "is-hidden"
                                    } else {
                                        "is-visible"
                                    },
                                )
                            }}
                        >
                            {if kind_is_video {
                                icon_play("size-8 opacity-40").into_any()
                            } else {
                                icon_image("size-8 opacity-40").into_any()
                            }}
                        </span>
                    }
                })
            }}
            {kind_is_video.then(|| {
                view! {
                    <span aria-hidden="true" class="waterfall-badge">
                        {icon_play("size-3.5")}
                        {video_badge_label.clone()}
                    </span>
                }
            })}
            {((!memory.title.is_empty()) || (!caption_meta.is_empty())).then(|| {
                // 文字层装饰化:按钮的 aria-label 已含完整可读名,避免双重朗读
                view! {
                    <span aria-hidden="true" class="space-caption">
                        <span class="space-caption-title">{memory.title.clone()}</span>
                        <span class="space-caption-meta">{caption_meta.clone()}</span>
                    </span>
                }
            })}
        </button>
    }
}

/// 年份里程碑:每年首张相片上方挂同墙衬线年号;无拍摄时间的相片不挂。
/// 同样参与雾化注册(随距离淡出)。
#[component]
pub fn SpaceMilestone(
    year: i32,
    /// 世界坐标 Z(px,负值)
    world_z: f64,
    /// 所在墙面:false = 左壁 / true = 右壁
    is_right_wall: bool,
    fog_targets: FogTargets,
) -> impl IntoView {
    let milestone_ref = NodeRef::<leptos::html::Div>::new();

    Effect::new(move |_| {
        let Some(element) = milestone_ref.get() else {
            return;
        };
        let element: web_sys::HtmlElement =
            element.unchecked_ref::<web_sys::HtmlElement>().clone();
        lock_fog(&fog_targets).push(FogTarget {
            element: element.clone(),
            world_z,
            last_fog: None,
        });
        let element = send_wrapper::SendWrapper::new(element);
        let fog_targets = fog_targets.clone();
        on_cleanup(move || {
            lock_fog(&fog_targets).retain(|target| target.element != *element);
        });
    });

    let side_value = if is_right_wall { 1.0 } else { -1.0 };

    view! {
        <div
            aria-hidden="true"
            class="space-milestone"
            node_ref={milestone_ref}
            style={format!(
                "--space-side: {}; --space-z: {}px",
                side_value, world_z
            )}
        >
            {year}
        </div>
    }
}
