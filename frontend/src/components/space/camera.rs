// 时间回廊相机(逐语义对齐 components/space/use-space-camera.ts):
// 单一 rAF 循环驱动的弹簧状态机。输入(滚轮/指针拖拽/键盘)只改写
// target,位置经 spring 追赶;每帧输出 = 走廊根节点 transform 直写 +
// 窗口内元素 opacity 直写(直写避免自定义属性引发的子树样式重算)。
// 铁律:只动 transform/opacity。全部在 wasm 内以 RefCell 状态积分。
use std::cell::RefCell;
use std::rc::Rc;

use leptos::prelude::*;
use send_wrapper::SendWrapper;
use wasm_bindgen::{closure::Closure, JsCast, JsValue};

// —— 相机调参(帧率无关:系数按 dt 归一) ——
/// 滚轮增益:一格 ≈ 半个档位偏多,跟手感优先
pub const WHEEL_FACTOR: f64 = 3.0;
/// 拖拽 1px = 相机 1.15px(上拖为前进)
pub const DRAG_FACTOR: f64 = 1.15;
/// spring 刚度/阻尼:刚度偏高让输入更贴手,阻尼保持临界过冲内
const STIFFNESS: f64 = 0.12;
const DAMPING: f64 = 0.85;
/// 闲置吸附分级:滑行距离超过 0.35 档时改用慢系数优雅归位,
/// 消除「停一下→突然加速」的顿挫感
pub const SNAP_STIFFNESS: f64 = 0.045;
pub const SNAP_DAMPING: f64 = 0.9;
pub const SNAP_SOFT_RATIO: f64 = 0.35;
/// 无输入 300ms 后吸附最近档位
const IDLE_SNAP_DELAY_MS: f64 = 300.0;
/// 松手惯性投影时长(ms)
const INERTIA_LOOKAHEAD_MS: f64 = 180.0;
/// 拖拽起势阈值:低于此距离视为轻点,不捕获指针
const DRAG_THRESHOLD_PX: f64 = 6.0;
/// 拖拽后短暂抑制拾取,避免松手位置的指针事件误命中 pane
const CLICK_SUPPRESS_MS: f64 = 320.0;
/// 滚轮手势方向判定:横向分量占优(触控板左右轻扫)时不参与推进
const WHEEL_HORIZONTAL_RATIO: f64 = 1.0;
/// 雾化曲线:档距 ≤1.5 全清晰,到 5 档衰减至 FOG_MIN
pub const FOG_NEAR: f64 = 1.5;
pub const FOG_FAR: f64 = 5.0;
pub const FOG_MIN: f64 = 0.06;
/// 已掠过相片(相机平面之后)的淡出距离 px
pub const PASS_FADE_PX: f64 = 600.0;
/// 单帧速度上限 px,长距飞行不拖沓且防惯性甩飞
const MAX_VELOCITY: f64 = 130.0;
/// React 基准帧时长(16.667ms)
const FRAME_MS: f64 = 16.667;

/// 回廊几何参数:由 SpaceGallery 从 CSS 令牌读出(@property 注册后的
/// 计算值),相机运动与几何拾取共用同一事实。
#[derive(Clone, Copy, Debug)]
pub struct SpaceCameraGeometry {
    pub gap: f64,
    pub snap_lead: f64,
    pub perspective: f64,
    pub wall_offset: f64,
    pub wall_angle_deg: f64,
    pub pane_width: f64,
    pub pane_height: f64,
}

/// 几何拾取的舞台基准矩形(舞台贴视口顶全出血,仅尺寸随窗口变)。
#[derive(Clone, Copy, Debug, Default)]
pub struct StageRect {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

/// 雾化目标注册表条目:窗口内元素(HtmlElement 直写 opacity)+ 世界坐标
/// Z + 上次写入的雾值(React 版是 WeakMap lastFogValues,合并进同一表,
/// 元素卸载时注销,注册表只含窗口内条目)。按 JS 引用同一性(===)比对。
/// Arc<Mutex> 而非 Rc<RefCell>:注册表要进入 <For> 的 children(Send 约束)。
#[derive(Clone, Debug)]
pub struct FogTarget {
    pub element: web_sys::HtmlElement,
    pub world_z: f64,
    pub last_fog: Option<f64>,
}

pub type FogTargets = std::sync::Arc<std::sync::Mutex<Vec<FogTarget>>>;

/// 加锁(忽略 poisoning:单线程 wasm,poison 仅来自 panic 路径)。
pub fn lock_fog(targets: &FogTargets) -> std::sync::MutexGuard<'_, Vec<FogTarget>> {
    targets.lock().unwrap_or_else(|error| error.into_inner())
}

/// 几何量与 CSS 令牌单一事实:全部从令牌读出(@property 注册后 computed
/// 为解析后的像素值,含窄屏覆盖),吸附前导量按比例推导。
pub fn read_space_geometry() -> SpaceCameraGeometry {
    // 令牌名字面量按门禁口径只能出现在 index.css;运行时只做读取,名称在此拼装
    let token = |suffix: &str, fallback: f64| -> f64 {
        let raw = web_sys::window().and_then(|window| {
            window
                .document()
                .and_then(|document| document.document_element())
                .and_then(|root| window.get_computed_style(&root).ok().flatten())
                .and_then(|style| {
                    style
                        .get_property_value(&format!("--limedia-space-{}", suffix))
                        .ok()
                })
        });
        let raw = raw.unwrap_or_default();
        let parsed = parse_leading_f64(&raw).unwrap_or(0.0);
        if parsed.is_finite() && parsed > 0.0 {
            parsed
        } else {
            fallback
        }
    };
    let gap = token("pane-gap", 460.0);
    SpaceCameraGeometry {
        gap,
        snap_lead: (gap * 0.42).round(),
        perspective: token("perspective", 1100.0),
        wall_offset: token("wall-offset", 420.0),
        wall_angle_deg: token("wall-angle", 18.0),
        pane_width: token("pane-w", 500.0),
        pane_height: token("pane-h", 680.0),
    }
}

/// Number.parseFloat 对应物:解析字符串前导数值("380px" → 380)。
fn parse_leading_f64(raw: &str) -> Option<f64> {
    let trimmed = raw.trim();
    let end = trimmed
        .char_indices()
        .find(|(index, ch)| match ch {
            '0'..='9' | '.' => false,
            '+' | '-' => *index != 0,
            _ => true,
        })
        .map(|(index, _)| index)
        .unwrap_or(trimmed.len());
    if end == 0 {
        return None;
    }
    trimmed[..end].parse::<f64>().ok()
}

/// CSS.supports(property, value) 对应物(web-sys 无 CSS 接口,走 Reflect)。
pub fn css_supports(property: &str, value: &str) -> bool {
    let Some(window) = web_sys::window() else {
        return false;
    };
    let css = js_sys::Reflect::get(window.as_ref(), &"CSS".into()).ok();
    let supports = css.as_ref().and_then(|css| {
        js_sys::Reflect::get(css, &"supports".into())
            .ok()
            .and_then(|function| function.dyn_into::<js_sys::Function>().ok())
    });
    let Some((css_object, supports)) = css.zip(supports) else {
        return false;
    };
    supports
        .call2(&css_object, &property.into(), &value.into())
        .ok()
        .and_then(|result| result.as_bool())
        .unwrap_or(false)
}

/// flat 降级:reduced-motion 或环境不支持 CSS 3D 时展开为纵向时间线。
pub fn compute_flat() -> bool {
    let reduced_motion = web_sys::window()
        .and_then(|window| {
            window
                .match_media("(prefers-reduced-motion: reduce)")
                .ok()
                .flatten()
        })
        .map(|query| query.matches())
        .unwrap_or(false);
    reduced_motion
        || !css_supports("transform-style", "preserve-3d")
        || !css_supports("perspective", "1px")
}

/// new Date(capturedAt).getFullYear() 对应物(JS Date 同源解析)。
pub fn parse_year(captured_at: Option<&str>) -> Option<i32> {
    let value = captured_at?;
    let date = js_sys::Date::new(&JsValue::from_str(value));
    if date.get_time().is_nan() {
        return None;
    }
    Some(date.get_full_year() as i32)
}

fn performance_now() -> f64 {
    web_sys::window()
        .and_then(|window| window.performance())
        .map(|performance| performance.now())
        .unwrap_or(0.0)
}

#[derive(Debug, Default)]
pub struct CameraState {
    pub position: f64,
    pub velocity: f64,
    pub target: f64,
    pub initialized: bool,
    pub dragging: bool,
    pub drag_pointer_id: i32,
    pub drag_start_y: f64,
    pub drag_start_x: f64,
    pub drag_distance: f64,
    pub drag_start_position: f64,
    /// (timeStamp, position) 采样窗口(120ms)
    pub drag_samples: Vec<(f64, f64)>,
    pub last_input_at: f64,
    pub drag_end_at: f64,
    pub last_emitted_index: i64,
    pub settled_emitted: bool,
    pub frame_handle: i32,
    pub running: bool,
    pub last_frame_time: f64,
}

/// 相机句柄:goToIndex / stepBy / suppressPointerUp 与 React 版同签名语义。
/// Arc<Mutex>/Atomic 而非 Rc<RefCell>:相机要进入 view! 的动态视图闭包与
/// HUD 回调(Send+Sync 约束),与 React 的共享可变 ref 同构。
#[derive(Clone)]
pub struct SpaceCamera {
    pub state: std::sync::Arc<std::sync::Mutex<CameraState>>,
    pub geometry: std::sync::Arc<std::sync::Mutex<SpaceCameraGeometry>>,
    pub count: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

fn lock_state(
    camera: &SpaceCamera,
) -> std::sync::MutexGuard<'_, CameraState> {
    camera
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

fn lock_geometry(
    camera: &SpaceCamera,
) -> std::sync::MutexGuard<'_, SpaceCameraGeometry> {
    camera
        .geometry
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

impl SpaceCamera {
    pub fn new(
        geometry: std::sync::Arc<std::sync::Mutex<SpaceCameraGeometry>>,
        count: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    ) -> Self {
        Self {
            state: std::sync::Arc::new(std::sync::Mutex::new(CameraState {
                drag_pointer_id: -1,
                last_emitted_index: -1,
                ..CameraState::default()
            })),
            geometry,
            count,
        }
    }

    fn clamp_position(&self, position: f64) -> f64 {
        let geometry = *lock_geometry(self);
        let min = geometry.gap - geometry.snap_lead;
        let max = (self
            .count
            .load(std::sync::atomic::Ordering::Relaxed) as f64
            * geometry.gap
            - geometry.snap_lead)
            .max(min);
        position.clamp(min, max)
    }

    fn snap_of_index(&self, index: i64) -> f64 {
        let geometry = *lock_geometry(self);
        let count = self.count.load(std::sync::atomic::Ordering::Relaxed) as i64;
        let clamped = index.clamp(0, (count - 1).max(0));
        (clamped + 1) as f64 * geometry.gap - geometry.snap_lead
    }

    fn index_of_position(&self, position: f64) -> usize {
        let geometry = *lock_geometry(self);
        let count = self.count.load(std::sync::atomic::Ordering::Relaxed);
        if count == 0 {
            return 0;
        }
        let raw = ((position + geometry.snap_lead) / geometry.gap).round() as i64 - 1;
        raw.clamp(0, count as i64 - 1) as usize
    }

    pub fn go_to_index(&self, index: i64) {
        let mut state = lock_state(self);
        state.target = self.clamp_position(self.snap_of_index(index));
        state.last_input_at = performance_now();
    }

    pub fn step_by(&self, steps: i32) {
        let index = self.index_of_position(lock_state(self).target) as i64;
        self.go_to_index(index + steps as i64);
    }

    /// 拖拽后的 pointerup 会被指针捕获重定向到舞台,几何拾取会按松手位置
    /// 命中 pane——短暂抑制,防止拖拽松手误触。
    pub fn suppress_pointer_up(&self) -> bool {
        let state = lock_state(self);
        state.drag_distance > DRAG_THRESHOLD_PX
            && performance_now() - state.drag_end_at < CLICK_SUPPRESS_MS
    }
}

/// 已装配的相机运行时:Drop 时移除全部监听并停帧(React effect cleanup)。
pub struct CameraRuntime {
    stage: web_sys::HtmlElement,
    document: web_sys::Document,
    camera_state: std::sync::Arc<std::sync::Mutex<CameraState>>,
    #[allow(dead_code)]
    frame_slot: Rc<RefCell<Option<Closure<dyn Fn(f64)>>>>,
    on_wheel: SendWrapper<Closure<dyn Fn(web_sys::WheelEvent)>>,
    on_pointer_down: SendWrapper<Closure<dyn Fn(web_sys::PointerEvent)>>,
    on_pointer_move: SendWrapper<Closure<dyn Fn(web_sys::PointerEvent)>>,
    on_pointer_up_or_cancel: SendWrapper<Closure<dyn Fn(web_sys::PointerEvent)>>,
    on_key_down: SendWrapper<Closure<dyn Fn(web_sys::KeyboardEvent)>>,
    on_visibility_change: SendWrapper<Closure<dyn Fn()>>,
}

impl Drop for CameraRuntime {
    fn drop(&mut self) {
        {
            let mut state = self
                .camera_state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            state.running = false;
            if state.frame_handle != 0 {
                if let Some(window) = web_sys::window() {
                    let _ = window.cancel_animation_frame(state.frame_handle);
                }
                state.frame_handle = 0;
            }
        }
        let stage_target: &web_sys::EventTarget = self.stage.as_ref();
        let _ = stage_target.remove_event_listener_with_callback(
            "wheel",
            self.on_wheel.as_ref().unchecked_ref(),
        );
        let _ = stage_target.remove_event_listener_with_callback(
            "pointerdown",
            self.on_pointer_down.as_ref().unchecked_ref(),
        );
        let _ = stage_target.remove_event_listener_with_callback(
            "pointermove",
            self.on_pointer_move.as_ref().unchecked_ref(),
        );
        let _ = stage_target.remove_event_listener_with_callback(
            "pointerup",
            self.on_pointer_up_or_cancel.as_ref().unchecked_ref(),
        );
        let _ = stage_target.remove_event_listener_with_callback(
            "pointercancel",
            self.on_pointer_up_or_cancel.as_ref().unchecked_ref(),
        );
        let _ = stage_target.remove_event_listener_with_callback(
            "keydown",
            self.on_key_down.as_ref().unchecked_ref(),
        );
        let _ = self.document.remove_event_listener_with_callback(
            "visibilitychange",
            self.on_visibility_change.as_ref().unchecked_ref(),
        );
    }
}

fn start_loop(camera: &SpaceCamera, frame_slot: &Rc<RefCell<Option<Closure<dyn Fn(f64)>>>>) {
    let mut state = lock_state(camera);
    if state.running {
        return;
    }
    state.running = true;
    state.last_frame_time = 0.0;
    if let Some(window) = web_sys::window() {
        if let Some(frame) = frame_slot.borrow().as_ref() {
            state.frame_handle = window
                .request_animation_frame(frame.as_ref().unchecked_ref())
                .unwrap_or(0);
        }
    }
}

fn stop_loop(camera: &SpaceCamera) {
    let mut state = lock_state(camera);
    state.running = false;
    if state.frame_handle != 0 {
        if let Some(window) = web_sys::window() {
            let _ = window.cancel_animation_frame(state.frame_handle);
        }
        state.frame_handle = 0;
    }
}

/// 装配相机:绑定 wheel/pointer/keyboard 输入与 rAF 循环。
/// enabled=false(flat 降级)由调用方保证不调用本函数。
pub fn install_camera(
    camera: SpaceCamera,
    stage: web_sys::HtmlElement,
    corridor_ref: NodeRef<leptos::html::Div>,
    fog_targets: FogTargets,
    on_index_change: impl Fn(usize) + 'static,
    on_settled: impl Fn(Option<usize>) + 'static,
) -> CameraRuntime {
    let document = web_sys::window()
        .and_then(|window| window.document())
        .expect("document unavailable");
    let frame_slot: Rc<RefCell<Option<Closure<dyn Fn(f64)>>>> = Rc::new(RefCell::new(None));

    // —— 输入监听(闭包只改写 target / 相机状态) ——

    // 滚轮 passive 监听、不 preventDefault:沉浸模式页面本身无滚动
    // (页脚隐藏 + page-shell 零底 padding),无需担心链式滚动。
    // 横向分量占优的手势(触控板左右轻扫)不参与推进——回廊只有前后。
    let on_wheel = {
        let camera = camera.clone();
        Closure::new(move |event: web_sys::WheelEvent| {
            if event.delta_x().abs() > event.delta_y().abs() * WHEEL_HORIZONTAL_RATIO {
                return;
            }
            let mut state = lock_state(&camera);
            state.target = camera.clamp_position(state.target + event.delta_y() * WHEEL_FACTOR);
            state.last_input_at = event.time_stamp();
        })
    };

    let on_pointer_down = {
        let camera = camera.clone();
        Closure::new(move |event: web_sys::PointerEvent| {
            if !event.is_primary() {
                return;
            }
            let mut state = lock_state(&camera);
            state.drag_pointer_id = event.pointer_id();
            state.drag_start_y = event.client_y() as f64;
            state.drag_start_x = event.client_x() as f64;
            state.drag_distance = 0.0;
            state.drag_start_position = state.position;
            state.drag_samples = vec![(event.time_stamp(), state.position)];
            state.velocity = 0.0;
            // 行进中按下即冻结相机:滑动中点小图先停帧再命中,指哪停哪;
            // 若随后拖拽越阈值,相机从冻结位置继续跟手
            state.target = state.position;
            state.last_input_at = event.time_stamp();
        })
    };

    let on_pointer_move = {
        let camera = camera.clone();
        let stage_for_capture = stage.clone();
        Closure::new(move |event: web_sys::PointerEvent| {
            let drag_pointer_id = lock_state(&camera).drag_pointer_id;
            if drag_pointer_id != event.pointer_id() {
                return;
            }
            let distance = {
                let state = lock_state(&camera);
                let dx = event.client_x() as f64 - state.drag_start_x;
                let dy = event.client_y() as f64 - state.drag_start_y;
                (dx * dx + dy * dy).sqrt()
            };
            if !lock_state(&camera).dragging {
                if distance < DRAG_THRESHOLD_PX {
                    return;
                }
                lock_state(&camera).dragging = true;
                // 捕获推迟到跟手起势(沿用 ecc240b 的修复口径):轻点不受捕获
                // 影响,起势后 click 被重定向到舞台,pane 误触自然被抑制。
                // 指针可能已失效(如触摸被系统手势接管),拖拽照常进行。
                let _ = stage_for_capture.set_pointer_capture(event.pointer_id());
            }
            let mut state = lock_state(&camera);
            state.drag_distance = distance;
            let dy = state.drag_start_y - event.client_y() as f64;
            let next_position =
                camera.clamp_position(state.drag_start_position + dy * DRAG_FACTOR);
            state.position = next_position;
            let sample_position = state.position;
            state.drag_samples.push((event.time_stamp(), sample_position));
            while state.drag_samples.len() > 2
                && event.time_stamp() - state.drag_samples[0].0 > 120.0
            {
                state.drag_samples.remove(0);
            }
            state.last_input_at = event.time_stamp();
        })
    };

    let on_pointer_up_or_cancel = {
        let camera = camera.clone();
        let stage_for_release = stage.clone();
        Closure::new(move |event: web_sys::PointerEvent| {
            {
                let mut state = lock_state(&camera);
                if state.drag_pointer_id != event.pointer_id() {
                    return;
                }
                if !state.dragging {
                    state.drag_pointer_id = -1;
                    return;
                }
                state.drag_pointer_id = -1;
                state.dragging = false;
                state.drag_end_at = performance_now();
            }
            // 捕获可能已随 pointercancel 释放
            let _ = stage_for_release.release_pointer_capture(event.pointer_id());
            // 惯性投影 → 吸附最近档位
            let mut state = lock_state(&camera);
            let samples = state.drag_samples.clone();
            let mut velocity_per_frame = 0.0;
            if samples.len() >= 2 {
                let first = samples[0];
                let last = samples[samples.len() - 1];
                let elapsed = last.0 - first.0;
                if elapsed > 16.0 {
                    velocity_per_frame = ((last.1 - first.1) / elapsed) * FRAME_MS;
                }
            }
            state.velocity = velocity_per_frame.clamp(-MAX_VELOCITY, MAX_VELOCITY);
            let projected = state.position + state.velocity * (INERTIA_LOOKAHEAD_MS / FRAME_MS);
            state.target = camera.snap_of_index(camera.index_of_position(projected) as i64);
            state.last_input_at = performance_now();
        })
    };

    let on_key_down = {
        let camera = camera.clone();
        Closure::new(move |event: web_sys::KeyboardEvent| {
            let skip_input = event
                .target()
                .and_then(|target| target.dyn_into::<web_sys::HtmlElement>().ok())
                .map(|element| {
                    let tag = element.tag_name();
                    tag == "INPUT" || tag == "TEXTAREA" || element.is_content_editable()
                })
                .unwrap_or(false);
            if skip_input {
                return;
            }
            match event.key().as_str() {
                "ArrowDown" => {
                    event.prevent_default();
                    let index = camera.index_of_position(lock_state(&camera).target) as i64;
                    camera.go_to_index(index + 1);
                }
                "ArrowUp" => {
                    event.prevent_default();
                    let index = camera.index_of_position(lock_state(&camera).target) as i64;
                    camera.go_to_index(index - 1);
                }
                "PageDown" => {
                    event.prevent_default();
                    let index = camera.index_of_position(lock_state(&camera).target) as i64;
                    camera.go_to_index(index + 3);
                }
                "PageUp" => {
                    event.prevent_default();
                    let index = camera.index_of_position(lock_state(&camera).target) as i64;
                    camera.go_to_index(index - 3);
                }
                "Home" => {
                    event.prevent_default();
                    camera.go_to_index(0);
                }
                "End" => {
                    event.prevent_default();
                    let count =
                        camera.count.load(std::sync::atomic::Ordering::Relaxed) as i64;
                    camera.go_to_index(count - 1);
                }
                _ => {}
            }
        })
    };

    let on_visibility_change = {
        let document_for_closure = document.clone();
        let camera = camera.clone();
        let frame_slot_for_visibility = frame_slot.clone();
        Closure::new(move || {
            if document_for_closure.visibility_state() == web_sys::VisibilityState::Visible {
                start_loop(&camera, &frame_slot_for_visibility);
            } else {
                stop_loop(&camera);
            }
        })
    };

    // —— rAF 帧循环 ——
    {
        let camera = camera.clone();
        let frame = {
            let frame_slot = frame_slot.clone();
            Closure::new(move |time: f64| {
                frame_tick(&camera, time, corridor_ref, &fog_targets, &on_index_change, &on_settled);
                let running = lock_state(&camera).running;
                if running {
                    if let Some(window) = web_sys::window() {
                        let self_ref = frame_slot.borrow();
                        if let Some(self_closure) = self_ref.as_ref() {
                            let handle = window
                                .request_animation_frame(self_closure.as_ref().unchecked_ref())
                                .unwrap_or(0);
                            lock_state(&camera).frame_handle = handle;
                        }
                    }
                }
            })
        };
        *frame_slot.borrow_mut() = Some(frame);
    }

    let stage_target: &web_sys::EventTarget = stage.as_ref();
    let mut wheel_options = web_sys::AddEventListenerOptions::new();
    wheel_options.passive(true);
    let _ = stage_target.add_event_listener_with_callback_and_add_event_listener_options(
        "wheel",
        on_wheel.as_ref().unchecked_ref(),
        &wheel_options,
    );
    let _ = stage_target.add_event_listener_with_callback(
        "pointerdown",
        on_pointer_down.as_ref().unchecked_ref(),
    );
    let _ = stage_target.add_event_listener_with_callback(
        "pointermove",
        on_pointer_move.as_ref().unchecked_ref(),
    );
    let _ = stage_target.add_event_listener_with_callback(
        "pointerup",
        on_pointer_up_or_cancel.as_ref().unchecked_ref(),
    );
    let _ = stage_target.add_event_listener_with_callback(
        "pointercancel",
        on_pointer_up_or_cancel.as_ref().unchecked_ref(),
    );
    let _ = stage_target.add_event_listener_with_callback(
        "keydown",
        on_key_down.as_ref().unchecked_ref(),
    );
    let _ = document.add_event_listener_with_callback(
        "visibilitychange",
        on_visibility_change.as_ref().unchecked_ref(),
    );

    start_loop(&camera, &frame_slot);

    CameraRuntime {
        stage,
        document,
        camera_state: camera.state.clone(),
        frame_slot,
        on_wheel: send_wrapper::SendWrapper::new(on_wheel),
        on_pointer_down: send_wrapper::SendWrapper::new(on_pointer_down),
        on_pointer_move: send_wrapper::SendWrapper::new(on_pointer_move),
        on_pointer_up_or_cancel: send_wrapper::SendWrapper::new(on_pointer_up_or_cancel),
        on_key_down: send_wrapper::SendWrapper::new(on_key_down),
        on_visibility_change: send_wrapper::SendWrapper::new(on_visibility_change),
    }
}

/// 单帧物理与输出:弹簧积分 → 走廊 transform 直写 → 雾化 opacity 直写 →
/// 焦点档位/落定回调。只动 transform/opacity。
fn frame_tick(
    camera: &SpaceCamera,
    time: f64,
    corridor_ref: NodeRef<leptos::html::Div>,
    fog_targets: &FogTargets,
    on_index_change: &impl Fn(usize),
    on_settled: &impl Fn(Option<usize>),
) {
    let geometry = *lock_geometry(camera);
    let gap = geometry.gap;
    let mut emit_index: Option<usize> = None;
    let mut emit_settled: Option<Option<usize>> = None;

    {
        let mut state = lock_state(camera);
        let step = ((time
            - if state.last_frame_time == 0.0 {
                time
            } else {
                state.last_frame_time
            })
        .min(50.0))
            / FRAME_MS;
        state.last_frame_time = time;

        if !state.initialized {
            // 初始站在「今天」:最新一张已落在焦点档位
            let initial_target = camera.clamp_position(camera.snap_of_index(0));
            state.target = initial_target;
            state.position = initial_target;
            state.initialized = true;
        }
        let clamped_target = camera.clamp_position(state.target);
        state.target = clamped_target;

        if !state.dragging {
            // 指针按住期间不闲置吸附:冻结帧不能在瞄准时被悄悄挪走
            let idle = state.drag_pointer_id == -1
                && time - state.last_input_at > IDLE_SNAP_DELAY_MS
                && state.velocity.abs() < 0.05;
            if idle {
                let snap_target =
                    camera.snap_of_index(camera.index_of_position(state.target) as i64);
                state.target = snap_target;
            }
            // 吸附分级:闲置归位且滑行距离远时放慢弹簧——顺滑远滑入,
            // 近距与跟手输入保持正常刚度
            let soft = idle && (state.target - state.position).abs() > gap * SNAP_SOFT_RATIO;
            state.velocity += (state.target - state.position)
                * if soft { SNAP_STIFFNESS } else { STIFFNESS }
                * step;
            state.velocity *= (if soft { SNAP_DAMPING } else { DAMPING }).powf(step);
            state.velocity = state.velocity.clamp(-MAX_VELOCITY, MAX_VELOCITY);
            state.position += state.velocity * step;
            if (state.target - state.position).abs() < 0.12 && state.velocity.abs() < 0.12 {
                state.position = state.target;
                state.velocity = 0.0;
            }
        }

        // 相机 transform 直写:写自定义属性会触发走廊整棵子树的样式重算,
        // 直写 transform 只更新自身合成层——每帧丝滑度的关键路径。
        // 只沿 Z 轴推进,无左右摆动
        if let Some(corridor) = corridor_ref.get() {
            let corridor: web_sys::HtmlElement = corridor
                .unchecked_ref::<web_sys::HtmlElement>()
                .clone();
            let _ = web_sys::HtmlElement::style(&corridor).set_property(
                "transform",
                &format!("translateZ({:.2}px)", state.position),
            );
        }

        // 雾化:每帧仅对窗口内元素按距离写 opacity;0.02 阈值去抖,
        // 变化小于阈值不再写值(静止停帧),浏览器可停止合成。
        {
            let mut targets = lock_fog(fog_targets);
            for target in targets.iter_mut() {
                let effective_z = target.world_z + state.position;
                let fog = if effective_z <= 0.0 {
                    let bays = -effective_z / gap;
                    if bays <= FOG_NEAR {
                        1.0
                    } else {
                        (1.0 - (bays - FOG_NEAR) / (FOG_FAR - FOG_NEAR)).max(FOG_MIN)
                    }
                } else {
                    (1.0 - effective_z / PASS_FADE_PX).max(FOG_MIN)
                };
                let should_write = match target.last_fog {
                    None => true,
                    Some(previous) => (previous - fog).abs() > 0.02,
                };
                if should_write {
                    target.last_fog = Some(fog);
                    let _ = web_sys::HtmlElement::style(&target.element).set_property(
                        "opacity",
                        &format!("{:.3}", fog),
                    );
                }
            }
        }

        let index = camera.index_of_position(state.position);
        if index as i64 != state.last_emitted_index {
            state.last_emitted_index = index as i64;
            emit_index = Some(index);
        }
        let settled = !state.dragging && state.position == state.target && state.velocity == 0.0;
        if settled != state.settled_emitted {
            state.settled_emitted = settled;
            emit_settled = Some(settled.then_some(index));
        }
    }

    // 回调在释放 state 借用之后触发:回调可能重入信号系统。
    if let Some(index) = emit_index {
        on_index_change(index);
    }
    if let Some(settled) = emit_settled {
        on_settled(settled);
    }
}

/// 几何拾取:把指针屏幕坐标逆投影到每个 pane 的倾斜平面上,返回命中的
/// pane 档位(最近者优先)——绕开 preserve-3d 场景里 DOM hit-test 的
/// 全部怪癖(pointer-events 祖先剪枝、clip-path 失效等),纯数学判定。
pub fn pick_pane_at(
    client_x: f64,
    client_y: f64,
    stage_rect: StageRect,
    camera_position: f64,
    geometry: SpaceCameraGeometry,
    pane_height_min: f64,
    aspects: &[(Option<u32>, Option<u32>)],
) -> Option<usize> {
    let d = geometry.perspective;
    let origin_x = stage_rect.width / 2.0;
    let origin_y = stage_rect.height * 0.42;
    let px = client_x - stage_rect.left - origin_x;
    let py = client_y - stage_rect.top - origin_y;
    // 走廊原点(top 50%)相对透视原点(42%)的垂直偏移:pane 摆放的世界
    // y 中心不是 0,而是在 origin 下方这段距离——命中判定必须扣除
    let center_y = stage_rect.height * 0.08;
    let rad = geometry.wall_angle_deg * core::f64::consts::PI / 180.0;
    let cos_t = rad.cos();
    let sin_t = rad.sin();
    for index in 0..aspects.len() {
        let (width, height) = aspects[index];
        let zc = -((index + 1) as f64) * geometry.gap + camera_position;
        if zc >= 0.0 {
            continue; // 已掠过:相机平面之后(视觉飞出/淡出),不参与拾取
        }
        let aspect = match (width, height) {
            (Some(width), Some(height)) if width > 0 && height > 0 => {
                width as f64 / height as f64
            }
            _ => 1.5,
        };
        let pane_width = geometry.pane_width;
        let pane_height = geometry
            .pane_height
            .min((geometry.pane_width / aspect).max(pane_height_min));
        let side = if index % 2 == 0 { -1.0 } else { 1.0 };
        let xc = side * geometry.wall_offset;
        // 射线 O=(0,0,d) → S=(px,py,0) 与 pane 平面(过 C=(xc,centerY,zc)、
        // 方向 (cosT,0,sinT))求交:u = pane 局部水平坐标,v = 局部垂直坐标
        let denom = cos_t + (px * sin_t) / d;
        if denom.abs() < 1e-6 {
            continue;
        }
        let u = ((px * (d - zc)) / d - xc) / denom;
        let v = (py * (d - zc - u * sin_t)) / d - center_y;
        if u.abs() <= pane_width / 2.0 && v.abs() <= pane_height / 2.0 {
            return Some(index); // 从最近到最远,第一个命中的即所见 pane
        }
    }
    None
}
