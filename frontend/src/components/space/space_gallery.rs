// SpaceGallery(逐语义对齐 components/space/SpaceGallery.tsx):
// 时间回廊舞台。数据流(captured_desc 分页续载)、3D 挂载窗口、年份
// 里程碑、几何拾取(射线-倾斜平面求交,替代 DOM hit-test)、键盘/滚轮/
// 拖拽行进、480 近景升档错峰、flat 降级(reduced-motion / 不支持 3D
// 时展开为纵向时间线,走原生 lazy + 尾哨兵续载)。相机弹簧在 wasm 内
// 积分,直写窗口内元素 transform/opacity(camera.rs)。
// 共享状态用 Arc<Mutex>/Atomic:动态视图闭包与回调要求 Send+Sync。
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use leptos::prelude::*;
use wasm_bindgen::{closure::Closure, JsCast};

use crate::api;
use crate::api::types::MemorySummary;
use crate::brand::copy;
use crate::components::space::camera::{
    compute_flat, install_camera, parse_year, pick_pane_at, read_space_geometry, FogTargets,
    SpaceCamera, SpaceCameraGeometry, StageRect,
};
use crate::components::space::space_pane::{SpaceMilestone, SpacePane};
use crate::components::ui::button::{Button, ButtonVariant};
use crate::components::ui::empty_state::EmptyState;
use crate::components::ui::icon_button::IconButton;
use crate::components::ui::icons::{
    icon_chevron_down, icon_chevron_up, icon_images, icon_layout_grid,
};
use crate::components::ui::notice::{Notice, NoticeTone};

const SPACE_PAGE_SIZE: u32 = 18;
/// 挂载缓冲:焦点 ±5 档(呈现窗口 ±3 档,缓冲防快速推进时反复装卸)
const MOUNT_BUFFER: i64 = 5;
/// 近景升档半径:落定档位 ±2 档取 480px
const NEAR_RANGE: i64 = 2;
/// 相机落定档位距已载末尾 ≤4 档时续载下一页
const LOAD_MORE_AHEAD: i64 = 4;

const NAVIGATION_KEYS: [&str; 6] = [
    "ArrowDown",
    "ArrowUp",
    "PageDown",
    "PageUp",
    "Home",
    "End",
];

/// 从事件目标向上找 [data-space-index] pane(React closest 对应物)。
fn space_index_from_target(target: Option<web_sys::EventTarget>) -> Option<usize> {
    let element = target?.dyn_into::<web_sys::Element>().ok()?;
    let pane = element.closest("[data-space-index]").ok().flatten()?;
    pane.get_attribute("data-space-index")
        .and_then(|value| value.parse().ok())
}

#[component]
pub fn SpaceGallery(
    /// kind 过滤(URL ?kind,Signal:类型切换时内部重新拉取,不重建画廊)
    #[prop(into)] kind: Signal<Option<String>>,
    on_open_viewer: Callback<String>,
    on_exit_space: Callback<()>,
    on_kind_change: Callback<Option<String>>,
    /// 已载条目上报:供首页查看器在回廊场景下解析相邻内容与位置
    on_items_change: Callback<(Vec<MemorySummary>, u32)>,
    /// 3D 沉浸态上报:驱动页眉压图配色与页脚隐藏(flat 时间线不沉浸)
    on_immersive_change: Callback<bool>,
) -> impl IntoView {
    // —— 数据状态 ——
    let items: RwSignal<Vec<MemorySummary>> = RwSignal::new(Vec::new());
    let total = RwSignal::new(0u32);
    let is_loading = RwSignal::new(true);
    let is_loading_more = RwSignal::new(false);
    let error: RwSignal<Option<String>> = RwSignal::new(None);
    let more_error: RwSignal<Option<String>> = RwSignal::new(None);
    // —— 相机/交互状态 ——
    let focus_index = RwSignal::new(0usize);
    let settled_index: RwSignal<Option<usize>> = RwSignal::new(None);
    let flat = RwSignal::new(compute_flat());
    let hint_hidden = RwSignal::new(false);
    let hovered_index: RwSignal<Option<usize>> = RwSignal::new(None);
    // 480 升档错峰:落定后 120ms 再升档,避免解码挤占吸附末帧
    let enhanced_index: RwSignal<Option<usize>> = RwSignal::new(None);

    // —— refs / 共享状态(Send+Sync:进动态视图闭包与回调) ——
    let stage_ref = NodeRef::<leptos::html::Div>::new();
    let corridor_ref = NodeRef::<leptos::html::Div>::new();
    let tail_sentinel_ref = NodeRef::<leptos::html::Div>::new();
    let live_region_ref = NodeRef::<leptos::html::P>::new();
    let fog_targets: FogTargets = Arc::new(Mutex::new(Vec::new()));
    let count_ref: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));
    let page_ref: Arc<AtomicU32> = Arc::new(AtomicU32::new(1));
    let request_token_ref: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
    let loading_more_ref: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
    // 焦点锚点(挂载窗口):键盘保有,初值 -1 表示无(信号:参与挂载窗口重算)
    let focused_index_ref = RwSignal::new(-1i64);
    // 焦点档位(两段式交互:点中焦点 pane 打开查看器)
    let focus_index_ref: Arc<AtomicI64> = Arc::new(AtomicI64::new(0));
    let geometry_ref: Arc<Mutex<SpaceCameraGeometry>> =
        Arc::new(Mutex::new(read_space_geometry()));
    // 渲染清单用 gap 快照(对齐 React useState(readSpaceGeometry) 的挂载期取值)
    let geometry_gap = geometry_ref.lock().unwrap_or_else(|e| e.into_inner()).gap;
    let stage_rect_ref: Arc<Mutex<StageRect>> = Arc::new(Mutex::new(StageRect::default()));

    let camera = SpaceCamera::new(geometry_ref.clone(), count_ref.clone());

    // —— 数据:captured_desc 让首页一页即「今天」,推进方向 = 分页顺序 ——
    // append 防并发;replace(切类型/重试)必须随时可打断在途的 append。
    let load_page: Arc<dyn Fn(u32, bool) + Send + Sync> = {
        let request_token_ref = request_token_ref.clone();
        let page_ref = page_ref.clone();
        let loading_more_ref = loading_more_ref.clone();
        Arc::new(
        move |page: u32, replace: bool| {
            let token = request_token_ref.load(Ordering::Relaxed) + 1;
            request_token_ref.store(token, Ordering::Relaxed);
            if !replace && loading_more_ref.load(Ordering::Relaxed) {
                return;
            }

            if replace {
                is_loading.set(true);
                items.set(Vec::new());
                total.set(0);
                focus_index.set(0);
                settled_index.set(None);
                focused_index_ref.set(-1);
            } else {
                is_loading_more.set(true);
                loading_more_ref.store(true, Ordering::Relaxed);
            }

            let kind_value = kind.get_untracked();
            let state_refs = (
                request_token_ref.clone(),
                page_ref.clone(),
                items,
                total,
                is_loading,
                is_loading_more,
                loading_more_ref.clone(),
                error,
                more_error,
            );
            wasm_bindgen_futures::spawn_local(async move {
                let (request_token_ref, page_ref, items, total, is_loading, is_loading_more, loading_more_ref, error, more_error) =
                    state_refs;
                let result = api::get_memories(
                    kind_value.as_deref(),
                    None,
                    Some("captured_desc"),
                    None,
                    page,
                    SPACE_PAGE_SIZE,
                )
                .await;
                if token != request_token_ref.load(Ordering::Relaxed) {
                    return;
                }
                match result {
                    Ok(data) => {
                        page_ref.store(page, Ordering::Relaxed);
                        if replace {
                            items.set(data.items);
                        } else {
                            let known: HashSet<String> = items
                                .get()
                                .iter()
                                .map(|memory| memory.id.clone())
                                .collect();
                            items.update(|current| {
                                for memory in data.items {
                                    if !known.contains(&memory.id) {
                                        current.push(memory);
                                    }
                                }
                            });
                        }
                        total.set(data.total);
                        error.set(None);
                        more_error.set(None);
                    }
                    Err(_) => {
                        if replace {
                            error.set(Some(copy::LOAD_FAILED.to_string()));
                        } else {
                            more_error.set(Some(copy::LOAD_MORE_FAILED.to_string()));
                        }
                    }
                }
                is_loading.set(false);
                is_loading_more.set(false);
                loading_more_ref.store(false, Ordering::Relaxed);
            });
        },
        )
    };

    // 类型变化重新拉取第一页(URL ?kind 切换,画廊不重建)。
    {
        let load_page = load_page.clone();
        Effect::new(move |_| {
            let kind_value = kind.get();
            let _ = kind_value;
            load_page(1, true);
        });
    }

    // 相机用的已载条目计数。
    Effect::new(move |_| {
        let length = items.with(Vec::len);
        count_ref.store(length, Ordering::Relaxed);
    });

    // 已载条目上报(items/total 每次变化都上报,含挂载时的空列表)。
    Effect::new(move |_| {
        let current_items = items.get();
        let total_value = total.get();
        on_items_change.run((current_items, total_value));
    });

    let has_more = Memo::new(move |_| {
        let length = items.with(Vec::len);
        length > 0 && (length as u32) < total.get()
    });

    let load_next_page: Arc<dyn Fn() + Send + Sync> = Arc::new({
        let load_page = load_page.clone();
        move || {
            if is_loading.get_untracked()
                || is_loading_more.get_untracked()
                || more_error.get_untracked().is_some()
                || !has_more.get_untracked()
            {
                return;
            }
            load_page(
                page_ref.load(Ordering::Relaxed) + 1,
                false,
            );
        }
    });

    // 3D 续载:相机落定档位接近已载末尾时拉下一页(行进 sentinel)。
    {
        let load_next_page = load_next_page.clone();
        Effect::new(move |_| {
            let flat_now = flat.get();
            let length = items.with(Vec::len) as i64;
            let settled = settled_index.get();
            if flat_now {
                return;
            }
            let Some(settled) = settled else {
                return;
            };
            if settled as i64 >= length - LOAD_MORE_AHEAD {
                load_next_page();
            }
        });
    }

    // flat 续载:尾哨兵进入视口时拉下一页。
    {
        let load_next_page = load_next_page.clone();
        Effect::new(move |_| {
            let flat_now = flat.get();
            let node = tail_sentinel_ref.get();
            let loading = is_loading.get();
            let loading_more = is_loading_more.get();
            let has_more_error = more_error.get().is_some();
            let more = has_more.get();
            if !flat_now || node.is_none() || loading || loading_more || has_more_error || !more {
                return;
            }
            let node = node.unwrap();
            let load_next_page = load_next_page.clone();
            let callback: Closure<
                dyn Fn(Vec<web_sys::IntersectionObserverEntry>, web_sys::IntersectionObserver),
            > = Closure::new(
                move |entries: Vec<web_sys::IntersectionObserverEntry>,
                      _observer: web_sys::IntersectionObserver| {
                    load_next_page();
                    let _ = &entries;
                },
            );
            let options = web_sys::IntersectionObserverInit::new();
            options.set_root_margin("600px 0px");
            match web_sys::IntersectionObserver::new_with_options(
                callback.as_ref().unchecked_ref(),
                &options,
            ) {
                Ok(observer) => {
                    observer.observe(node.unchecked_ref::<web_sys::Element>());
                    std::mem::forget(callback);
                    let observer = send_wrapper::SendWrapper::new(observer);
                    on_cleanup(move || observer.disconnect());
                }
                Err(_) => std::mem::forget(callback),
            }
        });
    }

    // —— 相机装配:flat 时完全不挂输入与 rAF(React enabled 对应物)。
    {
        let camera = camera.clone();
        let fog_targets = fog_targets.clone();
        let focus_index_ref = focus_index_ref.clone();
        Effect::new(move |_| {
            let flat_now = flat.get();
            if flat_now {
                return;
            }
            let Some(stage) = stage_ref.get() else {
                return;
            };
            let focus_index_for_cb = focus_index;
            let focus_index_ref_for_cb = focus_index_ref.clone();
            let settled_index_for_cb = settled_index;
            let runtime = install_camera(
                camera.clone(),
                stage.unchecked_ref::<web_sys::HtmlElement>().clone(),
                corridor_ref,
                fog_targets.clone(),
                move |index| {
                    focus_index_ref_for_cb.store(index as i64, Ordering::Relaxed);
                    focus_index_for_cb.set(index);
                },
                move |index| settled_index_for_cb.set(index),
            );
            let runtime = send_wrapper::SendWrapper::new(runtime);
            on_cleanup(move || drop(runtime));
        });
    }

    // —— flat 降级跟随系统偏好 ——
    Effect::new(move |_| {
        let Some(window) = web_sys::window() else {
            return;
        };
        let Ok(Some(media)) = window.match_media("(prefers-reduced-motion: reduce)") else {
            return;
        };
        let update: Closure<dyn Fn()> = Closure::new(move || {
            flat.set(compute_flat());
        });
        let _ = media.add_event_listener_with_callback("change", update.as_ref().unchecked_ref());
        let update = send_wrapper::SendWrapper::new(update);
        let media = send_wrapper::SendWrapper::new(media);
        on_cleanup(move || {
            let _ = media.remove_event_listener_with_callback(
                "change",
                update.as_ref().unchecked_ref(),
            );
        });
    });

    // 沉浸态上报(flat 时间线不沉浸:页眉恢复常规配色、页脚保留)。
    Effect::new(move |_| {
        let flat_now = flat.get();
        on_immersive_change.run(!flat_now);
    });

    // 进入回廊把焦点移入舞台(focus-on-route-change;preventScroll 防跳动)。
    Effect::new(move |_| {
        let Some(stage) = stage_ref.get() else {
            return;
        };
        let options = web_sys::FocusOptions::new();
        options.set_prevent_scroll(true);
        let _ = stage.focus_with_options(&options);
    });

    // 几何拾取的舞台基准矩形:舞台贴视口顶全出血,位置稳定,仅尺寸随窗口变。
    {
        let stage_rect_ref = stage_rect_ref.clone();
        Effect::new(move |_| {
            let Some(window) = web_sys::window() else {
                return;
            };
            let measure = {
                let stage_rect_ref = stage_rect_ref.clone();
                move || {
                    let Some(stage) = stage_ref.get_untracked() else {
                        return;
                    };
                    let rect = stage
                        .unchecked_ref::<web_sys::Element>()
                        .get_bounding_client_rect();
                    *stage_rect_ref
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()) = StageRect {
                        left: rect.left(),
                        top: rect.top(),
                        width: rect.width(),
                        height: rect.height(),
                    };
                }
            };
            // 挂载后先量一次(effect 在渲染后运行,舞台已就位)。
            measure();
            let measure_for_closure = measure.clone();
            let measure: Closure<dyn Fn()> = Closure::new(move || measure_for_closure());
            let _ = window.add_event_listener_with_callback(
                "resize",
                measure.as_ref().unchecked_ref(),
            );
            let measure = send_wrapper::SendWrapper::new(measure);
            let window = send_wrapper::SendWrapper::new(window);
            on_cleanup(move || {
                let _ = window.remove_event_listener_with_callback(
                    "resize",
                    measure.as_ref().unchecked_ref(),
                );
            });
        });
    }

    // 窄屏覆盖/窗口尺寸变化时刷新几何(vw/svh 依赖窗口实测)。
    {
        let geometry_ref = geometry_ref.clone();
        Effect::new(move |_| {
            let Some(window) = web_sys::window() else {
                return;
            };
            let geometry_ref = geometry_ref.clone();
            let refresh: Closure<dyn Fn()> = Closure::new(move || {
                *geometry_ref.lock().unwrap_or_else(|e| e.into_inner()) =
                    read_space_geometry();
            });
            let _ = window.add_event_listener_with_callback("resize", refresh.as_ref().unchecked_ref());
            let refresh = send_wrapper::SendWrapper::new(refresh);
            let window = send_wrapper::SendWrapper::new(window);
            on_cleanup(move || {
                let _ = window.remove_event_listener_with_callback(
                    "resize",
                    refresh.as_ref().unchecked_ref(),
                );
            });
        });
    }

    let pick_from_pointer = {
        let stage_rect_ref = stage_rect_ref.clone();
        let geometry_ref = geometry_ref.clone();
        let camera = camera.clone();
        move |client_x: f64, client_y: f64| -> Option<usize> {
            let stage_rect = *stage_rect_ref.lock().unwrap_or_else(|e| e.into_inner());
            let geometry = *geometry_ref.lock().unwrap_or_else(|e| e.into_inner());
            let camera_position = camera
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .position;
            let aspects: Vec<(Option<u32>, Option<u32>)> = items
                .get()
                .iter()
                .map(|memory| (memory.width, memory.height))
                .collect();
            pick_pane_at(
                client_x,
                client_y,
                stage_rect,
                camera_position,
                geometry,
                geometry.pane_height * 0.55,
                &aspects,
            )
        }
    };

    // 键盘行进把焦点 pane 飞出窗口时焦点不落到 body:窗口并入焦点锚点。
    let handle_focus_capture = move |event: web_sys::FocusEvent| {
        if let Some(index) = space_index_from_target(event.target()) {
            focused_index_ref.set(index as i64);
        }
    };

    // 交互语义(两段式):点中非焦点 pane = 走到它面前(档案馆隐喻);
    // 点中焦点 pane = 打开查看器。点击必有反馈,永不落空。
    let open_pane_at = {
        let camera = camera.clone();
        let focus_index_ref = focus_index_ref.clone();
        move |index: usize| {
            let Some(memory) = items.get_untracked().get(index).cloned() else {
                return;
            };
            if index as i64 == focus_index_ref.load(Ordering::Relaxed) {
                on_open_viewer.run(memory.id);
            } else {
                camera.go_to_index(index as i64);
            }
        }
    };

    // 年份里程碑:每年首张相片上方挂同墙衬线年号;无拍摄时间的相片不挂。
    let milestone_flags = Memo::new(move |_| {
        let list = items.get();
        let mut flags = vec![false; list.len()];
        let mut last_year: Option<i32> = None;
        let mut seen_year = false;
        for (index, memory) in list.iter().enumerate() {
            let year = parse_year(memory.captured_at.as_deref());
            if let Some(year) = year {
                if !seen_year || Some(year) != last_year {
                    flags[index] = true;
                    seen_year = true;
                    last_year = Some(year);
                }
            }
        }
        flags
    });

    // —— 渲染清单:3D 挂载窗口 = 焦点 ± 缓冲 ∪ 焦点 pane(键盘保有);
    // flat 时间线全量挂载,交给原生 lazy loading 与尾哨兵续载 ——
    let mounted_map: Memo<HashSet<usize>> = Memo::new(move |_| {
        let length = items.with(Vec::len) as i64;
        let mut mounted: HashSet<usize> = HashSet::new();
        if flat.get() {
            for index in 0..length {
                mounted.insert(index as usize);
            }
            return mounted;
        }
        let focus = focus_index.get() as i64;
        let focused = focused_index_ref.get();
        for anchor in [focus, focused].into_iter().filter(|anchor| *anchor >= 0) {
            let from = (anchor - MOUNT_BUFFER).max(0);
            let to = (length - 1).min(anchor + MOUNT_BUFFER);
            if from > to {
                continue;
            }
            for index in from..=to {
                mounted.insert(index as usize);
            }
        }
        mounted
    });
    let index_map: Memo<HashMap<String, usize>> = Memo::new(move |_| {
        items
            .get()
            .iter()
            .enumerate()
            .map(|(index, memory)| (memory.id.clone(), index))
            .collect()
    });

    // 位置播报:视觉跟随焦点档位(即时),屏幕阅读器只在落定后更新。
    let describe_position = move |index: usize| -> String {
        let year = items
            .get()
            .get(index)
            .and_then(|memory| parse_year(memory.captured_at.as_deref()));
        copy::space::POSITION
            .replace(
                "{year}",
                &year.map(|value| value.to_string()).unwrap_or_else(|| "—".to_string()),
            )
            .replace("{index}", &(index + 1).to_string())
            .replace(
                "{total}",
                &(total.get().max(items.with(Vec::len) as u32)).to_string(),
            )
    };

    // 屏幕阅读器落定播报:只在落定后写入 live region。
    Effect::new(move |_| {
        let Some(settled) = settled_index.get() else {
            return;
        };
        if let Some(region) = live_region_ref.get() {
            region.set_text_content(Some(&describe_position(settled)));
        }
    });

    // 480 升档错峰:落定后 120ms 再升档。
    Effect::new(move |_| {
        let settled = settled_index.get();
        let Some(settled) = settled else {
            enhanced_index.set(None);
            return;
        };
        let timer: std::rc::Rc<
            std::cell::RefCell<Option<(Closure<dyn Fn()>, i32)>>,
        > = std::rc::Rc::new(std::cell::RefCell::new(None));
        {
            let enhanced_index = enhanced_index;
            let callback = Closure::new(move || {
                enhanced_index.set(Some(settled));
            });
            *timer.borrow_mut() = web_sys::window().and_then(|window| {
                window
                    .set_timeout_with_callback_and_timeout_and_arguments_0(
                        callback.as_ref().unchecked_ref(),
                        120,
                    )
                    .ok()
                    .map(|handle| (callback, handle))
            });
        }
        let timer = send_wrapper::SendWrapper::new(timer);
        on_cleanup(move || {
            if let Some((_, handle)) = (*timer).borrow_mut().take() {
                if let Some(window) = web_sys::window() {
                    let _ = window.clear_timeout_with_handle(handle);
                }
            }
        });
    });

    // —— 舞台事件(几何拾取语义见 camera.rs / 设计方案 V1.3)——
    let handle_stage_click = {
        let pick_from_pointer = pick_from_pointer.clone();
        let open_pane_at = open_pane_at.clone();
        let camera = camera.clone();
        let focus_index_ref = focus_index_ref.clone();
        move |event: web_sys::MouseEvent| {
            if flat.get_untracked() {
                // flat 时间线整段走 click 两段式(pane 可命中)
                if let Some(index) = space_index_from_target(event.target()) {
                    if index as i64 == focus_index_ref.load(Ordering::Relaxed) {
                        open_pane_at(index);
                    } else {
                        camera.go_to_index(index as i64);
                    }
                }
                return;
            }
            if event.detail() == 0 {
                // 键盘激活 button 的 click 无指针序号(detail === 0):
                // 走到聚焦 pane 面前,若已到位则打开查看器
                if let Some(index) = space_index_from_target(event.target()) {
                    open_pane_at(index);
                }
                return;
            }
            if camera.suppress_pointer_up() {
                return; // 拖拽松手后短暂的 click 不拾取
            }
            let Some(index) =
                pick_from_pointer(event.client_x() as f64, event.client_y() as f64)
            else {
                return;
            };
            if index as i64 == focus_index_ref.load(Ordering::Relaxed) {
                if let Some(memory) = items.get_untracked().get(index).cloned() {
                    on_open_viewer.run(memory.id);
                }
            } else {
                camera.go_to_index(index as i64);
            }
        }
    };
    let handle_stage_key_down = move |event: web_sys::KeyboardEvent| {
        if NAVIGATION_KEYS.contains(&event.key().as_str()) {
            hint_hidden.set(true);
        }
    };
    let handle_stage_pointer_down = move |_: web_sys::PointerEvent| {
        hint_hidden.set(true);
    };
    let handle_stage_pointer_leave = move |_: web_sys::PointerEvent| {
        hovered_index.set(None);
    };
    let handle_stage_pointer_move = {
        let pick_from_pointer = pick_from_pointer.clone();
        move |event: web_sys::PointerEvent| {
            if flat.get_untracked() {
                return;
            }
            let hit = pick_from_pointer(event.client_x() as f64, event.client_y() as f64);
            if hovered_index.get_untracked() != hit {
                hovered_index.set(hit);
            }
        }
    };
    let handle_stage_pointer_up = {
        let pick_from_pointer = pick_from_pointer.clone();
        let camera = camera.clone();
        let focus_index_ref = focus_index_ref.clone();
        move |event: web_sys::PointerEvent| {
            hint_hidden.set(true);
            if flat.get_untracked() {
                return; // flat 时间线整段走 click 两段式(pane 可命中)
            }
            if camera.suppress_pointer_up() {
                return;
            }
            // pointerup 只负责「走」:点非焦点 pane = 相机走向它。
            // 「看」(打开查看器)放到 click 时机——viewer 覆盖层此刻才渲染,
            // 若在 pointerup 打开,紧随的 click 会命中遮罩把查看器秒关。
            let Some(index) =
                pick_from_pointer(event.client_x() as f64, event.client_y() as f64)
            else {
                return;
            };
            if index as i64 != focus_index_ref.load(Ordering::Relaxed) {
                camera.go_to_index(index as i64);
            }
        }
    };
    let handle_stage_wheel = move |_: web_sys::WheelEvent| {
        hint_hidden.set(true);
    };

    // HUD 上一张/下一张(拖拽替代)。
    let step_prev = {
        let camera = camera.clone();
        move |_: web_sys::MouseEvent| camera.step_by(-1)
    };
    let step_next = {
        let camera = camera.clone();
        move |_: web_sys::MouseEvent| camera.step_by(1)
    };

    let prev_disabled = Memo::new(move |_| focus_index.get() == 0);
    let next_disabled = Memo::new(move |_| {
        !has_more.get() && focus_index.get() + 1 >= items.with(Vec::len)
    });
    let position_text = move || describe_position(focus_index.get());
    let retry_load = {
        let load_page = load_page.clone();
        move |_: web_sys::MouseEvent| load_page(1, true)
    };
    let exit_click = move |_: web_sys::MouseEvent| on_exit_space.run(());
    let kind_all_click = move |_: web_sys::MouseEvent| on_kind_change.run(None);
    let kind_photo_click = move |_: web_sys::MouseEvent| on_kind_change.run(Some("photo".to_string()));
    let kind_video_click = move |_: web_sys::MouseEvent| on_kind_change.run(Some("video".to_string()));

    view! {
        <section aria-label={copy::space::STAGE_LABEL} class="space-feature">
            <div
                class="space-stage"
                data-flat={move || flat.get().then(|| "true".to_string())}
                node_ref={stage_ref}
                on:click=handle_stage_click
                on:keydown=handle_stage_key_down
                on:pointerdown=handle_stage_pointer_down
                on:pointerleave=handle_stage_pointer_leave
                on:pointermove=handle_stage_pointer_move
                on:pointerup=handle_stage_pointer_up
                on:wheel=handle_stage_wheel
                tabindex="-1"
            >
                <div class="space-viewport">
                    <div class="space-corridor" node_ref={corridor_ref} on:focusin=handle_focus_capture>
                        <For
                            each={move || items.get()}
                            key={|memory: &MemorySummary| memory.id.clone()}
                            children={move |memory: MemorySummary| {
                                let id = memory.id.clone();
                                let index_signal = Memo::new(move |_| {
                                    index_map.get().get(&id).copied()
                                });
                                let mounted_signal = Memo::new(move |_| {
                                    index_signal
                                        .get()
                                        .map(|index| mounted_map.get().contains(&index))
                                        .unwrap_or(false)
                                });
                                let milestone_signal = Memo::new(move |_| {
                                    index_signal
                                        .get()
                                        .and_then(|index| milestone_flags.get().get(index).copied())
                                        .unwrap_or(false)
                                });
                                let is_right_wall = Memo::new(move |_| {
                                    index_signal.get().map(|index| index % 2 == 1).unwrap_or(false)
                                });
                                let enhanced_signal = Memo::new(move |_| {
                                    index_signal
                                        .get()
                                        .map(|index| {
                                            enhanced_index.get()
                                                .map(|enhanced| {
                                                    (index as i64 - enhanced as i64).abs() <= NEAR_RANGE
                                                })
                                                .unwrap_or(false)
                                        })
                                        .unwrap_or(false)
                                });
                                let hovered_signal = Memo::new(move |_| {
                                    index_signal
                                        .get()
                                        .map(|index| hovered_index.get() == Some(index))
                                        .unwrap_or(false)
                                });
                                let windowed_signal = Memo::new(move |_| !flat.get());
                                let fog_targets = fog_targets.clone();
                                move || {
                                    let index = index_signal.get()?;
                                    if !mounted_signal.get() {
                                        return None;
                                    }
                                    let world_z = -((index + 1) as f64) * geometry_gap;
                                    let milestone = milestone_signal.get();
                                    let is_right_wall_value = is_right_wall.get();
                                    Some(view! {
                                        {milestone.then(|| {
                                            let year = parse_year(memory.captured_at.as_deref());
                                            year.map(|year| {
                                                view! {
                                                    <SpaceMilestone
                                                        fog_targets={fog_targets.clone()}
                                                        is_right_wall={is_right_wall_value}
                                                        world_z={world_z}
                                                        year={year}
                                                    />
                                                }
                                            })
                                        })}
                                        <SpacePane
                                            enhanced={enhanced_signal}
                                            fog_targets={fog_targets.clone()}
                                            hovered={hovered_signal}
                                            index={index}
                                            is_right_wall={is_right_wall_value}
                                            memory={memory.clone()}
                                            windowed={windowed_signal}
                                            world_z={world_z}
                                        />
                                    })
                                }
                            }}
                        />
                        {move || {
                            (flat.get() && has_more.get()).then(|| {
                                view! {
                                    <div aria-hidden="true" class="canvas-sentinel" node_ref={tail_sentinel_ref} />
                                }
                            })
                        }}
                        {move || {
                            (flat.get() && !has_more.get() && !items.get().is_empty()).then(|| {
                                view! {
                                    <p class="space-end-note py-6 text-center">{copy::CANVAS_END}</p>
                                }
                            })
                        }}
                    </div>
                </div>
                {move || {
                    (!flat.get()).then(|| {
                        view! { <div aria-hidden="true" class="space-scrim" /> }
                    })
                }}
                {move || {
                    is_loading.get().then(|| {
                        view! {
                            <p aria-live="polite" class="space-stage-note">{copy::LOADING_LIBRARY}</p>
                        }
                    })
                }}
                {move || {
                    // view! 的属性表达式在 move 上下文求值:先把 Arc 闭包复制成本轮局部
                    let retry_load = retry_load.clone();
                    error.get().map(move |error_message| {
                        view! {
                            <div class="space-empty">
                                <Notice tone={NoticeTone::Error}>
                                    <span>{error_message}</span>
                                    <Button
                                        class="ml-2"
                                        disabled={false}
                                        on_click={Callback::new(retry_load.clone())}
                                        variant={ButtonVariant::Secondary}
                                    >
                                        {copy::LOAD_FAILED_ACTION}
                                    </Button>
                                </Notice>
                            </div>
                        }
                    })
                }}
                {move || {
                    (!is_loading.get() && error.get().is_none() && items.get().is_empty()).then(|| {
                        view! {
                            <div class="space-empty">
                                <EmptyState
                                    action={None}
                                    art={Some(std::sync::Arc::new(move || {
                                        icon_images("size-[42px]").into_any()
                                    }) as ChildrenFn)}
                                >
                                    {copy::space::EMPTY.to_string()}
                                </EmptyState>
                            </div>
                        }
                    })
                }}
                {move || {
                    // view! 的属性表达式在 move 上下文求值:先把闭包复制成本轮局部
                    let step_prev = step_prev.clone();
                    let step_next = step_next.clone();
                    (!flat.get()).then(move || {
                        view! {
                            <p
                                aria-hidden="true"
                                class="space-hint"
                                data-hidden={move || {
                                    if hint_hidden.get() { "true" } else { "false" }.to_string()
                                }}
                            >
                                {copy::space::HINT}
                            </p>
                            <div class="space-hud">
                                <button class="space-hud-exit" on:click=exit_click type="button">
                                    {icon_layout_grid("size-4")}
                                    {copy::space::TOGGLE_ACTIVE}
                                </button>
                                <span aria-hidden="true" class="space-kind-sep" />
                                <button
                                    aria-pressed={move || (!kind.get().is_some()).to_string()}
                                    class="space-kind-btn"
                                    on:click=kind_all_click
                                    type="button"
                                >
                                    {copy::ALL_KINDS}
                                </button>
                                <button
                                    aria-pressed={move || (kind.get().as_deref() == Some("photo")).to_string()}
                                    class="space-kind-btn"
                                    on:click=kind_photo_click
                                    type="button"
                                >
                                    {copy::PHOTO_KIND}
                                </button>
                                <button
                                    aria-pressed={move || (kind.get().as_deref() == Some("video")).to_string()}
                                    class="space-kind-btn"
                                    on:click=kind_video_click
                                    type="button"
                                >
                                    {copy::VIDEO_KIND}
                                </button>
                                <span aria-hidden="true" class="space-kind-sep" />
                                <span aria-hidden="true" class="space-hud-position tnum">
                                    {move || position_text()}
                                </span>
                                <span aria-hidden="true" class="space-kind-sep" />
                                <IconButton
                                    aria_label={copy::space::PREV.to_string()}
                                    disabled={prev_disabled}
                                    on_click={Callback::new(step_prev.clone())}
                                >
                                    {icon_chevron_up("size-5")}
                                </IconButton>
                                <IconButton
                                    aria_label={copy::space::NEXT.to_string()}
                                    disabled={next_disabled}
                                    on_click={Callback::new(step_next.clone())}
                                >
                                    {icon_chevron_down("size-5")}
                                </IconButton>
                            </div>
                            <p aria-live="polite" class="sr-only" node_ref={live_region_ref} />
                        }
                    })
                }}
            </div>
        </section>
    }
}
