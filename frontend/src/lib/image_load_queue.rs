// 全局并发 2 的图片加载限流队列(逐语义对齐 lib/image-load-queue.ts)。
// closure 队列 + img 事件驱动,不引外部库:高优先级任务(查看器)优先
// 占用两个槽位;suspendAll 把排队与运行中的任务全部挂起,查看器自己的
// 任务(挂起期间入队)豁免并立即启动;失败按 500ms 指数退避重试。
use std::cell::{Cell, RefCell};
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};

use wasm_bindgen::{closure::Closure, JsCast};

/// 全局并发上限(对齐 MAX_ACTIVE_IMAGE_LOADS)。
pub const MAX_ACTIVE_IMAGE_LOADS: usize = 2;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ImageLoadPriority {
    #[default]
    Normal,
    High,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageLoadError {
    /// 对齐 AbortError(name === "AbortError"):调用方据此静默吞掉。
    Aborted,
    Failed,
}

impl std::fmt::Display for ImageLoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImageLoadError::Aborted => f.write_str("Image load aborted"),
            ImageLoadError::Failed => f.write_str("Image load failed"),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ImageLoadOptions {
    pub retries: u32,
    pub priority: ImageLoadPriority,
}

/// 队列任务间共享的结算槽:future poll 与事件回调在此交接结果与 waker。
struct TaskShared {
    result: RefCell<Option<Result<web_sys::HtmlImageElement, ImageLoadError>>>,
    waker: RefCell<Option<Waker>>,
}

impl TaskShared {
    fn new() -> Rc<Self> {
        Rc::new(Self {
            result: RefCell::new(None),
            waker: RefCell::new(None),
        })
    }

    fn settle(&self, result: Result<web_sys::HtmlImageElement, ImageLoadError>) {
        *self.result.borrow_mut() = Some(result);
        if let Some(waker) = self.waker.borrow_mut().take() {
            waker.wake();
        }
    }
}

struct QueueTask {
    src: String,
    priority: ImageLoadPriority,
    retries: u32,
    attempt: u32,
    sequence: u64,
    image: web_sys::HtmlImageElement,
    /// 挂起期间入队的任务(查看器自己的加载)不受挂起影响。
    exempt_from_suspension: bool,
    settled: Cell<bool>,
    aborted: Cell<bool>,
    active: Cell<bool>,
    retry_timer_id: Cell<Option<i32>>,
    retry_timer_closure: RefCell<Option<Closure<dyn Fn()>>>,
    load_closures: RefCell<Option<(Closure<dyn Fn()>, Closure<dyn Fn()>)>>,
    shared: Rc<TaskShared>,
}

type TaskRef = Rc<RefCell<QueueTask>>;

#[derive(Default)]
struct QueueInner {
    active_count: usize,
    sequence: u64,
    tasks: Vec<TaskRef>,
    active: Vec<TaskRef>,
    suspended: bool,
}

thread_local! {
    static QUEUE: Rc<RefCell<QueueInner>> = Rc::new(RefCell::new(QueueInner::default()));
}

fn window() -> Option<web_sys::Window> {
    web_sys::window()
}

fn create_async_image() -> Option<web_sys::HtmlImageElement> {
    let document = window()?.document()?;
    let element = document.create_element("img").ok()?;
    let _ = element.set_attribute("decoding", "async");
    element.dyn_into::<web_sys::HtmlImageElement>().ok()
}

/// 对齐 retryDelayMs:min(4000, 500 * 2^(attempt-1)),attempt 从 1 起。
fn retry_delay_ms(attempt: u32) -> i32 {
    let exponent = attempt.saturating_sub(1) as f64;
    let delay = 500.0 * 2f64.powf(exponent);
    delay.min(4000.0) as i32
}

fn rank_of(priority: ImageLoadPriority, sequence: u64) -> u64 {
    // 对齐 rank:high=0 / normal=1 前缀 + 全局序号;2^53-1 与 JS 的
    // Number.MAX_SAFE_INTEGER 同口径,序号在页生命周期内远小于该值。
    const MAX_SAFE_INTEGER: u64 = (1u64 << 53) - 1;
    let priority_rank = if priority == ImageLoadPriority::High { 0u64 } else { 1 };
    priority_rank * MAX_SAFE_INTEGER + sequence
}

fn detach_load_handlers(task: &TaskRef) {
    let taken = task.borrow().load_closures.borrow_mut().take();
    if taken.is_some() {
        let task = task.borrow();
        let _ = task.image.set_onload(None);
        let _ = task.image.set_onerror(None);
    }
    if let Some((onload, onerror)) = taken {
        drop(onload);
        drop(onerror);
    }
}

fn clear_retry_timer(task: &TaskRef) {
    let timer_id = task.borrow().retry_timer_id.replace(None);
    if let Some(timer_id) = timer_id {
        if let Some(window) = window() {
            let _ = window.clear_timeout_with_handle(timer_id);
        }
    }
    let closure = task.borrow().retry_timer_closure.borrow_mut().take();
    drop(closure);
}

fn finish_active(inner: &mut QueueInner, task: &TaskRef) {
    if task.borrow().active.get() {
        task.borrow_mut().active.set(false);
        inner.active_count = inner.active_count.saturating_sub(1);
        inner
            .active
            .retain(|candidate| !Rc::ptr_eq(candidate, task));
    }
}

fn start_task(task: &TaskRef) {
    let onload: Closure<dyn Fn()> = {
        let task = task.clone();
        Closure::new(move || {
            QUEUE.with(|queue| {
                let mut inner = queue.borrow_mut();
                on_load(&mut inner, &task);
            });
        })
    };
    let onerror: Closure<dyn Fn()> = {
        let task = task.clone();
        Closure::new(move || {
            QUEUE.with(|queue| {
                let mut inner = queue.borrow_mut();
                on_error(&mut inner, &task);
            });
        })
    };
    {
        let mut task = task.borrow_mut();
        let _ = task.image.set_onload(Some(onload.as_ref().unchecked_ref()));
        let _ = task
            .image
            .set_onerror(Some(onerror.as_ref().unchecked_ref()));
        *task.load_closures.borrow_mut() = Some((onload, onerror));
    }
    let src = task.borrow().src.clone();
    task.borrow().image.set_src(&src);
}

/// 对齐 complete:已结算直接返回;结算、释放槽位、resolve、拉起下一个。
fn on_load(inner: &mut QueueInner, task: &TaskRef) {
    if task.borrow().settled.get() {
        return;
    }
    detach_load_handlers(task);
    finish_active(inner, task);
    task.borrow_mut().settled.set(true);
    let image = task.borrow().image.clone();
    task.borrow().shared.settle(Ok(image));
    start_next(inner);
}

/// 对齐 fail:先释放槽位;仍有重试预算且未中止时按退避延时重新入队,
/// 否则进入终态失败(reject)。
fn on_error(inner: &mut QueueInner, task: &TaskRef) {
    if task.borrow().settled.get() {
        return;
    }
    finish_active(inner, task);

    let (should_retry, delay) = {
        let mut task = task.borrow_mut();
        let should_retry = task.attempt < task.retries && !task.aborted.get();
        if should_retry {
            task.attempt += 1;
            (true, retry_delay_ms(task.attempt))
        } else {
            (false, 0)
        }
    };

    if should_retry {
        // 先摘掉处理器再清空 src:空 src 会解析为当前文档 URL,
        // 仍挂着的 onerror 会重入 fail(),重复占用槽位并二次入队。
        detach_load_handlers(task);
        let _ = task.borrow().image.remove_attribute("src");

        let retry_callback: Closure<dyn Fn()> = {
            let task = task.clone();
            Closure::new(move || {
                if task.borrow().settled.get() {
                    return;
                }
                QUEUE.with(|queue| {
                    let mut inner = queue.borrow_mut();
                    inner.tasks.push(task.clone());
                    start_next(&mut inner);
                });
            })
        };
        let timer_id = window().and_then(|window| {
            window
                .set_timeout_with_callback_and_timeout_and_arguments_0(
                    retry_callback.as_ref().unchecked_ref(),
                    delay,
                )
                .ok()
        });
        {
            let mut task = task.borrow_mut();
            *task.retry_timer_closure.borrow_mut() = Some(retry_callback);
            task.retry_timer_id.set(timer_id);
        }
        return;
    }

    task.borrow_mut().settled.set(true);
    detach_load_handlers(task);
    let _ = task.borrow().image.remove_attribute("src");
    task.borrow().shared.settle(Err(ImageLoadError::Failed));
    start_next(inner);
}

/// 对齐 abort:结算、清重试定时器、(运行中)释放槽位并清 src、
/// (排队中)移出队列,然后以 AbortError 结算。
fn abort_task(inner: &mut QueueInner, task: &TaskRef) {
    if task.borrow().settled.get() {
        return;
    }
    {
        let mut task = task.borrow_mut();
        task.settled.set(true);
        task.aborted.set(true);
    }
    clear_retry_timer(task);
    detach_load_handlers(task);

    if task.borrow().active.get() {
        finish_active(inner, task);
        let _ = task.borrow().image.remove_attribute("src");
        start_next(inner);
    } else {
        inner
            .tasks
            .retain(|candidate| !Rc::ptr_eq(candidate, task));
    }

    task.borrow().shared.settle(Err(ImageLoadError::Aborted));
}

fn start_next(inner: &mut QueueInner) {
    while inner.active_count < MAX_ACTIVE_IMAGE_LOADS && !inner.tasks.is_empty() {
        // 候选过滤:已中止的任务不参与;挂起时未豁免的任务继续排队。
        let mut selected: Option<(usize, u64)> = None;
        for (index, candidate) in inner.tasks.iter().enumerate() {
            let (aborted, exempt, priority, sequence) = {
                let candidate = candidate.borrow();
                (
                    candidate.aborted.get(),
                    candidate.exempt_from_suspension,
                    candidate.priority,
                    candidate.sequence,
                )
            };
            if aborted {
                continue;
            }
            if inner.suspended && !exempt {
                continue;
            }
            let rank = rank_of(priority, sequence);
            if selected.map_or(true, |(_, best_rank)| rank < best_rank) {
                selected = Some((index, rank));
            }
        }
        let Some((index, _)) = selected else {
            // 全部候选不可运行:丢弃已中止的任务并暂停调度。
            inner.tasks.retain(|candidate| !candidate.borrow().aborted.get());
            break;
        };

        let task = inner.tasks.remove(index);
        task.borrow_mut().active.set(true);
        inner.active_count += 1;
        inner.active.push(task.clone());
        start_task(&task);
    }
}

/// 排队加载一张图片(对齐 imageLoadQueue.load / loadQueuedImage)。
/// 返回值既是 Future 也是取消句柄(对应 React 的 AbortController.signal)。
#[derive(Clone)]
pub struct QueuedImageLoad {
    shared: Rc<TaskShared>,
    task: Rc<RefCell<Option<TaskRef>>>,
}

impl QueuedImageLoad {
    /// 对齐 signal abort:取消加载并以 Aborted 结算;已完成则无副作用。
    pub fn abort(&self) {
        let Some(task) = self.task.borrow().clone() else {
            return;
        };
        QUEUE.with(|queue| {
            let mut inner = queue.borrow_mut();
            abort_task(&mut inner, &task);
        });
        *self.task.borrow_mut() = None;
    }
}

impl Future for QueuedImageLoad {
    type Output = Result<web_sys::HtmlImageElement, ImageLoadError>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if let Some(result) = self.shared.result.borrow_mut().take() {
            return Poll::Ready(result);
        }
        *self.shared.waker.borrow_mut() = Some(cx.waker().clone());
        // 双重检查:注册 waker 与结算可能并发(事件回调先落结果)。
        if let Some(result) = self.shared.result.borrow_mut().take() {
            return Poll::Ready(result);
        }
        Poll::Pending
    }
}

pub fn load_queued_image(src: &str, options: ImageLoadOptions) -> QueuedImageLoad {
    let shared = TaskShared::new();
    let image = create_async_image();

    let task = image.and_then(|image| {
        QUEUE.with(|queue| {
            let mut inner = queue.borrow_mut();
            let sequence = inner.sequence;
            inner.sequence += 1;
            let exempt_from_suspension = inner.suspended;
            let task: TaskRef = Rc::new(RefCell::new(QueueTask {
                src: src.to_string(),
                priority: options.priority,
                retries: options.retries,
                attempt: 0,
                sequence,
                image,
                exempt_from_suspension,
                settled: Cell::new(false),
                aborted: Cell::new(false),
                active: Cell::new(false),
                retry_timer_id: Cell::new(None),
                retry_timer_closure: RefCell::new(None),
                load_closures: RefCell::new(None),
                shared: shared.clone(),
            }));
            inner.tasks.push(task.clone());
            start_next(&mut inner);
            Some(task)
        })
    });

    QueuedImageLoad {
        shared,
        task: Rc::new(RefCell::new(task)),
    }
}

/// 不经队列直接加载(对齐 loadImageWithoutQueue):onload/onerror 双通道,
/// abort 时清空 src 并以 Aborted 结算。
#[derive(Clone)]
pub struct UnqueuedImageLoad {
    shared: Rc<TaskShared>,
    settled: Rc<Cell<bool>>,
    image: Rc<RefCell<Option<web_sys::HtmlImageElement>>>,
    handlers: Rc<RefCell<Option<(Closure<dyn Fn()>, Closure<dyn Fn()>)>>>,
}

impl UnqueuedImageLoad {
    pub fn abort(&self) {
        if self.settled.get() {
            return;
        }
        self.settled.set(true);
        if let Some((onload, onerror)) = self.handlers.borrow_mut().take() {
            drop(onload);
            drop(onerror);
        }
        if let Some(image) = self.image.borrow().as_ref() {
            // 对齐 image.src = "":空 src 的后续加载结果一律忽略(已结算)。
            image.set_src("");
        }
        self.shared.settle(Err(ImageLoadError::Aborted));
    }
}

impl Future for UnqueuedImageLoad {
    type Output = Result<web_sys::HtmlImageElement, ImageLoadError>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if let Some(result) = self.shared.result.borrow_mut().take() {
            return Poll::Ready(result);
        }
        *self.shared.waker.borrow_mut() = Some(cx.waker().clone());
        if let Some(result) = self.shared.result.borrow_mut().take() {
            return Poll::Ready(result);
        }
        Poll::Pending
    }
}

pub fn load_image_without_queue(src: &str, _options: ImageLoadOptions) -> UnqueuedImageLoad {
    let shared = TaskShared::new();
    let settled = Rc::new(Cell::new(false));
    let image_cell: Rc<RefCell<Option<web_sys::HtmlImageElement>>> = Rc::new(RefCell::new(None));
    let handlers: Rc<RefCell<Option<(Closure<dyn Fn()>, Closure<dyn Fn()>)>>> =
        Rc::new(RefCell::new(None));

    if let Some(image) = create_async_image() {
        let onload: Closure<dyn Fn()> = {
            let shared = shared.clone();
            let settled = settled.clone();
            let image_cell = image_cell.clone();
            let handlers = handlers.clone();
            Closure::new(move || {
                if settled.get() {
                    return;
                }
                settled.set(true);
                if let Some((onload, onerror)) = handlers.borrow_mut().take() {
                    drop(onload);
                    drop(onerror);
                }
                let image = image_cell.borrow().clone();
                shared.settle(match image {
                    Some(image) => Ok(image),
                    None => Err(ImageLoadError::Failed),
                });
            })
        };
        let onerror: Closure<dyn Fn()> = {
            let shared = shared.clone();
            let settled = settled.clone();
            let handlers = handlers.clone();
            Closure::new(move || {
                if settled.get() {
                    return;
                }
                settled.set(true);
                if let Some((onload, onerror)) = handlers.borrow_mut().take() {
                    drop(onload);
                    drop(onerror);
                }
                shared.settle(Err(ImageLoadError::Failed));
            })
        };
        let _ = image.set_onload(Some(onload.as_ref().unchecked_ref()));
        let _ = image.set_onerror(Some(onerror.as_ref().unchecked_ref()));
        *handlers.borrow_mut() = Some((onload, onerror));
        *image_cell.borrow_mut() = Some(image);
    } else {
        shared.settle(Err(ImageLoadError::Failed));
    }

    if let Some(image) = image_cell.borrow().as_ref() {
        image.set_src(src);
    }

    UnqueuedImageLoad {
        shared,
        settled,
        image: image_cell,
        handlers,
    }
}

/// 挂起全部排队与运行中的加载(对齐 imageLoadQueue.suspendAll):
/// 被挂起的任务保持 promise 悬置并在 resume 后按原序重启;
/// 挂起期间入队的任务(查看器自己的)豁免并立即启动。
pub fn suspend_all() {
    QUEUE.with(|queue| {
        let mut inner = queue.borrow_mut();
        if inner.suspended {
            return;
        }
        inner.suspended = true;
        let drained: Vec<TaskRef> = std::mem::take(&mut inner.active);
        for task in drained {
            if task.borrow().aborted.get() {
                continue;
            }
            detach_load_handlers(&task);
            let _ = task.borrow().image.remove_attribute("src");
            task.borrow_mut().active.set(false);
            inner.active_count = inner.active_count.saturating_sub(1);
            inner.tasks.push(task);
        }
        start_next(&mut inner);
    });
}

/// 恢复被挂起的加载(对齐 imageLoadQueue.resume)。
pub fn resume() {
    QUEUE.with(|queue| {
        let mut inner = queue.borrow_mut();
        if !inner.suspended {
            return;
        }
        inner.suspended = false;
        start_next(&mut inner);
    });
}
