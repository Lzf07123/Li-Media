// 首页(逐语义对齐 pages/HomePage.tsx):URL 驱动状态(?kind/?keyword/
// ?viewer/?view=space 的读写)、无限分段加载(IntersectionObserver)、
// 分页加载队列、骨架屏、hero 首屏捕获、预热轮询、空间画廊。
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use leptos::prelude::*;
use leptos_router::hooks::{use_location, use_navigate, use_query_map};
use leptos_router::params::ParamsMap;
use leptos_router::NavigateOptions;
use wasm_bindgen::{closure::Closure, JsCast, JsValue};

use crate::api;
use crate::api::types::{MemorySummary, PublicPreheatStatusResponse};
use crate::brand::{copy, Brand};
use crate::components::hero_feature::HeroFeature;
use crate::components::media_viewer::{MediaViewer, ViewerPosition};
use crate::components::memory_card::MemoryCard;
use crate::components::space::space_gallery::SpaceGallery;
use crate::components::ui::blur_text::{BlurText, BlurTextTag};
use crate::components::ui::button::{Button, ButtonVariant};
use crate::components::ui::empty_state::EmptyState;
use crate::components::ui::icons::{icon_images, icon_orbit, icon_refresh_cw, icon_search, icon_x};
use crate::components::ui::media_skeleton::MediaSkeleton;
use crate::components::ui::notice::{Notice, NoticeTone};
use crate::components::ui::progress_bar::ProgressBar;
use crate::lib::canvas_composition::{
    distribute_masonry_columns, write_canvas_composition, CompositionSize, FALLBACK_MASONRY_RATIO,
};
use crate::lib::document_title::use_document_title;

const PAGE_SIZE: u32 = 18;
const RECOMMENDATION_COUNT: u32 = 8;
const SCROLL_STORAGE_KEY: &str = "limedia:home-scroll";
const PREHEAT_POLL_INTERVAL_MS: u32 = 20000;
const PREHEAT_RETRY_DELAYS_MS: [u32; 3] = [500, 1000, 2000];
// 终态不再轮询:预热任务未启动时状态不会自行变化,下次进页重新查询。
const PREHEAT_TERMINAL_STATUSES: [&str; 3] = ["ready", "degraded", "unavailable"];
const AUTO_REFRESH_MAX_SCROLL_Y: f64 = 120.0;
// hero 精选的比例门槛:cover 后可见面积占比 < 60% 的图像不进随机池。
const HERO_FIT_MIN_VISIBLE: f64 = 0.6;
// 瀑布屏列数上限(与 CSS 断点口径一致)。
const MAX_CANVAS_COLUMNS: usize = 6;

thread_local! {
    /// 仅从画布进入 viewer 时记录原位;翻页(replace)不覆盖滚动原点。
    static SCROLL_BEFORE_VIEWER: Cell<f64> = const { Cell::new(0.0) };
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CountState {
    Loading,
    Ready,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PreheatState {
    Loading,
    Ready,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CanvasFooterState {
    Hidden,
    Loading,
    Retry,
    End,
}

impl CanvasFooterState {
    fn as_str(self) -> &'static str {
        match self {
            CanvasFooterState::Hidden => "hidden",
            CanvasFooterState::Loading => "loading",
            CanvasFooterState::Retry => "retry",
            CanvasFooterState::End => "end",
        }
    }
}

// ViewerPosition(查看器画布内位置,1 起)已随 MediaViewer 迁入
// components/media_viewer.rs,此处直接导入使用。

fn is_terminal_preheat_status(status: &str) -> bool {
    PREHEAT_TERMINAL_STATUSES.contains(&status)
}

/// viewer 来自 URL 输入:不合法直接视为无查看器,避免进入请求路径。
/// 对齐 /^[A-Za-z0-9_-]{1,64}$/。
fn normalize_viewer_id(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    let valid = !raw.is_empty()
        && raw.len() <= 64
        && raw
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    valid.then(|| raw.to_string())
}

fn create_random_seed() -> String {
    if let Some(window) = web_sys::window() {
        let crypto = js_sys::Reflect::get(window.as_ref(), &JsValue::from_str("crypto"));
        if let Ok(crypto) = crypto {
            let random_uuid = js_sys::Reflect::get(&crypto, &JsValue::from_str("randomUUID"));
            if let Ok(random_uuid) = random_uuid {
                if let Ok(random_uuid) = random_uuid.dyn_into::<js_sys::Function>() {
                    if let Ok(result) = random_uuid.call0(&crypto) {
                        if let Some(seed) = result.as_string() {
                            return seed;
                        }
                    }
                }
            }
        }
    }
    format!(
        "{}-{}",
        js_sys::Date::now() as u64,
        (js_sys::Math::random() * 1e9) as u64
    )
}

fn read_saved_scroll() -> f64 {
    web_sys::window()
        .and_then(|window| window.session_storage().ok().flatten())
        .and_then(|storage| storage.get_item(SCROLL_STORAGE_KEY).ok().flatten())
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0)
}

/// hero 舞台当前比例(与 CSS 同口径:桌面 clamp(560px, 92svh, 920px),
/// 移动端 ≤768px 全屏 100svh——innerHeight 即 svh 可见视口高)。
fn hero_stage_ratio() -> f64 {
    let Some(window) = web_sys::window() else {
        return 1.0;
    };
    let is_mobile = window
        .match_media("(max-width: 768px)")
        .ok()
        .flatten()
        .map(|query| query.matches())
        .unwrap_or(false);
    let inner_height = window
        .inner_height()
        .ok()
        .and_then(|value| value.as_f64())
        .unwrap_or(800.0);
    let inner_width = window
        .inner_width()
        .ok()
        .and_then(|value| value.as_f64())
        .unwrap_or(1280.0);
    let stage_height = if is_mobile {
        inner_height
    } else {
        (inner_height * 0.92).clamp(560.0, 920.0)
    };
    inner_width / stage_height
}

/// 图像在 hero 舞台上按 cover 展示时的可见面积占比(0-1]。
fn hero_visible_fraction(width: f64, height: f64, stage_ratio: f64) -> f64 {
    let image_ratio = width / height;
    image_ratio.min(stage_ratio) / image_ratio.max(stage_ratio)
}

fn scroll_to_top_auto() {
    if let Some(window) = web_sys::window() {
        let options = web_sys::ScrollToOptions::new();
        options.set_top(0.0);
        options.set_behavior(web_sys::ScrollBehavior::Auto);
        let _ = window.scroll_to_with_scroll_to_options(&options);
    }
}

fn restore_scroll_to(previous_scroll: f64) {
    if !previous_scroll.is_finite() || previous_scroll <= 0.0 {
        return;
    }
    if let Some(window) = web_sys::window() {
        let options = web_sys::ScrollToOptions::new();
        options.set_top(previous_scroll);
        options.set_behavior(web_sys::ScrollBehavior::Auto);
        let _ = window.scroll_to_with_scroll_to_options(&options);
    }
}

async fn sleep_ms(ms: u32) {
    let Some(window) = web_sys::window() else {
        return;
    };
    let promise = js_sys::Promise::new(&mut |resolve, _reject| {
        let _ = window.set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, ms as i32);
    });
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
}

#[component]
pub fn HomePage() -> impl IntoView {
    let query = use_query_map();
    let location = use_location();
    let navigate = use_navigate();

    // URL 参数更新:react-router setSearchParams 对应物(push/replace)。
    // scroll:false:滚动由调用方按 React 语义显式控制。
    let update_params = Arc::new(move |next: &ParamsMap, replace: bool| {
        let query_string = next.to_query_string();
        let target = if query_string.is_empty() {
            "/".to_string()
        } else {
            format!("/{}", query_string)
        };
        navigate(
            &target,
            NavigateOptions {
                replace,
                scroll: false,
                ..NavigateOptions::default()
            },
        );
    });

    // URL 是唯一事实源(对齐 useSearchParams 读取)。
    let active_kind = Memo::new(move |_| {
        let kind = query.get().get_str("kind").map(|value| value.to_string());
        match kind.as_deref() {
            Some("photo") | Some("video") => kind,
            _ => None,
        }
    });
    let keyword = Memo::new(move |_| {
        query
            .get()
            .get_str("keyword")
            .unwrap_or_default()
            .trim()
            .to_string()
    });
    let viewer_id = Memo::new(move |_| normalize_viewer_id(query.get().get_str("viewer")));
    // 空间画廊视图://?view=space 切换沉浸式时间回廊,网格数据流整体让位。
    let is_space_view = Memo::new(move |_| query.get().get_str("view") == Some("space"));

    let search_input = RwSignal::new(keyword.get_untracked());
    let recommendations: RwSignal<Vec<MemorySummary>> = RwSignal::new(Vec::new());
    let recommendation_token = RwSignal::new(0u64);
    // 回廊已载条目上报:查看器在此视图下从回廊列表解析相邻内容与位置。
    let space_items: RwSignal<Vec<MemorySummary>> = RwSignal::new(Vec::new());
    let space_total = RwSignal::new(0u32);
    // 3D 沉浸态(flat 时间线不算):驱动页眉压图配色与页脚隐藏。
    let space_immersive = RwSignal::new(false);
    let memories: RwSignal<Vec<MemorySummary>> = RwSignal::new(Vec::new());
    let direct_memory: RwSignal<Option<MemorySummary>> = RwSignal::new(None);
    let direct_memory_token = RwSignal::new(0u64);
    let viewer_missing = RwSignal::new(false);
    let counts = RwSignal::new(api::types::MemoryCounts::default());
    let total = RwSignal::new(0u32);
    let public_count_state = RwSignal::new(CountState::Loading);
    let preheat_summary = RwSignal::new(Option::<PublicPreheatStatusResponse>::None);
    let preheat_state = RwSignal::new(PreheatState::Loading);
    let preheat_status_ref = RwSignal::new(Option::<String>::None);
    let is_loading_initial = RwSignal::new(true);
    let is_loading_more = RwSignal::new(false);
    let error = RwSignal::new(Option::<String>::None);
    let load_more_error = RwSignal::new(Option::<String>::None);
    let request_token = RwSignal::new(0u64);
    let page_stored = RwSignal::new(1u32);
    let is_loading_more_ref = RwSignal::new(false);
    let has_restored_scroll = RwSignal::new(false);
    let was_space_view_ref = RwSignal::new(false);
    let column_count = RwSignal::new(2usize);
    let segment_indicator = RwSignal::new((0.0f64, 0.0f64, false));
    let sentinel_ref = NodeRef::<leptos::html::Div>::new();
    let segmented_ref = NodeRef::<leptos::html::Div>::new();

    // 随机种子:kind 变化时重生成(对齐 seedState render-sync),换一批只重置 seed。
    let seed = RwSignal::new(create_random_seed());
    let seed_kind_mirror = RwSignal::new(active_kind.get_untracked());
    Effect::new(move || {
        let kind = active_kind.get();
        if seed_kind_mirror.get_untracked() != kind {
            seed_kind_mirror.set(kind);
            seed.set(create_random_seed());
        }
    });

    let load_page = move |page: u32, replace: bool| {
        let token = request_token.get_untracked() + 1;
        request_token.set(token);
        if replace {
            is_loading_initial.set(true);
            memories.set(Vec::new());
            viewer_missing.set(false);
        } else {
            is_loading_more.set(true);
        }
        let kind = active_kind.get_untracked();
        let keyword_value = keyword.get_untracked();
        let seed_value = seed.get_untracked();
        async move {
            let result = api::get_memories(
                kind.as_deref(),
                (!keyword_value.is_empty()).then_some(keyword_value.as_str()),
                Some("random"),
                Some(&seed_value),
                page,
                PAGE_SIZE,
            )
            .await;
            let success = match result {
                Ok(data) if token == request_token.get_untracked() => {
                    page_stored.set(page);
                    if replace {
                        memories.set(data.items);
                    } else {
                        let known: HashSet<String> = memories
                            .get()
                            .iter()
                            .map(|memory| memory.id.clone())
                            .collect();
                        memories.update(|current| {
                            for item in data.items {
                                if !known.contains(&item.id) {
                                    current.push(item);
                                }
                            }
                        });
                    }
                    total.set(data.total);
                    // 计数行与类型页签都用「可展示口径」:与画布实际可见内容一致。
                    counts.set(data.counts);
                    public_count_state.set(CountState::Ready);
                    error.set(None);
                    load_more_error.set(None);
                    true
                }
                Ok(_) => false,
                Err(_) if token == request_token.get_untracked() => {
                    if replace {
                        error.set(Some(copy::LOAD_FAILED.to_string()));
                    } else {
                        load_more_error.set(Some(copy::LOAD_MORE_FAILED.to_string()));
                    }
                    false
                }
                Err(_) => false,
            };
            if token == request_token.get_untracked() {
                if replace {
                    is_loading_initial.set(false);
                } else {
                    is_loading_more.set(false);
                }
            }
            success
        }
    };

    // 空间视图有自己的 captured_desc 数据流,网格初始加载让位;
    // 返回网格时本 effect 随依赖重建自动恢复。
    Effect::new(move || {
        let kind = active_kind.get();
        let keyword_value = keyword.get();
        let seed_value = seed.get();
        let space = is_space_view.get();
        if space {
            return;
        }
        let _ = (&kind, &keyword_value, &seed_value);
        let future = load_page(1, true);
        wasm_bindgen_futures::spawn_local(async move {
            let _ = future.await;
        });
    });

    // 搜索输入防抖同步到 URL keyword 参数;URL 外部变化时回填输入框。
    Effect::new(move || {
        let keyword_value = keyword.get();
        if search_input.get_untracked() != keyword_value {
            search_input.set(keyword_value);
        }
    });

    let update_params_for_debounce = update_params.clone();
    Effect::new(move || {
        let keyword_value = keyword.get();
        let input = search_input.get();
        let query_snapshot = query.get();
        if input.trim() == keyword_value {
            return;
        }
        let update_params_for_callback = update_params_for_debounce.clone();
        let timer: Arc<Cell<Option<i32>>> = Arc::new(Cell::new(None));
        let callback: Closure<dyn Fn()> = Closure::new(move || {
            let mut next = query_snapshot.clone();
            let normalized = input.trim().to_string();
            if normalized.is_empty() {
                next.remove("keyword");
            } else {
                next.insert("keyword", normalized);
            }
            update_params_for_callback(&next, false);
            // 新关键词生效后从顶部看结果(与换一批行为对齐)
            scroll_to_top_auto();
        });
        if let Some(window) = web_sys::window() {
            let timer_id = window
                .set_timeout_with_callback_and_timeout_and_arguments_0(
                    callback.as_ref().unchecked_ref(),
                    400,
                )
                .ok();
            timer.set(timer_id);
        }
        let timer = send_wrapper::SendWrapper::new(timer);
        let callback = send_wrapper::SendWrapper::new(callback);
        on_cleanup(move || {
            if let Some(timer_id) = (*timer).get() {
                if let Some(window) = web_sys::window() {
                    let _ = window.clear_timeout_with_handle(timer_id);
                }
            }
            drop(callback);
        });
    });

    enum PollOutcome {
        Continue,
        Retry(u32),
        Terminal,
        StopAfterError,
    }

    // 预热轮询:终态停止;错误按 500/1000/2000 退避,3 次后停止;
    // 切回标签页时非终态立即刷新。
    let handle_preheat = move |result: Result<PublicPreheatStatusResponse, api::ApiError>,
                              failures: &mut u32|
          -> PollOutcome {
        match result {
            Ok(summary) => {
                let previous = preheat_status_ref.get_untracked();
                preheat_status_ref.set(Some(summary.status.clone()));
                preheat_summary.set(Some(summary.clone()));
                preheat_state.set(PreheatState::Ready);
                *failures = 0;
                let became_terminal = previous
                    .as_deref()
                    .map(|status| !is_terminal_preheat_status(status))
                    .unwrap_or(false)
                    && is_terminal_preheat_status(&summary.status);
                if became_terminal
                    && web_sys::window()
                        .and_then(|window| window.scroll_y().ok())
                        .unwrap_or(0.0)
                        <= AUTO_REFRESH_MAX_SCROLL_Y
                {
                    // 预热刚到终态:顶部附近的用户即刻补齐新就绪的内容。
                    let future = load_page(1, true);
                    wasm_bindgen_futures::spawn_local(async move {
                        let _ = future.await;
                    });
                }
                if is_terminal_preheat_status(&summary.status) {
                    PollOutcome::Terminal
                } else {
                    PollOutcome::Continue
                }
            }
            Err(_) => {
                preheat_summary.set(None);
                preheat_state.set(PreheatState::Error);
                if *failures < PREHEAT_RETRY_DELAYS_MS.len() as u32 {
                    let delay = PREHEAT_RETRY_DELAYS_MS[*failures as usize];
                    *failures += 1;
                    PollOutcome::Retry(delay)
                } else {
                    PollOutcome::StopAfterError
                }
            }
        }
    };

    Effect::new(move || {
        wasm_bindgen_futures::spawn_local(async move {
            let mut failures = 0u32;
            loop {
                let result = api::get_preheat_status().await;
                match handle_preheat(result, &mut failures) {
                    PollOutcome::Terminal | PollOutcome::StopAfterError => break,
                    PollOutcome::Continue => sleep_ms(PREHEAT_POLL_INTERVAL_MS).await,
                    PollOutcome::Retry(delay) => sleep_ms(delay).await,
                }
            }
        });

        let Some(document) = web_sys::window().and_then(|window| window.document()) else {
            return;
        };
        let on_visibility: Closure<dyn Fn()> = Closure::new(move || {
            let visible = web_sys::window()
                .and_then(|window| window.document())
                .map(|document| {
                    document.visibility_state() == web_sys::VisibilityState::Visible
                })
                .unwrap_or(false);
            if !visible {
                return;
            }
            // 终态不因切回标签页重新请求;尚未拿到状态或非终态时立即刷新。
            let current = preheat_status_ref.get_untracked();
            if current
                .as_deref()
                .map(is_terminal_preheat_status)
                .unwrap_or(false)
            {
                return;
            }
            let handle_once = handle_preheat;
            wasm_bindgen_futures::spawn_local(async move {
                let result = api::get_preheat_status().await;
                let mut failures = 0u32;
                match handle_once(result, &mut failures) {
                    PollOutcome::Retry(delay) => wasm_bindgen_futures::spawn_local(async move {
                        sleep_ms(delay).await;
                    }),
                    _ => {}
                }
            });
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

    // 推荐:搜索时直接展示结果不混入推荐内容;空间视图不拉推荐。
    Effect::new(move || {
        let kind = active_kind.get();
        let keyword_value = keyword.get();
        let seed_value = seed.get();
        let space = is_space_view.get();
        let _ = &seed_value;
        if !keyword_value.is_empty() || space {
            recommendations.set(Vec::new());
            return;
        }
        let token = recommendation_token.get_untracked() + 1;
        recommendation_token.set(token);
        wasm_bindgen_futures::spawn_local(async move {
            let items =
                api::get_memory_recommendations(RECOMMENDATION_COUNT, kind.as_deref()).await;
            if token == recommendation_token.get_untracked() {
                recommendations.set(items.unwrap_or_default());
            }
        });
    });

    // 分段筛选滑动指示器:测量激活项的偏移与宽度,覆盖层用 transform/width
    // 过渡滑过去。依赖:类型切换、计数位数、容器尺寸。
    Effect::new(move || {
        let kind = active_kind.get();
        let counts_value = counts.get();
        let _ = (kind, counts_value.photo, counts_value.video);

        let measure = {
            let segmented_ref = segmented_ref;
            let segment_indicator = segment_indicator;
            move || {
                let Some(container) = segmented_ref.get() else {
                    return;
                };
                let active = container
                    .unchecked_ref::<web_sys::Element>()
                    .query_selector("[data-active='true']")
                    .ok()
                    .flatten()
                    .and_then(|element| element.dyn_into::<web_sys::HtmlElement>().ok());
                match active {
                    Some(active) => {
                        segment_indicator.set((
                            active.offset_left() as f64,
                            active.offset_width() as f64,
                            true,
                        ));
                    }
                    None => {
                        segment_indicator.update(|indicator| indicator.2 = false);
                    }
                }
            }
        };

        measure();
        // 字体就绪会改变按钮文字宽度;首帧后补量一次(document.fonts.ready)。
        if let Some(document) = web_sys::window().and_then(|window| window.document()) {
            let fonts = js_sys::Reflect::get(document.as_ref(), &JsValue::from_str("fonts"));
            if let Ok(fonts) = fonts {
                let ready = js_sys::Reflect::get(&fonts, &JsValue::from_str("ready"));
                if let Ok(ready) = ready {
                    let then_fn = js_sys::Reflect::get(&ready, &JsValue::from_str("then"));
                    if let Ok(then_fn) = then_fn {
                        if let Ok(then_fn) = then_fn.dyn_into::<js_sys::Function>() {
                            let measure_after_fonts: Closure<dyn Fn(JsValue)> = {
                                let measure = measure.clone();
                                Closure::new(move |_value: JsValue| measure())
                            };
                            let _ = then_fn.call1(
                                &ready,
                                measure_after_fonts.as_ref().unchecked_ref(),
                            );
                            std::mem::forget(measure_after_fonts);
                        }
                    }
                }
            }
        }

        let resize_callback: Closure<
            dyn FnMut(Vec<web_sys::ResizeObserverEntry>, web_sys::ResizeObserver),
        > = {
            let measure = measure.clone();
            Closure::new(
                move |_entries: Vec<web_sys::ResizeObserverEntry>,
                      _observer: web_sys::ResizeObserver| {
                    measure();
                },
            )
        };
        let observer = web_sys::ResizeObserver::new(resize_callback.as_ref().unchecked_ref()).ok();
        if let Some(observer) = observer.as_ref() {
            if let Some(container) = segmented_ref.get() {
                observer.observe(container.unchecked_ref::<web_sys::Element>());
            }
        }
        let observer = observer.map(send_wrapper::SendWrapper::new);
        std::mem::forget(resize_callback);
        on_cleanup(move || {
            if let Some(observer) = observer.as_ref() {
                observer.disconnect();
            }
        });
    });

    // 网格唯一化:推荐在前、分页在后,按 id 去重保序(对齐 useMemo)。
    let canvas_memories = Memo::new(move |_| {
        let mut unique: Vec<MemorySummary> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for memory in recommendations.get().into_iter().chain(memories.get()) {
            if seen.insert(memory.id.clone()) {
                unique.push(memory);
            }
        }
        unique
    });

    let has_next_page = Memo::new(move |_| {
        let length = memories.with(Vec::len);
        length > 0 && (length as u32) < total.get()
    });

    // 图像 hero:首屏数据一到就捕获精选集(≤5 条),之后画布换批/翻页/
    // 筛选都不再改动 hero。捕获时按舞台比例过滤随机池(可见面积占比 ≥60%),
    // 无合适图像时按可见占比降序取前 5。
    let hero_source: RwSignal<Option<Vec<MemorySummary>>> = RwSignal::new(None);
    Effect::new(move |_| {
        let loading = is_loading_initial.get();
        let list = canvas_memories.get();
        if hero_source.get_untracked().is_some() || loading || list.is_empty() {
            return;
        }
        let stage_ratio = hero_stage_ratio();
        let ranked: Vec<(usize, f64)> = list
            .iter()
            .enumerate()
            .map(|(index, memory)| {
                let visible = match (memory.width, memory.height) {
                    (Some(width), Some(height)) if width > 0 && height > 0 => {
                        hero_visible_fraction(width as f64, height as f64, stage_ratio)
                    }
                    _ => 1.0,
                };
                (index, visible)
            })
            .collect();
        let fitting: Vec<usize> = ranked
            .iter()
            .filter(|(_, visible)| *visible >= HERO_FIT_MIN_VISIBLE)
            .map(|(index, _)| *index)
            .collect();
        let pool: Vec<usize> = if !fitting.is_empty() {
            fitting
        } else {
            let mut all = ranked;
            all.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            all.into_iter().map(|(index, _)| index).collect()
        };
        let selected: Vec<MemorySummary> = pool
            .into_iter()
            .take(5)
            .filter_map(|index| list.get(index).cloned())
            .collect();
        hero_source.set(Some(selected));
    });

    let hero_memories_len = Memo::new(move |_| {
        hero_source
            .get()
            .map(|memories_list| memories_list.len())
            .unwrap_or(0)
    });
    let hero_loading = Memo::new(move |_| is_loading_initial.get() && hero_memories_len.get() == 0);
    let hero_hidden = Memo::new(move |_| !keyword.get().is_empty() || hero_memories_len.get() == 0);
    let hero_memories_for_view = Memo::new(move |_| hero_source.get().unwrap_or_default());

    // 骨架屏按真实宽高实时计算:优先内存中的真实 items。
    let known_sizes = Memo::new(move |_| {
        canvas_memories
            .get()
            .into_iter()
            .take(36)
            .filter_map(|memory| match (memory.width, memory.height) {
                (Some(width), Some(height)) if width > 0 && height > 0 => Some(CompositionSize {
                    width: width as f64,
                    height: height as f64,
                }),
                _ => None,
            })
            .collect::<Vec<CompositionSize>>()
    });

    // 列表数据到达后写入构图缓存供下次刷新复用。
    Effect::new(move |_| {
        let loading = is_loading_initial.get();
        let list = canvas_memories.get();
        if !loading && !list.is_empty() {
            write_canvas_composition(&list);
        }
    });

    // 页眉压图配色开关:hero 在首屏时页眉切浅色;搜索态收起 hero;
    // 空间画廊 3D 沉浸态同样压图,flat 时间线不压。
    Effect::new(move |_| {
        let hero_len = hero_memories_len.get();
        let keyword_value = keyword.get();
        let space = is_space_view.get();
        let immersive = space && space_immersive.get();
        if let Some(document) = web_sys::window().and_then(|window| window.document()) {
            if let Some(body) = document.body() {
                let has_hero = immersive || (!space && hero_len > 0 && keyword_value.is_empty());
                let _ = body.class_list().toggle_with_force("has-hero", has_hero);
                let _ = body
                    .class_list()
                    .toggle_with_force("has-space-stage", immersive);
            }
        }
    });

    // 瀑布屏分配:最短列优先;未知尺寸用 4/5 兜底。列分配与骨架屏共用
    // 同一最短列算法(distributeMasonryColumns),骨架→卡片零位移。
    let canvas_ratio = |memory: &MemorySummary| match (memory.width, memory.height) {
        (Some(width), Some(height)) if width > 0 && height > 0 => height as f64 / width as f64,
        _ => FALLBACK_MASONRY_RATIO,
    };
    let canvas_columns: [Memo<Vec<MemorySummary>>; MAX_CANVAS_COLUMNS] =
        std::array::from_fn(|column_index| {
            Memo::new(move |_| {
                let count = column_count.get();
                let list = canvas_memories.get();
                let columns = distribute_masonry_columns(&list, count, canvas_ratio);
                columns.get(column_index).cloned().unwrap_or_default()
            })
        });
    let first_row_ids = Memo::new(move |_| {
        let count = column_count.get();
        let list = canvas_memories.get();
        let columns = distribute_masonry_columns(&list, count, canvas_ratio);
        columns
            .iter()
            .filter_map(|column| column.first().map(|memory| memory.id.clone()))
            .collect::<HashSet<String>>()
    });
    let enter_index_map = Memo::new(move |_| {
        let count = column_count.get();
        let list = canvas_memories.get();
        let columns = distribute_masonry_columns(&list, count, canvas_ratio);
        let mut map: HashMap<String, u32> = HashMap::new();
        for (column_index, column) in columns.iter().enumerate() {
            for (item_index, memory) in column.iter().enumerate() {
                map.insert(memory.id.clone(), (item_index * count + column_index) as u32);
            }
        }
        map
    });

    // 列数跟随断点(对齐 useCanvasColumnCount)。
    Effect::new(move |_| {
        let Some(window) = web_sys::window() else {
            return;
        };
        let breakpoints: [(&str, usize); 4] = [
            ("(min-width: 1600px)", 6),
            ("(min-width: 1280px)", 5),
            ("(min-width: 1024px)", 4),
            ("(min-width: 768px)", 3),
        ];
        let queries: Vec<(web_sys::MediaQueryList, usize)> = breakpoints
            .iter()
            .filter_map(|(query, count)| {
                window
                    .match_media(query)
                    .ok()
                    .flatten()
                    .map(|list| (list, *count))
            })
            .collect();
        let queries = Arc::new(queries);
        let update = {
            let queries = queries.clone();
            let column_count = column_count;
            move || {
                let matched = queries
                    .iter()
                    .find(|(query, _)| query.matches())
                    .map(|(_, count)| *count)
                    .unwrap_or(2);
                column_count.set(matched);
            }
        };
        update();
        let update = Arc::new(update);
        let update_closure: Closure<dyn Fn()> = Closure::new({
            let update_for_closure = update.clone();
            move || update_for_closure()
        });
        for (query, _) in queries.iter() {
            let _ = query.add_event_listener_with_callback(
                "change",
                update_closure.as_ref().unchecked_ref(),
            );
        }
        let update_closure = send_wrapper::SendWrapper::new(update_closure);
        let queries = send_wrapper::SendWrapper::new(queries);
        on_cleanup(move || {
            for (query, _) in queries.iter() {
                let _ = query.remove_event_listener_with_callback(
                    "change",
                    update_closure.as_ref().unchecked_ref(),
                );
            }
        });
    });

    // 查看器内容序列:网格视图用画布列表;空间视图用回廊已载列表。
    let viewer_memories = Memo::new(move |_| {
        if is_space_view.get() {
            space_items.get()
        } else {
            canvas_memories.get()
        }
    });
    let viewer_total = Memo::new(move |_| {
        if is_space_view.get() {
            (space_total.get() as usize).max(space_items.with(Vec::len)) as u32
        } else {
            viewer_memories.with(Vec::len) as u32
        }
    });

    // 直链 viewer:内容不在已载列表时单查一次。
    Effect::new(move || {
        let viewer = viewer_id.get();
        let list = viewer_memories.get();
        let in_list = viewer
            .as_ref()
            .map(|id| list.iter().any(|memory| &memory.id == id))
            .unwrap_or(false);
        if viewer.is_none() || in_list {
            return;
        }
        let viewer = viewer.unwrap();
        let token = direct_memory_token.get_untracked() + 1;
        direct_memory_token.set(token);
        direct_memory.set(None);
        viewer_missing.set(false);
        wasm_bindgen_futures::spawn_local(async move {
            let result = api::get_memory_by_id(&viewer).await;
            if token == direct_memory_token.get_untracked() {
                match result {
                    Ok(memory) => direct_memory.set(Some(memory)),
                    Err(_) => viewer_missing.set(true),
                }
            }
        });
    });

    // 滚动位置存档(进入 viewer/空间画廊前的恢复点)。
    Effect::new(move || {
        let Some(window) = web_sys::window() else {
            return;
        };
        let on_scroll: Closure<dyn Fn()> = Closure::new(move || {
            if let Some(window) = web_sys::window() {
                let scroll_y = window.scroll_y().unwrap_or(0.0);
                if let Ok(Some(storage)) = window.session_storage() {
                    let _ = storage.set_item(SCROLL_STORAGE_KEY, &scroll_y.to_string());
                }
            }
        });
        let _ = window.add_event_listener_with_callback(
            "scroll",
            on_scroll.as_ref().unchecked_ref(),
        );
        let on_scroll = send_wrapper::SendWrapper::new(on_scroll);
        let window = send_wrapper::SendWrapper::new(window);
        on_cleanup(move || {
            let _ = window.remove_event_listener_with_callback(
                "scroll",
                on_scroll.as_ref().unchecked_ref(),
            );
        });
    });

    // 首次数据就绪后恢复上次滚动位置(仅首页)。
    Effect::new(move || {
        let loading = is_loading_initial.get();
        let pathname = location.pathname.get();
        if loading || has_restored_scroll.get_untracked() {
            return;
        }
        has_restored_scroll.set(true);
        let previous_scroll = read_saved_scroll();
        if previous_scroll <= 0.0 || pathname != "/" {
            return;
        }
        wasm_bindgen_futures::spawn_local(async move {
            // 对齐 double requestAnimationFrame:等两帧再滚动。
            sleep_ms(16).await;
            sleep_ms(16).await;
            restore_scroll_to(previous_scroll);
        });
    });

    // 从空间画廊返回网格时恢复进入前的滚动位置(进入时已由滚动监听存档)。
    Effect::new(move || {
        let space = is_space_view.get();
        let loading = is_loading_initial.get();
        let pathname = location.pathname.get();
        if space {
            was_space_view_ref.set(true);
            return;
        }
        if !was_space_view_ref.get_untracked() || loading {
            return;
        }
        was_space_view_ref.set(false);
        let previous_scroll = read_saved_scroll();
        if previous_scroll <= 0.0 || pathname != "/" {
            return;
        }
        wasm_bindgen_futures::spawn_local(async move {
            sleep_ms(16).await;
            sleep_ms(16).await;
            restore_scroll_to(previous_scroll);
        });
    });

    let load_next_page = Callback::new(move |_: ()| {
        if is_loading_initial.get_untracked()
            || is_loading_more.get_untracked()
            || is_loading_more_ref.get_untracked()
            || error.get_untracked().is_some()
            || load_more_error.get_untracked().is_some()
            || !has_next_page.get_untracked()
        {
            return;
        }
        is_loading_more_ref.set(true);
        let next_page = page_stored.get_untracked() + 1;
        let future = load_page(next_page, false);
        wasm_bindgen_futures::spawn_local(async move {
            let _ = future.await;
            is_loading_more_ref.set(false);
        });
    });

    // 无限分段加载:sentinel 进入视口前 600px 触发追加下一页。
    Effect::new(move || {
        let loading_initial = is_loading_initial.get();
        let loading_more = is_loading_more.get();
        let has_error = error.get().is_some();
        let has_load_more_error = load_more_error.get().is_some();
        let more_available = has_next_page.get();
        let space = is_space_view.get();
        if space
            || loading_initial
            || loading_more
            || has_error
            || has_load_more_error
            || !more_available
        {
            return;
        }
        let load_next = load_next_page;
        let callback: Closure<
            dyn Fn(Vec<web_sys::IntersectionObserverEntry>, web_sys::IntersectionObserver),
        > = Closure::new(
            move |entries: Vec<web_sys::IntersectionObserverEntry>,
                  _observer: web_sys::IntersectionObserver| {
                if entries.iter().any(|entry| entry.is_intersecting()) {
                    load_next.run(());
                }
            },
        );
        let options = web_sys::IntersectionObserverInit::new();
        options.set_root_margin("600px 0px");
        let observer = web_sys::IntersectionObserver::new_with_options(
            callback.as_ref().unchecked_ref(),
            &options,
        );
        match observer {
            Ok(observer) => {
                if let Some(sentinel) = sentinel_ref.get() {
                    observer.observe(sentinel.unchecked_ref::<web_sys::Element>());
                }
                std::mem::forget(callback);
                let observer = send_wrapper::SendWrapper::new(observer);
                on_cleanup(move || observer.disconnect());
            }
            Err(_) => std::mem::forget(callback),
        }
    });

    let update_params_for_kind = update_params.clone();
    let change_kind = Callback::new(move |next_kind: Option<String>| {
        let mut next = query.get_untracked().clone();
        match next_kind.as_deref() {
            Some("photo") => next.insert("kind", "photo".to_string()),
            Some("video") => next.insert("kind", "video".to_string()),
            _ => {
                next.remove("kind");
            }
        }
        // 直觉对齐:切换类型后从顶部看新结果(与换一批一致);同时清空搜索。
        next.remove("keyword");
        next.remove("sort");
        next.remove("page");
        update_params_for_kind(&next, false);
        scroll_to_top_auto();
    });

    let update_params_for_clear = update_params.clone();
    let clear_search = Callback::new(move |_: ()| {
        search_input.set(String::new());
        if !keyword.get_untracked().is_empty() {
            let mut next = query.get_untracked().clone();
            next.remove("keyword");
            update_params_for_clear(&next, false);
        }
    });

    // 空间画廊进出:view 参数驱动(URL 可深链分享)。
    let update_params_for_enter = update_params.clone();
    let enter_space = Callback::new(move |_: ()| {
        let mut next = query.get_untracked().clone();
        next.insert("view", "space".to_string());
        update_params_for_enter(&next, false);
    });
    let update_params_for_exit = update_params.clone();
    let exit_space = Callback::new(move |_: ()| {
        let mut next = query.get_untracked().clone();
        next.remove("view");
        update_params_for_exit(&next, false);
    });

    let update_params_for_open = update_params.clone();
    let open_viewer = Arc::new(move |memory_id: String, replace: bool| {
        // 仅从画布进入 viewer 时记录原位;翻页(replace)不覆盖滚动原点。
        let already_open = query.get_untracked().get_str("viewer").is_some();
        if !already_open {
            SCROLL_BEFORE_VIEWER.with(|cell| {
                cell.set(
                    web_sys::window()
                        .and_then(|window| window.scroll_y().ok())
                        .unwrap_or(0.0),
                )
            });
        }
        let mut next = query.get_untracked().clone();
        next.insert("viewer", memory_id);
        update_params_for_open(&next, replace);
    });
    let on_open_viewer = {
        let open_viewer = open_viewer.clone();
        Callback::new(move |memory_id: String| open_viewer(memory_id, false))
    };
    let on_open_viewer_replace = {
        let open_viewer = open_viewer.clone();
        Callback::new(move |memory_id: String| open_viewer(memory_id, true))
    };

    let update_params_for_close = update_params.clone();
    let close_viewer = Callback::new(move |_: ()| {
        let mut next = query.get_untracked().clone();
        next.remove("viewer");
        direct_memory.set(None);
        viewer_missing.set(false);
        // 关闭 viewer 用 replace:back 不应重新打开 viewer,而是离开本页。
        update_params_for_close(&next, true);
        let previous_scroll = SCROLL_BEFORE_VIEWER.with(|cell| cell.get());
        wasm_bindgen_futures::spawn_local(async move {
            sleep_ms(100).await;
            if previous_scroll.is_finite() && previous_scroll > 0.0 {
                restore_scroll_to(previous_scroll);
            }
        });
    });

    // hero CTA「进入回忆库」:滚动到画布工具条,尊重 reduced-motion 偏好。
    let enter_library = Callback::new(move |_: ()| {
        let Some(document) = web_sys::window().and_then(|window| window.document()) else {
            return;
        };
        let Ok(Some(target)) = document.query_selector(".library-toolbar") else {
            return;
        };
        let reduce_motion = web_sys::window()
            .and_then(|window| window.match_media("(prefers-reduced-motion: reduce)").ok())
            .flatten()
            .map(|query| query.matches())
            .unwrap_or(false);
        let options = web_sys::ScrollIntoViewOptions::new();
        options.set_behavior(if reduce_motion {
            web_sys::ScrollBehavior::Auto
        } else {
            web_sys::ScrollBehavior::Smooth
        });
        options.set_block(web_sys::ScrollLogicalPosition::Start);
        let _ = target.scroll_into_view_with_scroll_into_view_options(&options);
    });

    let active_memory = Memo::new(move |_| {
        let viewer = viewer_id.get();
        let from_list = viewer.and_then(|id| {
            viewer_memories
                .get()
                .into_iter()
                .find(|memory| memory.id == id)
        });
        from_list.or_else(|| direct_memory.get())
    });
    let active_memory_index = Memo::new(move |_| match active_memory.get() {
        Some(active) => viewer_memories
            .get()
            .iter()
            .position(|memory| memory.id == active.id)
            .map(|index| index as i64)
            .unwrap_or(-1),
        None => -1,
    });
    let viewer_neighbors = Memo::new(move |_| {
        let index = active_memory_index.get();
        let list = viewer_memories.get();
        let previous = (index > 0).then(|| list[(index - 1) as usize].clone());
        let next = ((index >= 0) && ((index as usize) + 1 < list.len()))
            .then(|| list[(index + 1) as usize].clone());
        [previous, next].into_iter().flatten().collect::<Vec<MemorySummary>>()
    });

    // 查看器翻页回调:相邻内容按需取自 viewer_neighbors(信号实时读取,
    // 等价 React 的每次渲染新闭包 + ref 转发口径)。
    let viewer_on_next = {
        let on_open_viewer_replace = on_open_viewer_replace.clone();
        Callback::new(move |_: ()| {
            let neighbors = viewer_neighbors.get();
            if let Some(next) = neighbors.last() {
                on_open_viewer_replace.run(next.id.clone());
            }
        })
    };
    let viewer_on_prev = {
        let on_open_viewer_replace = on_open_viewer_replace.clone();
        Callback::new(move |_: ()| {
            let neighbors = viewer_neighbors.get();
            if let Some(previous) = neighbors.first() {
                on_open_viewer_replace.run(previous.id.clone());
            }
        })
    };

    // 查看器接近已加载末尾时自动续载:翻到画布边界前先追加下一页;
    // loadNextPage 内部守卫防并发与重复。
    Effect::new(move || {
        let viewer = viewer_id.get();
        let index = active_memory_index.get();
        let length = viewer_memories.with(Vec::len);
        let loading_initial = is_loading_initial.get();
        let more_available = has_next_page.get_untracked();
        if viewer.is_none() || !more_available || loading_initial || index < 0 {
            return;
        }
        if index as usize >= length.saturating_sub(3) {
            load_next_page.run(());
        }
    });

    // 从 viewer 返回时恢复进入前的滚动位置。
    Effect::new(move || {
        let viewer = viewer_id.get();
        let pathname = location.pathname.get();
        if viewer.is_some() {
            return;
        }
        let previous_scroll = SCROLL_BEFORE_VIEWER.with(|cell| cell.get());
        if !previous_scroll.is_finite() || previous_scroll <= 0.0 || pathname != "/" {
            return;
        }
        wasm_bindgen_futures::spawn_local(async move {
            sleep_ms(100).await;
            restore_scroll_to(previous_scroll);
        });
    });

    use_document_title(move || match active_memory.get() {
        Some(memory) => Brand::PAGE_TITLE_VIEWER.replace(
            "{title}",
            if memory.title.is_empty() {
                copy::DETAIL_PREVIEW_ALT
            } else {
                &memory.title
            },
        ),
        None => Brand::PAGE_TITLE_HOME.to_string(),
    });

    let on_prefetch_stub = Callback::new(move |_: ()| {});
    let canvas_footer_state = Memo::new(move |_| {
        if canvas_memories.with(Vec::is_empty) {
            CanvasFooterState::Hidden
        } else if load_more_error.get().is_some() {
            CanvasFooterState::Retry
        } else if is_loading_more.get() {
            CanvasFooterState::Loading
        } else if memories.with(Vec::len) as u32 >= total.get() {
            CanvasFooterState::End
        } else {
            CanvasFooterState::Hidden
        }
    });

    // 查看器覆盖层(两个视图共用;覆盖层不卸载底视图)。
    // 挂载期只跟踪「有无内容」,内容本体经 Memo 传给 MediaViewer 响应式
    // 更新(翻页不重挂载,对齐 React 的 props 更新语义)。
    let viewer_memory = Memo::new(move |_| {
        active_memory
            .get()
            .unwrap_or_else(|| crate::components::media_viewer::empty_memory_summary())
    });
    let has_viewer_memory = Memo::new(move |_| active_memory.get().is_some());
    let viewer_position = Memo::new(move |_| {
        let index = active_memory_index.get();
        index.ge(&0).then(|| ViewerPosition {
            index: (index + 1) as u32,
            total: viewer_total.get(),
        })
    });
    let viewer_node = move || {
        has_viewer_memory.get().then(|| {
            view! {
                <MediaViewer
                    is_loading_more={is_loading_more}
                    memory={viewer_memory}
                    on_close={close_viewer}
                    on_next={Some(viewer_on_next)}
                    on_prev={Some(viewer_on_prev)}
                    position={viewer_position}
                    prefetch_targets={viewer_neighbors}
                />
            }
        })
    };
    let viewer_missing_node = move || {
        viewer_missing.get().then(|| {
            view! {
                <Notice class="mt-8" tone={NoticeTone::Error}>
                    {copy::NOT_FOUND_TEXT}
                </Notice>
            }
        })
    };

    view! {
        {move || {
            // URL 驱动视图:空间画廊整体让位(数据流与 hook 顺序与视图无关)。
            // 画廊 props 全部走 Signal:条目上报(kind 切换/续载)不重建画廊,
            // 相机位置与焦点在 overlay 打开/关闭期间天然保留。
            if is_space_view.get() {
                return view! {
                    <section aria-labelledby="library-title" class="page-enter hero-page">
                        <h1 class="sr-only" id="library-title">
                            {copy::LIBRARY_TITLE}
                        </h1>
                        <SpaceGallery
                            kind={active_kind}
                            on_exit_space={exit_space}
                            on_immersive_change={Callback::new(move |immersive: bool| {
                                space_immersive.set(immersive);
                            })}
                            on_items_change={Callback::new(
                                move |(items, total_value): (Vec<MemorySummary>, u32)| {
                                    space_items.set(items);
                                    space_total.set(total_value);
                                },
                            )}
                            on_kind_change={change_kind}
                            on_open_viewer={on_open_viewer}
                        />
                        {move || viewer_missing_node()}
                        {move || viewer_node()}
                    </section>
                }
                .into_any();
            }

            view! {
                <section aria-labelledby="library-title" class="page-enter hero-page">
                    {move || {
                        // 搜索态收起 hero:结果(含空结果态)直接顶到工具条;
                        // 清除搜索后按已捕获的 heroSource 原样恢复,第一印象不变。
                        if !keyword.get().is_empty() {
                            return None;
                        }
                        Some(view! {
                            <HeroFeature
                                loading={move || hero_loading.get()}
                                memories={hero_memories_for_view.get()}
                                on_enter={enter_library}
                                on_open={on_open_viewer}
                            />
                        })
                    }}
                    // hero 不在时保证页面恰有一个 h1:搜索态/空库/加载失败场景兜底
                    {move || {
                        hero_hidden.get().then(|| {
                            view! {
                                <BlurText
                                    class={format!(
                                        "page-title text-3xl sm:text-5xl font-semibold tracking-wide {}",
                                        if is_loading_initial.get() { "sr-only" } else { "" },
                                    )}
                                    id="library-title"
                                    tag={BlurTextTag::H1}
                                    text={copy::LIBRARY_TITLE.to_string()}
                                />
                            }
                        })
                    }}
                    {move || {
                        (hero_hidden.get() && !is_loading_initial.get()).then(|| {
                            view! {
                                <div aria-hidden="true" class="flow-rule mx-auto mt-4 w-16" />
                                <p class="mt-3 text-center text-base text-muted">
                                    {copy::LIBRARY_DESCRIPTION}
                                </p>
                            }
                        })
                    }}

                    <p
                        aria-live="polite"
                        class="tnum page-enter mt-5 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-center"
                        data-testid="public-count"
                        style="animation-delay: 80ms"
                    >
                        {move || {
                            match public_count_state.get() {
                                CountState::Loading => view! {
                                    <span class="text-sm text-muted">{copy::PUBLIC_COUNT_LOADING}</span>
                                }
                                .into_any(),
                                CountState::Error => view! {
                                    <span class="text-sm text-muted">{copy::PUBLIC_COUNT_FAILED}</span>
                                }
                                .into_any(),
                                CountState::Ready => view! {
                                    <>
                                        <span class="flex items-baseline gap-2">
                                            <span class="text-sm text-muted">{copy::PUBLIC_COUNT_LABEL}</span>
                                            <span class="font-display text-2xl font-semibold text-foreground">
                                                {" "}
                                                {counts.get().photo + counts.get().video}
                                            </span>
                                        </span>
                                        <span aria-hidden="true" class="h-8 w-px bg-border" />
                                        <span class="flex items-baseline gap-2">
                                            <span class="text-sm text-muted">{copy::PHOTO_KIND}</span>
                                            <span class="font-display text-2xl font-semibold text-foreground">
                                                {" "}
                                                {counts.get().photo}
                                            </span>
                                        </span>
                                        <span aria-hidden="true" class="h-8 w-px bg-border" />
                                        <span class="flex items-baseline gap-2">
                                            <span class="text-sm text-muted">{copy::VIDEO_KIND}</span>
                                            <span class="font-display text-2xl font-semibold text-foreground">
                                                {" "}
                                                {counts.get().video}
                                            </span>
                                        </span>
                                    </>
                                }
                                .into_any(),
                            }
                        }}
                    </p>

                    // 预热状态只在有信息量时渲染:加载中与 ready 不占位、不闪现。
                    {move || {
                        let summary = preheat_summary.get();
                        let state = preheat_state.get();
                        if state == PreheatState::Error
                            || summary
                                .as_ref()
                                .map(|summary| summary.status == "unavailable")
                                .unwrap_or(false)
                        {
                            return view! {
                                <p
                                    aria-live="polite"
                                    class="mt-2 text-center text-sm text-muted"
                                    data-testid="preheat-status"
                                >
                                    {copy::PREHEAT_STATUS_UNAVAILABLE}
                                </p>
                            }
                            .into_any();
                        }
                        if let Some(summary) = summary.as_ref().filter(|s| s.status == "running") {
                            let processed = summary.processed;
                            let total_value = summary.total;
                            return view! {
                                <div class="mx-auto mt-2 max-w-xs" data-testid="preheat-status">
                                    <p aria-live="polite" class="text-center text-sm text-muted">
                                        {copy::PREHEAT_STATUS_RUNNING}
                                        <span class="ml-2">
                                            {format!(
                                                "{} {} / {}",
                                                copy::PREHEAT_STATUS_PROGRESS,
                                                processed,
                                                total_value,
                                            )}
                                        </span>
                                    </p>
                                    <ProgressBar
                                        label={copy::PREHEAT_STATUS_RUNNING.to_string()}
                                        value={if total_value > 0 {
                                            (processed as f64 / total_value as f64) * 100.0
                                        } else {
                                            0.0
                                        }}
                                    />
                                </div>
                            }
                            .into_any();
                        }
                        if summary
                            .as_ref()
                            .map(|summary| summary.status == "not_preheated")
                            .unwrap_or(false)
                        {
                            return view! {
                                <p
                                    aria-live="polite"
                                    class="mt-2 text-center text-sm text-muted"
                                    data-testid="preheat-status"
                                >
                                    {copy::PREHEAT_STATUS_NOT_PREHEATED}
                                </p>
                            }
                            .into_any();
                        }
                        if summary
                            .as_ref()
                            .map(|summary| summary.status == "degraded")
                            .unwrap_or(false)
                        {
                            return view! {
                                <p
                                    aria-live="polite"
                                    class="mt-2 text-center text-sm text-muted"
                                    data-testid="preheat-status"
                                >
                                    {copy::PREHEAT_STATUS_DEGRADED}
                                </p>
                            }
                            .into_any();
                        }
                        ().into_any()
                    }}

                    <div
                        class="library-toolbar filter-toolbar page-enter mx-auto mt-8 w-full max-w-2xl"
                        style="animation-delay: 160ms"
                    >
                        <form
                            class="library-search relative"
                            on:submit=move |event: web_sys::SubmitEvent| event.prevent_default()
                            role="search"
                        >
                            <label class="sr-only" for="library-search">
                                {copy::SEARCH_LABEL}
                            </label>
                            {icon_search(
                                "pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted",
                            )}
                            <input
                                class="input min-h-11 w-full pl-10"
                                id="library-search"
                                on:input=move |event: web_sys::Event| {
                                    search_input.set(event_target_value(&event));
                                }
                                placeholder={copy::SEARCH_PLACEHOLDER}
                                prop:value={move || search_input.get()}
                                type="search"
                            />
                            {move || {
                                (!keyword.get().is_empty()).then(|| {
                                    view! {
                                        <Button
                                            aria_label={copy::CLEAR_SEARCH.to_string()}
                                            class="icon-btn shrink-0"
                                            disabled={false}
                                            on_click={Callback::new(
                                                move |_: web_sys::MouseEvent| clear_search.run(()),
                                            )}
                                            title={copy::CLEAR_SEARCH.to_string()}
                                            variant={ButtonVariant::Secondary}
                                        >
                                            {icon_x("size-5")}
                                        </Button>
                                    }
                                })
                            }}
                        </form>
                        <div class="filter-toolbar-row flex flex-wrap items-center gap-2">
                            <div
                                aria-label={copy::KIND_FILTER_LABEL}
                                class="segmented"
                                node_ref={segmented_ref}
                                role="group"
                            >
                                <span
                                    aria-hidden="true"
                                    class="segmented-indicator"
                                    data-ready={move || {
                                        segment_indicator
                                            .get()
                                            .2
                                            .then(|| "true".to_string())
                                            .unwrap_or_else(|| "false".to_string())
                                    }}
                                    style={move || {
                                        let (x, w, _) = segment_indicator.get();
                                        format!("transform: translateX({}px); width: {}px", x, w)
                                    }}
                                />
                                <button
                                    aria-pressed={move || active_kind.get().is_none().to_string()}
                                    data-active={move || {
                                        active_kind
                                            .get()
                                            .is_none()
                                            .then(|| "true".to_string())
                                            .unwrap_or_else(|| "false".to_string())
                                    }}
                                    on:click=move |_: web_sys::MouseEvent| change_kind.run(None)
                                    type="button"
                                >
                                    {copy::ALL_KINDS}
                                </button>
                                <button
                                    aria-pressed={move || {
                                        (active_kind.get().as_deref() == Some("photo")).to_string()
                                    }}
                                    data-active={move || {
                                        (active_kind.get().as_deref() == Some("photo"))
                                            .then(|| "true".to_string())
                                            .unwrap_or_else(|| "false".to_string())
                                    }}
                                    on:click=move |_: web_sys::MouseEvent| {
                                        change_kind.run(Some("photo".to_string()));
                                    }
                                    type="button"
                                >
                                    {copy::PHOTO_KIND}
                                    <span class="segmented-count">
                                        {move || counts.get().photo}
                                    </span>
                                </button>
                                <button
                                    aria-pressed={move || {
                                        (active_kind.get().as_deref() == Some("video")).to_string()
                                    }}
                                    data-active={move || {
                                        (active_kind.get().as_deref() == Some("video"))
                                            .then(|| "true".to_string())
                                            .unwrap_or_else(|| "false".to_string())
                                    }}
                                    on:click=move |_: web_sys::MouseEvent| {
                                        change_kind.run(Some("video".to_string()));
                                    }
                                    type="button"
                                >
                                    {copy::VIDEO_KIND}
                                    <span class="segmented-count">
                                        {move || counts.get().video}
                                    </span>
                                </button>
                            </div>
                            <Button
                                aria_label={copy::HOME_REFRESH.to_string()}
                                class="icon-btn"
                                disabled={is_loading_initial}
                                on_click={Callback::new(move |_: web_sys::MouseEvent| {
                                    if is_loading_initial.get_untracked() {
                                        return;
                                    }
                                    seed.set(create_random_seed());
                                    scroll_to_top_auto();
                                })}
                                title={copy::HOME_REFRESH.to_string()}
                                variant={ButtonVariant::Secondary}
                            >
                                {move || {
                                    icon_refresh_cw(if is_loading_initial.get() {
                                        "size-5 animate-spin"
                                    } else {
                                        "size-5"
                                    })
                                }}
                            </Button>
                            <Button
                                aria_label={copy::space::TOGGLE.to_string()}
                                disabled={false}
                                on_click={Callback::new(
                                    move |_: web_sys::MouseEvent| enter_space.run(()),
                                )}
                                title={copy::space::TOGGLE.to_string()}
                                variant={ButtonVariant::Secondary}
                            >
                                {icon_orbit("size-5")}
                                // 窄屏收成纯图标:筛选条一行放不下图标+文字(横向溢出回归)
                                <span class="hidden sm:inline">{copy::space::TOGGLE}</span>
                            </Button>
                        </div>
                    </div>

                    {move || {
                        (!keyword.get().is_empty()).then(|| {
                            view! {
                                <p
                                    aria-live="polite"
                                    class="mt-3 text-center text-sm text-muted"
                                    data-testid="search-summary"
                                >
                                    {copy::RESULT_SUMMARY.replace("{total}", &total.get().to_string())}
                                </p>
                            }
                        })
                    }}

                    {move || {
                        if is_loading_initial.get() {
                            return view! {
                                <>
                                    <span class="sr-only">{copy::LOADING_LIBRARY}</span>
                                    <MediaSkeleton
                                        column_count={column_count.get()}
                                        sizes={known_sizes.get()}
                                    />
                                </>
                            }
                            .into_any();
                        }
                        if let Some(error_message) = error.get() {
                            return view! {
                                <Notice class="mt-8" tone={NoticeTone::Error}>
                                    <span>{error_message}</span>
                                    <Button
                                        class="ml-2"
                                        disabled={false}
                                        on_click={Callback::new(move |_: web_sys::MouseEvent| {
                                            let future = load_page(1, true);
                                            wasm_bindgen_futures::spawn_local(async move {
                                                let _ = future.await;
                                            });
                                        })}
                                        variant={ButtonVariant::Secondary}
                                    >
                                        {copy::LOAD_FAILED_ACTION}
                                    </Button>
                                </Notice>
                            }
                            .into_any();
                        }
                        if canvas_memories.with(Vec::is_empty) {
                            return view! {
                                <div class="mt-8">
                                    <EmptyState
                                        action={
                                            (!keyword.get_untracked().is_empty()).then(|| {
                                                let clear_search = clear_search;
                                                std::sync::Arc::new(move || {
                                                    view! {
                                                        <Button
                                                            disabled={false}
                                                            on_click={Callback::new(
                                                move |_: web_sys::MouseEvent| clear_search.run(()),
                                            )}
                                                            variant={ButtonVariant::Secondary}
                                                        >
                                                            {copy::CLEAR_SEARCH}
                                                        </Button>
                                                    }
                                                    .into_any()
                                                }) as ChildrenFn
                                            })
                                        }
                                        art={Some(std::sync::Arc::new(move || {
                                            icon_images("size-[42px]").into_any()
                                        }) as ChildrenFn)}
                                    >
                                        {move || {
                                            let keyword_present = !keyword.get().is_empty();
                                            let summary = preheat_summary.get();
                                            if keyword_present {
                                                copy::EMPTY_SEARCH.to_string()
                                            } else if summary
                                                .as_ref()
                                                .map(|summary| {
                                                    !is_terminal_preheat_status(&summary.status)
                                                })
                                                .unwrap_or(false)
                                            {
                                                copy::EMPTY_LIBRARY_PREPARING.to_string()
                                            } else {
                                                copy::EMPTY_LIBRARY.to_string()
                                            }
                                        }}
                                    </EmptyState>
                                </div>
                            }
                            .into_any();
                        }

                        view! {
                            <section
                                aria-label={copy::LIBRARY_TITLE}
                                class="infinite-canvas mx-auto w-full"
                            >
                                <div
                                    class="masonry"
                                    style={move || {
                                        format!(
                                            "grid-template-columns: repeat({}, minmax(0, 1fr))",
                                            column_count.get(),
                                        )
                                    }}
                                >
                                    {(0..MAX_CANVAS_COLUMNS)
                                        .map(|column_index| {
                                            let column_signal = canvas_columns[column_index];
                                            view! {
                                                {move || {
                                                    (column_count.get() > column_index).then(|| {
                                                        view! {
                                                            <div class="canvas-column">
                                                                <For
                                                                    children={move |memory: MemorySummary| {
                                                                        let enter_index = enter_index_map
                                                                            .get_untracked()
                                                                            .get(&memory.id)
                                                                            .copied()
                                                                            .unwrap_or(0);
                                                                        let priority = first_row_ids
                                                                            .get_untracked()
                                                                            .contains(&memory.id);
                                                                        view! {
                                                                            <MemoryCard
                                                                                enter_index={enter_index}
                                                                                memory={memory}
                                                                                on_open={on_open_viewer}
                                                                                on_prefetch={Some(on_prefetch_stub)}
                                                                                priority={priority}
                                                                            />
                                                                        }
                                                                    }}
                                                                    each={move || column_signal.get()}
                                                                    key={|memory: &MemorySummary| memory
                                                                        .id
                                                                        .clone()}
                                                                />
                                                            </div>
                                                        }
                                                    })
                                                }}
                                            }
                                        })
                                        .collect_view()}
                                </div>
                                <div aria-hidden="true" class="canvas-sentinel" node_ref={sentinel_ref} />
                                <div
                                    aria-live="polite"
                                    class="canvas-loading"
                                    data-state={move || canvas_footer_state.get().as_str()}
                                    data-testid="canvas-footer"
                                    role="status"
                                >
                                    {move || {
                                        match canvas_footer_state.get() {
                                            CanvasFooterState::Loading => view! {
                                                <span>{copy::LOADING_MORE_LIBRARY}</span>
                                            }
                                            .into_any(),
                                            CanvasFooterState::Retry => view! {
                                                <>
                                                    <span>{load_more_error.get().unwrap_or_default()}</span>
                                                    <Button
                                                        class="ml-2"
                                                        disabled={false}
                                                        on_click={Callback::new(move |_: web_sys::MouseEvent| {
                                                            load_more_error.set(None);
                                                            load_next_page.run(());
                                                        })}
                                                        variant={ButtonVariant::Secondary}
                                                    >
                                                        {copy::RETRY_LOAD_MORE}
                                                    </Button>
                                                </>
                                            }
                                            .into_any(),
                                            CanvasFooterState::End => view! {
                                                <>
                                                    <span>{copy::CANVAS_END}</span>
                                                    <span aria-hidden="true" class="mx-2 text-muted">{"·"}</span>
                                                    <span>
                                                        {copy::CANVAS_END_TOTAL
                                                            .replace("{total}", &total.get().to_string())}
                                                    </span>
                                                </>
                                            }
                                            .into_any(),
                                            CanvasFooterState::Hidden => ().into_any(),
                                        }
                                    }}
                                </div>
                            </section>
                        }
                        .into_any()
                    }}

                    {move || viewer_missing_node()}
                    {move || viewer_node()}
                </section>
            }
            .into_any()
        }}
    }
}
