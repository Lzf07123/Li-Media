// MediaViewer(逐语义对齐 components/MediaViewer.tsx):全屏查看器。
// 缩放(translate3d+scale,双指/滚轮/键盘)、pointerup 命中判定的 swipe
// 翻页、邻图预取、剪贴板复制 URL、视频走 VideoPlayer、暗区点击关闭、
// 焦点圈定。React createPortal → 挂载后把根节点移动到 document.body
// (事件委托根同为 body,行为不变,且脱离 page-enter 的层叠上下文)。
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use leptos::prelude::*;
use wasm_bindgen::{closure::Closure, JsCast};

use crate::api::types::MemorySummary;
use crate::api::{resolve_thumbnail_url, resolve_trusted_media_url};
use crate::brand::copy;
use crate::components::ui::icons::{
    icon_chevron_left, icon_chevron_right, icon_download, icon_link_2, icon_play,
    icon_refresh_cw, icon_triangle_alert, icon_x,
};
use crate::components::video_player::VideoPlayer;
use crate::lib::format::{format_date, format_duration};
use crate::lib::image_load_queue::{
    load_queued_image, resume, suspend_all, ImageLoadError, ImageLoadOptions,
    ImageLoadPriority, QueuedImageLoad,
};
use crate::lib::media_state::{
    is_failure_media_state, reduce_media_lifecycle, select_active_media_state,
    ActiveMediaState, MediaLifecycleAction, MediaLifecycleActionType, MediaLifecycleMap,
    MediaLifecycleState, MediaScope,
};

const MIN_ZOOM: f64 = 1.0;
const MAX_ZOOM: f64 = 5.0;

// 滑动翻页:zoom<=1 时横向为主(|dx|>60 且 |dx|>2|dy|)才翻页,
// 纵向滑动让位;拖拽期间内容按系数跟手,松手回弹或翻页。
const SWIPE_THRESHOLD_PX: f64 = 60.0;
const SWIPE_AXIS_RATIO: f64 = 2.0;
const SWIPE_FOLLOW_FACTOR: f64 = 0.35;
// 跟手起势阈值:超过才进入跟手并对鼠标指针 setPointerCapture。
// pointerdown 即捕获会把子元素(失败浮层的重试按钮、图片)的 click
// 重定向到 stage 本体,按钮点击全部失效——必须推迟到明确滑动意图后。
const SWIPE_FOLLOW_START_PX: f64 = 8.0;

/// 查看器画布内位置(1 起);直接打开(URL 直链)不在画布内时不传。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ViewerPosition {
    pub index: u32,
    pub total: u32,
}

#[derive(Clone, Debug, PartialEq)]
struct PlaybackSource {
    // React 版恒为 "server"(直链 kind 未使用,保留字段形状)
    #[allow(dead_code)]
    kind: &'static str,
    src: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CopyFeedback {
    Success,
    Failed,
}

/// 查看器关闭后的空白兜底:viewer 关闭时组件随即卸载,该值不会被读到。
/// home.rs 用它构造 Memo<MemorySummary> 的非空回退。
pub fn empty_memory_summary() -> MemorySummary {
    MemorySummary {
        id: String::new(),
        title: String::new(),
        description: String::new(),
        kind: "photo".to_string(),
        status: "published".to_string(),
        media_display_state: "excluded".to_string(),
        public_display_state: "excluded".to_string(),
        captured_at: None,
        location: None,
        thumbnail_path: None,
        duration_seconds: None,
        width: None,
        height: None,
        primary_file: None,
        created_at: None,
        updated_at: None,
        file_url: String::new(),
        thumbnail_url: None,
    }
}

fn prefers_reduced_motion() -> bool {
    web_sys::window()
        .and_then(|window| window.match_media("(prefers-reduced-motion: reduce)").ok().flatten())
        .map(|query| query.matches())
        .unwrap_or(false)
}

fn dispatch(
    map: &RwSignal<MediaLifecycleMap>,
    scope: MediaScope,
    kind: MediaLifecycleActionType,
) {
    map.set(reduce_media_lifecycle(
        &map.get_untracked(),
        MediaLifecycleAction::Scoped { scope, kind },
    ));
}

fn set_timeout(callback: Closure<dyn Fn()>, delay: i32) -> Option<(Closure<dyn Fn()>, i32)> {
    web_sys::window().and_then(|window| {
        window
            .set_timeout_with_callback_and_timeout_and_arguments_0(
                callback.as_ref().unchecked_ref(),
                delay,
            )
            .ok()
            .map(|handle| (callback, handle))
    })
}

fn clear_timeout(entry: Option<(Closure<dyn Fn()>, i32)>) {
    if let Some((_, handle)) = entry {
        if let Some(window) = web_sys::window() {
            let _ = window.clear_timeout_with_handle(handle);
        }
    }
}

#[component]
pub fn MediaViewer(
    memory: Memo<MemorySummary>,
    on_close: Callback<()>,
    /// 有下一张/上一张时才传入(React:onNext = nextMemory ? ... : undefined),
    /// 末页/首页时按钮与键盘翻页同时收起。
    #[prop(into)] on_next: Signal<Option<Callback<()>>>,
    #[prop(into)] on_prev: Signal<Option<Callback<()>>>,
    /// 相邻回忆:空闲时预取其查看器尺寸图片,翻页即可显示。
    #[prop(into)] prefetch_targets: Signal<Vec<MemorySummary>>,
    /// 画布内位置(1 起):直接打开(URL 直链)不在画布内时不传、不显示计数。
    #[prop(into)] position: Signal<Option<ViewerPosition>>,
    /// 画布正在追加下一页:位置计数旁提示「正在加载更多回忆」。
    #[prop(into)] is_loading_more: Signal<bool>,
) -> impl IntoView {
    let viewer_ref = NodeRef::<leptos::html::Div>::new();
    let stage_ref = NodeRef::<leptos::html::Div>::new();
    let swipe_track_ref = NodeRef::<leptos::html::Div>::new();

    // Arc<Mutex>/Atomic:舞台事件闭包要进动态视图分支(Send+Sync 约束)。
    let pointers: Arc<Mutex<std::collections::HashMap<i32, (f64, f64)>>> =
        Arc::new(Mutex::new(std::collections::HashMap::new()));
    let drag_origin: Arc<Mutex<Option<(f64, f64)>>> = Arc::new(Mutex::new(None));
    let pinch_origin: Arc<Mutex<Option<(f64, f64)>>> = Arc::new(Mutex::new(None));
    // 滑动翻页:起点 + 是否处于跟手状态(渲染为位移,pointerup 结算)
    let swipe_start: Arc<Mutex<Option<(f64, f64)>>> = Arc::new(Mutex::new(None));
    // 暗区点击:起落点与真实落点(见 handleStageBackdropClick 注释);
    // pointerdown 时先判定落点是否在背板表面(click 时 EventTarget 已不可存)。
    let backdrop_pointer: Arc<Mutex<Option<(f64, f64)>>> = Arc::new(Mutex::new(None));
    let backdrop_down_surface = Arc::new(AtomicBool::new(false));

    let swipe_dx = RwSignal::new(0.0f64);
    let swipe_following = RwSignal::new(false);
    // 复制链接反馈:成功/失败胶囊短暂显示后自动消失(与缩放指示同一模式)
    let copy_feedback = RwSignal::new(Option::<CopyFeedback>::None);

    let zoom = RwSignal::new(1.0f64);
    let offset = RwSignal::new((0.0f64, 0.0f64));
    let zoom_pill_visible = RwSignal::new(false);
    let photo_large_src: RwSignal<Option<String>> = RwSignal::new(None);
    let queued_small_src: RwSignal<Option<String>> = RwSignal::new(None);
    let queued_poster_src: RwSignal<Option<String>> = RwSignal::new(None);
    let small_image_ready = RwSignal::new(false);
    let small_image_failed = RwSignal::new(false);
    let photo_retry_key = RwSignal::new(0u32);
    let media_state: RwSignal<MediaLifecycleMap> = RwSignal::new(MediaLifecycleMap::new());
    let playback_source: RwSignal<Option<PlaybackSource>> = RwSignal::new(None);
    let poster_size = RwSignal::new(
        web_sys::window()
            .and_then(|window| window.match_media("(max-width: 767px)").ok().flatten())
            .map(|query| query.matches())
            .unwrap_or(false)
            .then_some("480")
            .unwrap_or("1280"),
    );

    // 小图先行与画布同源(240px 预热即所得,秒开不等待);
    // 大图桌面 1280 / 移动 480,加载完成后替换小图。
    let small_src = Memo::new(move |_| {
        resolve_thumbnail_url(memory.get().thumbnail_url.as_deref(), "240")
    });
    let large_src = Memo::new(move |_| {
        resolve_thumbnail_url(memory.get().thumbnail_url.as_deref(), poster_size.get())
    });
    let is_video = Memo::new(move |_| memory.get().kind == "video");
    let aspect_ratio = Memo::new(move |_| {
        let current = memory.get();
        match (current.width, current.height) {
            (Some(width), Some(height)) if width > 0 && height > 0 => {
                width as f64 / height as f64
            }
            _ => 16.0 / 9.0,
        }
    });
    let memory_id = Memo::new(move |_| memory.get().id.clone());
    // 查看器元信息行:标题 · 地点 · 日期,与卡片 hover 层同一信息口径;
    // 空段自动省略,全空不渲染。
    let viewer_caption = Memo::new(move |_| {
        let current = memory.get();
        [current.title, current.location.unwrap_or_default(), {
            format_date(current.captured_at.as_deref()).unwrap_or_default()
        }]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<String>>()
        .join(" · ")
    });
    // 流只属于视频:照片的 stream_state 恒为 unavailable(无流概念),
    // 计入失败会把所有健康照片误标为「失败」。
    let has_index_failure = Memo::new(move |_| {
        let Some(file) = memory.get().primary_file else {
            return false;
        };
        let remote_broken = file.remote_state == "failed" || file.remote_state == "missing";
        let thumbnail_broken =
            file.thumbnail_state == "failed" || file.thumbnail_state == "missing";
        let stream_broken =
            file.stream_state == "failed" || file.stream_state == "unavailable";
        remote_broken || thumbnail_broken || (is_video.get() && stream_broken)
    });
    let active_media_state = Memo::new(move |_| -> ActiveMediaState {
        let map = media_state.get();
        select_active_media_state(&[
            (MediaScope::Download, map.download),
            (MediaScope::Playback, map.playback),
            (MediaScope::Preview, map.preview),
        ])
        .unwrap_or(ActiveMediaState {
            scope: MediaScope::Preview,
            state: MediaLifecycleState::Idle,
        })
    });
    let status_text = Memo::new(move |_| {
        let active = active_media_state.get();
        if has_index_failure.get() {
            return copy::VIEWER_STATUS_FAILED.to_string();
        }
        let state = active.state;
        let failure = is_failure_media_state(state);
        match active.scope {
            MediaScope::Download => {
                if state == MediaLifecycleState::Loading {
                    copy::VIEWER_DOWNLOADING.to_string()
                } else if failure {
                    copy::VIEWER_DOWNLOAD_FAILED.to_string()
                } else {
                    copy::VIEWER_STATUS_READY.to_string()
                }
            }
            MediaScope::Playback => {
                if state == MediaLifecycleState::Unsupported {
                    copy::VIDEO_CODEC_UNSUPPORTED.to_string()
                } else if state == MediaLifecycleState::Loading {
                    copy::VIEWER_PREPARING_PLAYBACK.to_string()
                } else if state == MediaLifecycleState::Buffering {
                    copy::DETAIL_BUFFERING.to_string()
                } else if failure {
                    copy::DETAIL_PLAYBACK_FAILED.to_string()
                } else {
                    copy::VIEWER_STATUS_READY.to_string()
                }
            }
            MediaScope::Preview => {
                if state == MediaLifecycleState::Loading
                    || state == MediaLifecycleState::Queued
                {
                    copy::VIEWER_STATUS_LOADING.to_string()
                } else if failure {
                    copy::VIEWER_STATUS_RETRYING.to_string()
                } else {
                    copy::VIEWER_STATUS_READY.to_string()
                }
            }
        }
    });
    // 就绪且无索引失败时隐藏状态徽章,减少常驻视觉噪声。
    let status_settled = Memo::new(move |_| {
        let active = active_media_state.get();
        !has_index_failure.get()
            && !is_failure_media_state(active.state)
            && active.state != MediaLifecycleState::Loading
            && active.state != MediaLifecycleState::Queued
            && active.state != MediaLifecycleState::Buffering
    });

    let reset_transform = move || {
        zoom.set(1.0);
        offset.set((0.0, 0.0));
    };
    let clamp_zoom = |value: f64| value.clamp(MIN_ZOOM, MAX_ZOOM);

    // 缩放指示:放大时短暂显示当前倍率,回弹到 1x 即隐藏。
    Effect::new(move |_| {
        let current_zoom = zoom.get();
        if current_zoom <= 1.0 {
            zoom_pill_visible.set(false);
            return;
        }
        zoom_pill_visible.set(true);
        let timer: Rc<RefCell<Option<(Closure<dyn Fn()>, i32)>>> =
            Rc::new(RefCell::new(None));
        {
            let zoom_pill_visible = zoom_pill_visible;
            let callback = Closure::new(move || {
                zoom_pill_visible.set(false);
            });
            *timer.borrow_mut() = set_timeout(callback, 900);
        }
        let timer = send_wrapper::SendWrapper::new(timer);
        on_cleanup(move || clear_timeout((*timer).borrow_mut().take()));
    });

    // 复制反馈胶囊:短暂显示后自动消失,重复点击重置计时。
    Effect::new(move |_| {
        if copy_feedback.get().is_none() {
            return;
        }
        let timer: Rc<RefCell<Option<(Closure<dyn Fn()>, i32)>>> =
            Rc::new(RefCell::new(None));
        {
            let copy_feedback = copy_feedback;
            let callback = Closure::new(move || {
                copy_feedback.set(None);
            });
            *timer.borrow_mut() = set_timeout(callback, 1400);
        }
        let timer = send_wrapper::SendWrapper::new(timer);
        on_cleanup(move || clear_timeout((*timer).borrow_mut().take()));
    });

    // 窄屏覆盖:窗口尺寸变化时切换大图档位(1280/480)。
    Effect::new(move |_| {
        let Some(window) = web_sys::window() else {
            return;
        };
        let Ok(Some(query)) = window.match_media("(max-width: 767px)") else {
            return;
        };
        let update: Closure<dyn Fn()> = Closure::new(move || {
            let matches = web_sys::window()
                .and_then(|window| window.match_media("(max-width: 767px)").ok().flatten())
                .map(|query| query.matches())
                .unwrap_or(false);
            poster_size.set(if matches { "480" } else { "1280" });
        });
        let _ = query.add_event_listener_with_callback(
            "change",
            update.as_ref().unchecked_ref(),
        );
        let update = send_wrapper::SendWrapper::new(update);
        let query = send_wrapper::SendWrapper::new(query);
        on_cleanup(move || {
            let _ = query.remove_event_listener_with_callback(
                "change",
                update.as_ref().unchecked_ref(),
            );
        });
    });

    // 挂载后把根节点移动到 document.body(createPortal 对应物)。
    Effect::new(move |_| {
        let Some(viewer) = viewer_ref.get() else {
            return;
        };
        let element: web_sys::Element = viewer.unchecked_ref::<web_sys::Element>().clone();
        let Some(document) = web_sys::window().and_then(|window| window.document()) else {
            return;
        };
        let Some(body) = document.body() else {
            return;
        };
        let already_in_body = element
            .parent_node()
            .map(|parent| parent.is_same_node(Some(body.as_ref())))
            .unwrap_or(false);
        if !already_in_body {
            let _ = body.append_child(&element);
        }
        let element = send_wrapper::SendWrapper::new(element);
        on_cleanup(move || {
            let _ = element.remove();
        });
    });

    // 打开时锁定 body 滚动、焦点进入查看器、挂起画布缩略图队列;
    // 关闭时全部归还(React useEffect [] 的挂载/卸载语义)。
    Effect::new(move |_| {
        let Some(document) = web_sys::window().and_then(|window| window.document()) else {
            return;
        };
        let Some(body) = document.body() else {
            return;
        };
        let body_element: web_sys::HtmlElement =
            body.unchecked_ref::<web_sys::HtmlElement>().clone();
        let previous_overflow = web_sys::HtmlElement::style(&body_element)
            .get_property_value("overflow")
            .unwrap_or_default();
        let previous_padding_right = web_sys::HtmlElement::style(&body_element)
            .get_property_value("padding-right")
            .unwrap_or_default();
        // 关闭时把焦点归还给打开查看器的触发元素,键盘用户不掉回 body。
        let previous_active = document
            .active_element()
            .and_then(|element| element.dyn_into::<web_sys::HtmlElement>().ok());
        let _ = web_sys::HtmlElement::style(&body_element)
            .set_property("overflow", "hidden");
        if let Some(viewer) = viewer_ref.get() {
            let _ = viewer.focus();
        }
        // Park canvas thumbnail loads so the viewer's high-priority images can
        // claim both queue slots immediately; parked tasks resume on close.
        suspend_all();

        let body_element = send_wrapper::SendWrapper::new(body_element);
        let previous_active = previous_active.map(send_wrapper::SendWrapper::new);
        on_cleanup(move || {
            let _ = web_sys::HtmlElement::style(&body_element)
                .set_property("overflow", &previous_overflow);
            let _ = web_sys::HtmlElement::style(&body_element)
                .set_property("padding-right", &previous_padding_right);
            resume();
            if let Some(previous) = previous_active.as_ref() {
                let _ = previous.focus();
            }
        });
    });

    // 照片加载链路:小图占位先行,大图入队(高优先级,4 次重试),
    // 成功后替换;重试计数与档位/内容变化都会重跑。依赖 [isVideo,
    // largeSrc, photoRetryKey, smallSrc](React 版语义)。
    Effect::new(move |_| {
        let video = is_video.get();
        let large = large_src.get();
        let small = small_src.get();
        let _retry = photo_retry_key.get();
        if video {
            return;
        }

        photo_large_src.set(None);
        small_image_ready.set(false);
        small_image_failed.set(false);
        dispatch(
            &media_state,
            MediaScope::Preview,
            if small.is_some() {
                MediaLifecycleActionType::Queued
            } else {
                MediaLifecycleActionType::Fail
            },
        );
        dispatch(
            &media_state,
            MediaScope::Preview,
            if small.is_some() {
                MediaLifecycleActionType::Load
            } else {
                MediaLifecycleActionType::Fail
            },
        );
        reset_transform();
        let Some(large_url) = large else {
            return;
        };

        let handle = load_queued_image(
            &large_url,
            ImageLoadOptions {
                priority: ImageLoadPriority::High,
                retries: 4,
            },
        );
        let abort_handle = send_wrapper::SendWrapper::new(handle.clone());
        on_cleanup(move || abort_handle.abort());

        let photo_large_src = photo_large_src;
        let media_state = media_state;
        let large_url_for_load = large_url.clone();
        wasm_bindgen_futures::spawn_local(async move {
            match handle.await {
                Ok(_) => {
                    photo_large_src.set(Some(large_url_for_load));
                    dispatch(&media_state, MediaScope::Preview, MediaLifecycleActionType::Ready);
                }
                Err(ImageLoadError::Aborted) => {}
                Err(_) => {
                    dispatch(&media_state, MediaScope::Preview, MediaLifecycleActionType::Fail);
                }
            }
        });
    });

    // 小图入队:查看器关键路径(小图先行)高优先级,避免被普通任务占住槽位。
    Effect::new(move |_| {
        let video = is_video.get();
        let small = small_src.get();
        if video || small.is_none() {
            queued_small_src.set(None);
            return;
        }
        let small_url = small.unwrap();
        let handle = load_queued_image(
            &small_url,
            ImageLoadOptions {
                priority: ImageLoadPriority::High,
                retries: 4,
            },
        );
        let abort_handle = send_wrapper::SendWrapper::new(handle.clone());
        on_cleanup(move || abort_handle.abort());

        let queued_small_src = queued_small_src;
        let small_url_for_load = small_url.clone();
        wasm_bindgen_futures::spawn_local(async move {
            match handle.await {
                Ok(_) => queued_small_src.set(Some(small_url_for_load)),
                Err(_) => queued_small_src.set(None),
            }
        });
    });

    // 视频海报入队:播放前先用大图(缺省回退小图)做封面。
    Effect::new(move |_| {
        let video = is_video.get();
        if !video {
            queued_poster_src.set(None);
            return;
        }
        let poster_source = large_src.get().or_else(|| small_src.get());
        let Some(poster_url) = poster_source else {
            queued_poster_src.set(None);
            return;
        };

        dispatch(&media_state, MediaScope::Preview, MediaLifecycleActionType::Queued);
        dispatch(&media_state, MediaScope::Preview, MediaLifecycleActionType::Load);
        let handle = load_queued_image(
            &poster_url,
            ImageLoadOptions {
                priority: ImageLoadPriority::High,
                retries: 4,
            },
        );
        let abort_handle = send_wrapper::SendWrapper::new(handle.clone());
        on_cleanup(move || abort_handle.abort());

        let queued_poster_src = queued_poster_src;
        let media_state = media_state;
        let poster_url_for_load = poster_url.clone();
        wasm_bindgen_futures::spawn_local(async move {
            match handle.await {
                Ok(_) => {
                    queued_poster_src.set(Some(poster_url_for_load));
                    dispatch(&media_state, MediaScope::Preview, MediaLifecycleActionType::Ready);
                }
                Err(_) => queued_poster_src.set(None),
            }
        });
    });

    // 邻图预取:只预取图片(含视频海报),不触碰按需直链契约。
    // 空闲时(requestIdleCallback,缺省 setTimeout 1ms)批量入队,
    // 预取失败静默降级;卸载/依赖变化时 abort 全部。
    Effect::new(move |_| {
        let targets = prefetch_targets.get();
        let size = poster_size.get();
        if targets.is_empty() {
            return;
        }
        let urls: Vec<String> = targets
            .iter()
            .filter_map(|neighbor| {
                resolve_thumbnail_url(neighbor.thumbnail_url.as_deref(), &size)
            })
            .collect();
        if urls.is_empty() {
            return;
        }

        let handles: Rc<RefCell<Vec<QueuedImageLoad>>> = Rc::new(RefCell::new(Vec::new()));
        let start_prefetch = {
            let handles = handles.clone();
            move || {
                for url in &urls {
                    let handle = load_queued_image(
                        url,
                        ImageLoadOptions {
                            priority: ImageLoadPriority::High,
                            retries: 2,
                        },
                    );
                    handles.borrow_mut().push(handle.clone());
                    wasm_bindgen_futures::spawn_local(async move {
                        // 预取失败静默降级;真正导航时按正常链路加载。
                        let _ = handle.await;
                    });
                }
            }
        };

        let Some(window) = web_sys::window() else {
            return;
        };
        let idle_callback: Closure<dyn Fn()> = Closure::new(start_prefetch);
        let idle_id = window
            .request_idle_callback(idle_callback.as_ref().unchecked_ref())
            .ok();
        let idle_callback = send_wrapper::SendWrapper::new(idle_callback);
        let handles = send_wrapper::SendWrapper::new(handles);
        on_cleanup(move || {
            if let Some(id) = idle_id {
                if let Some(window) = web_sys::window() {
                    let _ = window.cancel_idle_callback(id);
                }
            }
            drop(idle_callback);
            for handle in handles.borrow_mut().drain(..) {
                handle.abort();
            }
        });
    });

    // 键盘导航:Escape 关闭、+/-/0 缩放、方向键翻页或平移、Tab 焦点圈定。
    // 回调经信号实时读取(Callback 捕获的是信号读取逻辑,不存在 React
    // 的旧闭包问题),zoom/isVideo 用 get_untracked 快照。
    Effect::new(move |_| {
        let Some(document) = web_sys::window().and_then(|window| window.document()) else {
            return;
        };
        let document_for_handler = document.clone();
        let handle_keydown: Closure<dyn Fn(web_sys::KeyboardEvent)> =
            Closure::new(move |event: web_sys::KeyboardEvent| {
                let current_zoom = zoom.get_untracked();
                let key = event.key();

                if key == "Escape" {
                    event.prevent_default();
                    on_close.run(());
                    return;
                }

                if key == "+" || key == "=" {
                    event.prevent_default();
                    zoom.update(|current| *current = clamp_zoom(*current * 1.2));
                    return;
                }

                if key == "-" || key == "_" {
                    event.prevent_default();
                    zoom.update(|current| *current = clamp_zoom(*current / 1.2));
                    return;
                }

                if key == "0" {
                    event.prevent_default();
                    reset_transform();
                    return;
                }

                if key == "ArrowLeft" || key == "ArrowRight" {
                    let is_left = key == "ArrowLeft";
                    let nav = if is_left { on_prev.get() } else { on_next.get() };
                    if let Some(nav) = nav {
                        if is_video.get_untracked() || current_zoom <= 1.0 {
                            event.prevent_default();
                            nav.run(());
                            return;
                        }
                    }
                    event.prevent_default();
                    if current_zoom > 1.0 {
                        let pan = 48.0;
                        offset.update(|current| {
                            if is_left {
                                current.0 += pan;
                            } else {
                                current.0 -= pan;
                            }
                        });
                    }
                    return;
                }

                if key == "ArrowUp" || key == "ArrowDown" {
                    event.prevent_default();
                    if current_zoom > 1.0 {
                        let pan = 48.0;
                        offset.update(|current| {
                            if key == "ArrowUp" {
                                current.1 += pan;
                            } else {
                                current.1 -= pan;
                            }
                        });
                    } else if key == "ArrowUp" {
                        zoom.update(|current| *current = clamp_zoom(*current * 1.2));
                    } else {
                        zoom.update(|current| *current = clamp_zoom(*current / 1.2));
                    }
                    return;
                }

                if key == "Tab" {
                    let Some(viewer) = viewer_ref.get() else {
                        return;
                    };
                    let Ok(node_list) = viewer
                        .unchecked_ref::<web_sys::Element>()
                        .query_selector_all(
                            "button, [href], [tabindex]:not([tabindex='-1'])",
                        )
                    else {
                        return;
                    };
                    let mut focusable: Vec<web_sys::HtmlElement> = Vec::new();
                    for index in 0..node_list.length() {
                        if let Some(node) = node_list.get(index) {
                            if let Some(element) =
                                node.dyn_ref::<web_sys::HtmlElement>()
                            {
                                if !element.has_attribute("disabled") {
                                    focusable.push(element.clone());
                                }
                            }
                        }
                    }
                    if focusable.is_empty() {
                        return;
                    }
                    let first = focusable[0].clone();
                    let last = focusable[focusable.len() - 1].clone();
                    let active = document_for_handler.active_element();
                    let is_first = active
                        .as_ref()
                        .map(|active| active.is_same_node(Some(first.as_ref())))
                        .unwrap_or(false);
                    let is_last = active
                        .as_ref()
                        .map(|active| active.is_same_node(Some(last.as_ref())))
                        .unwrap_or(false);
                    if event.shift_key() && is_first {
                        event.prevent_default();
                        let _ = last.focus();
                    } else if !event.shift_key() && is_last {
                        event.prevent_default();
                        let _ = first.focus();
                    }
                }
            });

        let _ = document.add_event_listener_with_callback(
            "keydown",
            handle_keydown.as_ref().unchecked_ref(),
        );
        let handle_keydown = send_wrapper::SendWrapper::new(handle_keydown);
        let document = send_wrapper::SendWrapper::new(document);
        on_cleanup(move || {
            let _ = document.remove_event_listener_with_callback(
                "keydown",
                handle_keydown.as_ref().unchecked_ref(),
            );
        });
    });

    // 内容切换(React useEffect [memory.id]):清掉上一张遗留的播放源与
    // 背板判定状态,重置生命周期状态机。照片↔视频翻页不重挂载。
    {
        let backdrop_pointer = backdrop_pointer.clone();
        let backdrop_down_surface = backdrop_down_surface.clone();
        Effect::new(move |_| {
        let _ = memory_id.get();
        playback_source.set(None);
        *backdrop_pointer
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        backdrop_down_surface.store(false, Ordering::Relaxed);
        media_state.set(MediaLifecycleMap::new());
        });
    }

    // ---- 交互回调 ----

    // 暗区点击关闭:click 命中 stage 本体或覆盖整块舞台的透明滑动层
    //(真实布局里「暗区」落在滑动层上),且位移 < 8px 才触发;
    // 图片、失败浮层按钮等其余子元素不关闭。
    // 注意 setPointerCapture(滑动跟手)会把子元素上的 click 重定向到
    // stage 本体,因此 pointerdown 额外记录真实落点:起落都不在背板
    // 表面的 click 一律不算暗区点击。
    let is_backdrop_surface = move |target: Option<web_sys::EventTarget>| -> bool {
        let Some(target) = target else {
            return false;
        };
        let stage_match = stage_ref
            .get()
            .map(|stage| {
                target
                    .dyn_ref::<web_sys::Node>()
                    .map(|node| node.is_same_node(Some(stage.as_ref())))
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        let track_match = swipe_track_ref
            .get()
            .map(|track| {
                target
                    .dyn_ref::<web_sys::Node>()
                    .map(|node| node.is_same_node(Some(track.as_ref())))
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        stage_match || track_match
    };

    let handle_stage_pointer_down = {
        let backdrop_pointer = backdrop_pointer.clone();
        let backdrop_down_surface = backdrop_down_surface.clone();
        let is_backdrop_surface = is_backdrop_surface.clone();
        move |event: web_sys::PointerEvent| {
            *backdrop_pointer
                .lock()
                .unwrap_or_else(|error| error.into_inner()) =
                Some((event.client_x() as f64, event.client_y() as f64));
            backdrop_down_surface.store(
                is_backdrop_surface(event.target()),
                Ordering::Relaxed,
            );
        }
    };

    let handle_stage_backdrop_click = {
        let backdrop_pointer = backdrop_pointer.clone();
        let backdrop_down_surface = backdrop_down_surface.clone();
        let is_backdrop_surface = is_backdrop_surface.clone();
        move |event: web_sys::MouseEvent| {
            if !is_backdrop_surface(event.target()) {
                return;
            }
            let start = backdrop_pointer
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
            // pointerdown 已记录起手落点是否在背板表面
            if !backdrop_down_surface.load(Ordering::Relaxed) {
                return;
            }
            let Some((start_x, start_y)) = start else {
                return;
            };
            let dx = event.client_x() as f64 - start_x;
            let dy = event.client_y() as f64 - start_y;
            if (dx * dx + dy * dy).sqrt() >= 8.0 {
                return;
            }
            on_close.run(());
        }
    };

    let handle_pointer_down = {
        let pointers = pointers.clone();
        let drag_origin = drag_origin.clone();
        let pinch_origin = pinch_origin.clone();
        let swipe_start = swipe_start.clone();
        move |event: web_sys::PointerEvent| {
            pointers
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(event.pointer_id(), (event.client_x() as f64, event.client_y() as f64));
            let current_zoom = zoom.get_untracked();
            if pointers.lock().unwrap_or_else(|error| error.into_inner()).len() == 2 {
                let points: Vec<(f64, f64)> = pointers
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .values()
                    .cloned()
                    .collect();
                let dx = points[0].0 - points[1].0;
                let dy = points[0].1 - points[1].1;
                let distance = (dx * dx + dy * dy).sqrt();
                *pinch_origin
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some((distance, current_zoom));
                *drag_origin
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = None;
                *swipe_start
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = None;
                swipe_following.set(false);
                swipe_dx.set(0.0);
            } else if current_zoom > 1.0 {
                let (offset_x, offset_y) = offset.get_untracked();
                *drag_origin
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some((
                    event.client_x() as f64 - offset_x,
                    event.client_y() as f64 - offset_y,
                ));
            } else {
                // zoom<=1 单指针:记录滑动起点;捕获推迟到跟手开始
                *swipe_start
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) =
                    Some((event.client_x() as f64, event.client_y() as f64));
                swipe_following.set(false);
                swipe_dx.set(0.0);
            }
        }
    };

    let handle_pointer_move = {
        let pointers = pointers.clone();
        let drag_origin = drag_origin.clone();
        let pinch_origin = pinch_origin.clone();
        let swipe_start = swipe_start.clone();
        move |event: web_sys::PointerEvent| {
            if !pointers
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .contains_key(&event.pointer_id())
            {
                return;
            }
            pointers
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(
                    event.pointer_id(),
                    (event.client_x() as f64, event.client_y() as f64),
                );
            if pointers.lock().unwrap_or_else(|error| error.into_inner()).len() == 2 {
                if let Some((base_distance, base_zoom)) = *pinch_origin
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                {
                    let points: Vec<(f64, f64)> = pointers
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .values()
                        .cloned()
                        .collect();
                    let dx = points[0].0 - points[1].0;
                    let dy = points[0].1 - points[1].1;
                    let distance = (dx * dx + dy * dy).sqrt();
                    zoom.set(clamp_zoom(base_zoom * (distance / base_distance)));
                    return;
                }
            }

            if pointers.lock().unwrap_or_else(|error| error.into_inner()).len() == 1 {
                if let Some((origin_x, origin_y)) = *drag_origin
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                {
                    offset.set((
                        event.client_x() as f64 - origin_x,
                        event.client_y() as f64 - origin_y,
                    ));
                    return;
                }

                // 滑动跟手:横向为主时按系数平移内容;纵向为主的滑动不跟手。
                // 减动效偏好下不做跟手位移,只在 pointerup 按阈值直接翻页。
                let start = *swipe_start
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                let following = swipe_following.get_untracked();
                let pinching = pinch_origin
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .is_some();
                if let Some((start_x, start_y)) = start {
                    if !pinching && !following {
                        let dx = event.client_x() as f64 - start_x;
                        let dy = event.client_y() as f64 - start_y;
                        if dx.abs() > SWIPE_FOLLOW_START_PX
                            && dx.abs() > dy.abs()
                            && !prefers_reduced_motion()
                        {
                            // 跟手起势后才捕获:之后移出舞台仍能收到 move/up;
                            // 触摸指针浏览器已隐式捕获,无需重复。
                            if event.pointer_type() == "mouse" {
                                if let Some(stage) = stage_ref.get() {
                                    let _ = stage
                                        .unchecked_ref::<web_sys::Element>()
                                        .set_pointer_capture(event.pointer_id());
                                }
                            }
                            swipe_following.set(true);
                            swipe_dx.set(dx * SWIPE_FOLLOW_FACTOR);
                        }
                        return;
                    }
                    if following {
                        let dx = event.client_x() as f64 - start_x;
                        let dy = event.client_y() as f64 - start_y;
                        if dx.abs() > dy.abs() {
                            swipe_dx.set(dx * SWIPE_FOLLOW_FACTOR);
                        }
                    }
                }
            }
        }
    };

    let handle_pointer_up = {
        let pointers = pointers.clone();
        let drag_origin = drag_origin.clone();
        let pinch_origin = pinch_origin.clone();
        let swipe_start = swipe_start.clone();
        move |event: web_sys::PointerEvent| {
            pointers
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&event.pointer_id());
            if pointers.lock().unwrap_or_else(|error| error.into_inner()).len() < 2 {
                *pinch_origin
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = None;
            }
            if pointers
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_empty()
            {
                *drag_origin
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = None;
            }

            // 滑动结算:横向位移过阈值且纵向占比小才翻页,否则回弹。
            let start = swipe_start
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
            swipe_following.set(false);
            swipe_dx.set(0.0);
            let Some((start_x, start_y)) = start else {
                return;
            };
            let dx = event.client_x() as f64 - start_x;
            let dy = event.client_y() as f64 - start_y;
            if dx.abs() > SWIPE_THRESHOLD_PX && dx.abs() > SWIPE_AXIS_RATIO * dy.abs() {
                if dx < 0.0 {
                    if let Some(next) = on_next.get() {
                        next.run(());
                    }
                } else if let Some(prev) = on_prev.get() {
                    prev.run(());
                }
            }
        }
    };

    // 滚轮缩放:viewer 全屏且 body 滚动已锁定,普通滚轮不与页面滚动冲突;
    // Ctrl/Cmd+滚轮保留给浏览器页面缩放。
    let handle_wheel = move |event: web_sys::WheelEvent| {
        if event.ctrl_key() || event.meta_key() {
            return;
        }
        let factor = if event.delta_y() < 0.0 { 1.12 } else { 1.0 / 1.12 };
        zoom.update(|current| *current = clamp_zoom(*current * factor));
    };

    let start_playback = {
        let media_state = media_state;
        let playback_source = playback_source;
        let memory = memory;
        move || {
            dispatch(&media_state, MediaScope::Playback, MediaLifecycleActionType::Load);
            let src = resolve_trusted_media_url(&memory.get_untracked().file_url);
            match src {
                Some(src) => {
                    playback_source.set(Some(PlaybackSource { kind: "server", src }));
                }
                None => {
                    dispatch(&media_state, MediaScope::Playback, MediaLifecycleActionType::Fail);
                }
            }
        }
    };
    let start_playback_for_click = start_playback.clone();

    let handle_video_source_error = Callback::new(move |code: Option<u16>| {
        let unsupported =
            code == Some(web_sys::MediaError::MEDIA_ERR_SRC_NOT_SUPPORTED);
        dispatch(
            &media_state,
            MediaScope::Playback,
            if unsupported {
                MediaLifecycleActionType::Unsupported
            } else {
                MediaLifecycleActionType::Fail
            },
        );
    });

    let start_download = {
        let media_state = media_state;
        let memory = memory;
        move || {
            dispatch(&media_state, MediaScope::Download, MediaLifecycleActionType::Load);
            let Some(href) =
                resolve_trusted_media_url(&memory.get_untracked().file_url)
            else {
                dispatch(&media_state, MediaScope::Download, MediaLifecycleActionType::Fail);
                return;
            };
            let current = memory.get_untracked();
            let filename = current
                .primary_file
                .map(|file| file.filename)
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| format!("limedia-{}", current.id));
            let started = web_sys::window()
                .and_then(|window| window.document())
                .and_then(|document| {
                    let anchor = document.create_element("a").ok()?;
                    anchor.set_attribute("href", &href).ok()?;
                    anchor.set_attribute("rel", "noopener noreferrer").ok()?;
                    anchor.set_attribute("download", &filename).ok()?;
                    let body = document.body()?;
                    body.append_child(&anchor).ok()?;
                    // click() 可能被 JS 层(如拦截扩展)抛错:经 Function::call
                    // 才能把 JS 异常转成 Result,download 失败据此进入失败态。
                    let clicked = anchor
                        .dyn_ref::<web_sys::HtmlElement>()
                        .and_then(|html_anchor| {
                            js_sys::Reflect::get(html_anchor.as_ref(), &"click".into())
                                .ok()
                                .and_then(|value| value.dyn_into::<js_sys::Function>().ok())
                                .and_then(|function| {
                                    function
                                        .call1(html_anchor.as_ref(), html_anchor.as_ref())
                                        .ok()
                                })
                        })
                        .is_some();
                    anchor.remove();
                    clicked.then_some(())
                })
                .is_some();
            dispatch(
                &media_state,
                MediaScope::Download,
                if started {
                    MediaLifecycleActionType::Ready
                } else {
                    MediaLifecycleActionType::Fail
                },
            );
        }
    };

    // 复制当前查看器地址(URL 已含 ?viewer=):clipboard API 优先,
    // 不可用或被拒时回退隐藏文本域 execCommand。
    let handle_copy_link = {
        let copy_feedback = copy_feedback;
        move || {
            let url = web_sys::window()
                .map(|window| window.location().href().unwrap_or_default())
                .unwrap_or_default();
            let copy_feedback = copy_feedback;
            wasm_bindgen_futures::spawn_local(async move {
                // clipboard API 存在才尝试(被拒或写入失败时回退 execCommand)。
                let clipboard = web_sys::window().and_then(|window| {
                    let navigator = window.navigator();
                    js_sys::Reflect::get(navigator.as_ref(), &"clipboard".into())
                        .ok()
                        .filter(|value| !value.is_undefined() && !value.is_null())
                        .and_then(|value| value.dyn_into::<web_sys::Clipboard>().ok())
                });
                if let Some(clipboard) = clipboard {
                    let promise = clipboard.write_text(&url);
                    if wasm_bindgen_futures::JsFuture::from(promise)
                        .await
                        .is_ok()
                    {
                        copy_feedback.set(Some(CopyFeedback::Success));
                        return;
                    }
                    // 继续走回退路径
                }
                let copied = web_sys::window()
                    .and_then(|window| window.document())
                    .and_then(|document| {
                        let textarea = document.create_element("textarea").ok()?;
                        let textarea_element: web_sys::HtmlTextAreaElement =
                            textarea.dyn_into::<web_sys::HtmlTextAreaElement>().ok()?;
                        textarea_element.set_value(&url);
                        textarea_element
                            .set_attribute("readonly", "")
                            .ok()?;
                        let _ = web_sys::HtmlElement::style(&textarea_element)
                            .set_property("position", "fixed");
                        let _ = web_sys::HtmlElement::style(&textarea_element)
                            .set_property("opacity", "0");
                        let textarea = textarea_element.clone();
                        let body = document.body()?;
                        body.append_child(&textarea).ok()?;
                        if let Some(textarea_element) =
                            textarea.dyn_ref::<web_sys::HtmlTextAreaElement>()
                        {
                            textarea_element.select();
                        }
                        let copied = js_sys::Reflect::get(
                            document.as_ref(),
                            &wasm_bindgen::JsValue::from_str("execCommand"),
                        )
                        .ok()
                        .and_then(|function| function.dyn_into::<js_sys::Function>().ok())
                        .and_then(|function| {
                            function
                                .call1(
                                    document.as_ref(),
                                    &wasm_bindgen::JsValue::from_str("copy"),
                                )
                                .ok()
                        })
                        .and_then(|result| result.as_bool())
                        .unwrap_or(false);
                        textarea.remove();
                        Some(copied)
                    })
                    .unwrap_or(false);
                copy_feedback.set(Some(if copied {
                    CopyFeedback::Success
                } else {
                    CopyFeedback::Failed
                }));
            });
        }
    };

    let retry_preview = move || {
        dispatch(&media_state, MediaScope::Preview, MediaLifecycleActionType::Retry);
        photo_retry_key.update(|current| *current += 1);
    };
    let retry_preview_for_overlay = retry_preview.clone();

    let is_video_value = is_video;
    let photo_preview_ready = Memo::new(move |_| {
        media_state.get().preview == MediaLifecycleState::Ready
    });
    let preview_loading = Memo::new(move |_| {
        let preview = media_state.get().preview;
        preview == MediaLifecycleState::Loading || preview == MediaLifecycleState::Queued
    });
    let preview_failed = Memo::new(move |_| {
        media_state.get().preview == MediaLifecycleState::Failed
    });
    let playback_loading = Memo::new(move |_| {
        media_state.get().playback == MediaLifecycleState::Loading
    });
    let playback_failed = Memo::new(move |_| {
        is_failure_media_state(media_state.get().playback)
    });
    let playback_unsupported = Memo::new(move |_| {
        media_state.get().playback == MediaLifecycleState::Unsupported
    });
    let download_loading = Memo::new(move |_| {
        media_state.get().download == MediaLifecycleState::Loading
    });
    let download_failed = Memo::new(move |_| {
        media_state.get().download == MediaLifecycleState::Failed
    });
    let active_is_failure = Memo::new(move |_| {
        is_failure_media_state(active_media_state.get().state)
    });

    let viewer_aria_label = move || {
        let title = memory.get().title;
        if title.is_empty() {
            copy::DETAIL_PREVIEW_ALT.to_string()
        } else {
            title
        }
    };
    let video_shell_style = move || format!("--aspect-ratio: {}", aspect_ratio.get());
    let video_dimensions = move || {
        let current = memory.get();
        match (current.width, current.height) {
            (Some(width), Some(height)) if width > 0 && height > 0 => {
                Some(format!("{} × {}", width, height))
            }
            _ => None,
        }
    };

    view! {
        <div
            aria-label={viewer_aria_label}
            aria-modal="true"
            class="photo-viewer"
            node_ref={viewer_ref}
            role="dialog"
            tabindex="0"
        >
            {move || {
                if is_video_value.get() {
                    // 视频舞台不加滑动翻页:与点按播放/进度手势冲突,翻页走两侧按钮与键盘。
                    Some(view! {
                        <div
                            class="photo-viewer-stage is-video"
                            on:click=handle_stage_backdrop_click.clone()
                            on:pointerdown=handle_stage_pointer_down.clone()
                        >
                            <div
                                class="video-viewer-shell"
                                on:click=move |_: web_sys::MouseEvent| {
                                    // 点海报即播放(中央按钮仍保留);已起播时忽略
                                    if playback_source.get_untracked().is_none() {
                                        start_playback_for_click();
                                    }
                                }
                                style={video_shell_style}
                            >
                                {move || {
                                    let source = playback_source.get()?;
                                    Some(view! {
                                        <VideoPlayer
                                            dimensions={move || video_dimensions()}
                                            duration={move || {
                                                format_duration(memory.get().duration_seconds)
                                            }}
                                            on_buffering_change={Callback::new(move |buffering: bool| {
                                                dispatch(
                                                    &media_state,
                                                    MediaScope::Playback,
                                                    if buffering {
                                                        MediaLifecycleActionType::Buffer
                                                    } else {
                                                        MediaLifecycleActionType::Ready
                                                    },
                                                );
                                            })}
                                            on_ready={Callback::new(move |_: ()| {
                                                dispatch(
                                                    &media_state,
                                                    MediaScope::Playback,
                                                    MediaLifecycleActionType::Ready,
                                                );
                                            })}
                                            on_source_error={handle_video_source_error}
                                            poster={move || {
                                                queued_poster_src
                                                    .get()
                                                    .or_else(|| queued_small_src.get())
                                            }}
                                            src={source.src.clone()}
                                        />
                                    })
                                }}
                                {move || {
                                    (playback_source.get().is_none()).then(|| {
                                        let poster = queued_poster_src
                                            .get()
                                            .or_else(|| queued_small_src.get());
                                        view! {
                                            {move || match poster.clone() {
                                                Some(poster_src) => view! {
                                                    <img
                                                        alt={copy::DETAIL_PREVIEW_ALT}
                                                        class="photo-viewer-image is-loaded"
                                                        draggable="false"
                                                        src={poster_src}
                                                    />
                                                }
                                                .into_any(),
                                                None => view! {
                                                    <div aria-hidden="true" class="media-frame" />
                                                }
                                                .into_any(),
                                            }}
                                            <button
                                                aria-label={copy::VIEWER_PLAY}
                                                class="video-viewer-play"
                                                disabled={move || {
                                                    playback_loading.get().then(|| "disabled".to_string())
                                                }}
                                                on:click=move |event: web_sys::MouseEvent| {
                                                    event.stop_propagation();
                                                    start_playback_for_click();
                                                }
                                                type="button"
                                            >
                                                {icon_play("")}
                                            </button>
                                        }
                                    })
                                }}
                            </div>
                            {move || {
                                let loading = playback_loading.get();
                                let failed = playback_failed.get();
                                (loading || failed).then(|| {
                                    view! {
                                        <div aria-live="assertive" class="video-playback-overlay">
                                            {move || {
                                                if playback_loading.get() {
                                                    view! {
                                                        <p class="video-playback-message">
                                                            <span class="spinner text-primary" />
                                                            <span>{copy::VIEWER_PREPARING_PLAYBACK}</span>
                                                        </p>
                                                    }
                                                    .into_any()
                                                } else {
                                                    view! {
                                                        <p>
                                                            {move || {
                                                                if playback_unsupported.get() {
                                                                    copy::VIDEO_CODEC_UNSUPPORTED
                                                                } else {
                                                                    copy::DETAIL_PLAYBACK_FAILED
                                                                }
                                                            }}
                                                        </p>
                                                        <button
                                                            on:click=move |_: web_sys::MouseEvent| {
                                                                start_playback_for_click();
                                                            }
                                                            type="button"
                                                        >
                                                            {copy::DETAIL_RETRY}
                                                        </button>
                                                    }
                                                    .into_any()
                                                }
                                            }}
                                        </div>
                                    }
                                })
                            }}
                        </div>
                    })
                    .into_any()
                } else {
                    Some(view! {
                        <div
                            class="photo-viewer-stage"
                            on:click=handle_stage_backdrop_click.clone()
                            on:dblclick=move |_: web_sys::MouseEvent| {
                                if zoom.get_untracked() > 1.0 {
                                    reset_transform();
                                } else {
                                    zoom.set(2.5);
                                }
                            }
                            on:pointercancel=handle_pointer_up.clone()
                            on:pointerdown={
                                let stage_down = handle_stage_pointer_down.clone();
                                let pointer_down = handle_pointer_down.clone();
                                move |event: web_sys::PointerEvent| {
                                    stage_down(event.clone());
                                    pointer_down(event);
                                }
                            }
                            on:pointermove=handle_pointer_move.clone()
                            on:pointerup=handle_pointer_up.clone()
                            on:wheel=handle_wheel
                        >
                            // 滑动跟手层:仅包裹图片内容,状态浮层不随滑动位移
                            <div
                                class={move || {
                                    format!(
                                        "viewer-swipe-track {}",
                                        if swipe_following.get() { "is-following" } else { "" },
                                    )
                                }}
                                node_ref={swipe_track_ref}
                                style={move || {
                                    format!("transform: translateX({}px)", swipe_dx.get())
                                }}
                            >
                                {move || {
                                    let small = small_src.get();
                                    (small.is_some() && !small_image_failed.get()).then(|| {
                                        view! {
                                            <img
                                                alt=""
                                                aria-hidden="true"
                                                class={move || {
                                                    format!(
                                                        "photo-viewer-placeholder {}",
                                                        if small_image_ready.get() { "is-loaded" } else { "" },
                                                    )
                                                }}
                                                decoding="async"
                                                draggable="false"
                                                on:error=move |_: web_sys::ErrorEvent| {
                                                    small_image_failed.set(true);
                                                    dispatch(
                                                        &media_state,
                                                        MediaScope::Preview,
                                                        MediaLifecycleActionType::Fail,
                                                    );
                                                }
                                                on:load=move |_: web_sys::Event| {
                                                    small_image_ready.set(true);
                                                }
                                                src={move || queued_small_src.get()}
                                            />
                                        }
                                    })
                                }}
                                {move || {
                                    let src = photo_large_src.get()?;
                                    // 重试时重建 <img> 元素(对齐 React key={photoRetryKey})
                                    let _retry = photo_retry_key.get();
                                    let alt = {
                                        let title = memory.get().title;
                                        if title.is_empty() {
                                            copy::DETAIL_PREVIEW_ALT.to_string()
                                        } else {
                                            title
                                        }
                                    };
                                    Some(view! {
                                        <img
                                            alt={alt}
                                            class={move || {
                                                format!(
                                                    "photo-viewer-image {}",
                                                    if photo_preview_ready.get() { "is-loaded" } else { "" },
                                                )
                                            }}
                                            draggable="false"
                                            on:load=move |_: web_sys::Event| {
                                                dispatch(
                                                    &media_state,
                                                    MediaScope::Preview,
                                                    MediaLifecycleActionType::Ready,
                                                );
                                            }
                                            src={src}
                                            style={move || {
                                                let (x, y) = offset.get();
                                                format!(
                                                    "transform: translate3d({}px, {}px, 0) scale({})",
                                                    x,
                                                    y,
                                                    zoom.get(),
                                                )
                                            }}
                                        />
                                    })
                                }}
                            </div>
                            {move || {
                                preview_loading.get().then(|| {
                                    view! {
                                        <p aria-live="polite" class="photo-viewer-loading">
                                            <span class="spinner text-primary" />
                                            <span class="sr-only">{copy::DETAIL_MEDIA_LOADING}</span>
                                        </p>
                                    }
                                })
                            }}
                            {move || {
                                preview_failed.get().then(|| {
                                    view! {
                                        <div aria-live="assertive" class="video-playback-overlay">
                                            <p>{copy::DETAIL_IMAGE_LOAD_FAILED}</p>
                                            <button
                                                on:click=move |_: web_sys::MouseEvent| {
                                                    retry_preview_for_overlay();
                                                }
                                                type="button"
                                            >
                                                {copy::DETAIL_RETRY}
                                            </button>
                                        </div>
                                    }
                                })
                            }}
                            <div
                                aria-hidden="true"
                                class={move || {
                                    format!(
                                        "viewer-zoom-pill {}",
                                        if zoom_pill_visible.get() { "is-visible" } else { "" },
                                    )
                                }}
                            >
                                {move || format!("{}%", (zoom.get() * 100.0).round())}
                            </div>
                        </div>
                    })
                    .into_any()
                }
            }}

            // 状态元素常驻作为状态载体(测试与调试可读 data-state),
            // 全部就绪且无索引失败时整体隐藏,不再常驻「可用」徽章。
            <div
                aria-live={move || {
                    if active_is_failure.get() { "assertive" } else { "polite" }.to_string()
                }}
                class="viewer-status"
                data-scope={move || {
                    match active_media_state.get().scope {
                        MediaScope::Download => "download",
                        MediaScope::Playback => "playback",
                        MediaScope::Preview => "preview",
                    }
                    .to_string()
                }}
                data-state={move || active_media_state.get().state.as_str().to_string()}
                hidden={move || status_settled.get().then(|| "hidden".to_string())}
                role="status"
            >
                <span
                    class={move || {
                        let failure = has_index_failure.get() || active_is_failure.get();
                        format!("badge {}", if failure { "badge-warning" } else { "badge-success" })
                    }}
                >
                    {move || status_text.get()}
                </span>
            </div>

            // 查看器元信息:左下栈中层,标题 · 地点 · 日期(全空不渲染)
            {move || {
                (!viewer_caption.get().is_empty()).then(|| {
                    view! { <div class="viewer-caption">{viewer_caption.get()}</div> }
                })
            }}
            // 画布位置计数:视觉导航辅助(可读名已含标题),不进朗读树
            {move || {
                position.get()
                    .filter(|position| position.total > 1)
                    .map(|position| {
                        let text = copy::VIEWER_POSITION
                            .replace("{index}", &position.index.to_string())
                            .replace("{total}", &position.total.to_string());
                        view! {
                            <div aria-hidden="true" class="viewer-counter tnum">{text}</div>
                        }
                    })
            }}
            // 末尾自动续载提示:元信息上方浮层,画布追加期间可被读屏感知
            {move || {
                (is_loading_more.get() && position.get().is_some()).then(|| {
                    view! {
                        <div aria-live="polite" class="viewer-load-pill" role="status">
                            {copy::LOADING_MORE_LIBRARY}
                        </div>
                    }
                })
            }}
            // 复制链接反馈:底部居中胶囊,短暂显示后自动消失
            {move || {
                copy_feedback.get().map(|feedback| {
                    view! {
                        <div aria-live="polite" class="viewer-copy-pill" role="status">
                            {if feedback == CopyFeedback::Success {
                                copy::VIEWER_LINK_COPIED
                            } else {
                                copy::VIEWER_COPY_FAILED
                            }}
                        </div>
                    }
                })
            }}

            {move || {
                on_prev.get().map(|on_prev| {
                    view! {
                        <button
                            aria-label={copy::VIEWER_PREVIOUS}
                            class="photo-viewer-button photo-viewer-nav photo-viewer-nav-prev"
                            on:click=move |_: web_sys::MouseEvent| on_prev.run(())
                            title={copy::VIEWER_PREVIOUS}
                            type="button"
                        >
                            {icon_chevron_left("")}
                        </button>
                    }
                })
            }}
            {move || {
                on_next.get().map(|on_next| {
                    view! {
                        <button
                            aria-label={copy::VIEWER_NEXT}
                            class="photo-viewer-button photo-viewer-nav photo-viewer-nav-next"
                            on:click=move |_: web_sys::MouseEvent| on_next.run(())
                            title={copy::VIEWER_NEXT}
                            type="button"
                        >
                            {icon_chevron_right("")}
                        </button>
                    }
                })
            }}

            <div class="photo-viewer-actions">
                <button
                    aria-label={copy::DETAIL_RETRY}
                    class="photo-viewer-button"
                    disabled={move || {
                        (!is_video_value.get()
                            && !has_index_failure.get()
                            && photo_preview_ready.get())
                            .then(|| "disabled".to_string())
                    }}
                    title={copy::DETAIL_RETRY}
                    on:click=move |_: web_sys::MouseEvent| {
                        if is_video_value.get() {
                            start_playback();
                            return;
                        }
                        retry_preview();
                    }
                    type="button"
                >
                    {icon_refresh_cw("")}
                </button>
                <button
                    aria-label={move || {
                        if download_failed.get() {
                            copy::VIEWER_RETRY_DOWNLOAD
                        } else {
                            copy::VIEWER_DOWNLOAD
                        }
                        .to_string()
                    }}
                    class="photo-viewer-button"
                    disabled={move || download_loading.get().then(|| "disabled".to_string())}
                    title={move || {
                        if download_failed.get() {
                            copy::VIEWER_RETRY_DOWNLOAD
                        } else {
                            copy::VIEWER_DOWNLOAD
                        }
                        .to_string()
                    }}
                    on:click=move |_: web_sys::MouseEvent| start_download()
                    type="button"
                >
                    {move || {
                        if download_failed.get() {
                            icon_triangle_alert("").into_any()
                        } else {
                            icon_download("").into_any()
                        }
                    }}
                </button>
                <button
                    aria-label={copy::VIEWER_COPY_LINK}
                    class="photo-viewer-button"
                    title={copy::VIEWER_COPY_LINK}
                    on:click=move |_: web_sys::MouseEvent| handle_copy_link()
                    type="button"
                >
                    {icon_link_2("")}
                </button>
                <button
                    aria-label={copy::CLOSE}
                    class="photo-viewer-button"
                    on:click=move |_: web_sys::MouseEvent| on_close.run(())
                    title={copy::CLOSE}
                    type="button"
                >
                    {icon_x("")}
                </button>
            </div>
        </div>
    }
}
