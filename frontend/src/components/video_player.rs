// VideoPlayer(逐语义对齐 components/VideoPlayer.tsx):原生 controls 的
// <video>,缓冲/拖拽状态浮层、就绪后的元信息徽章;卸载时释放 src 防止
// 后台继续拉流。
use leptos::prelude::*;
use wasm_bindgen::JsCast;

use crate::brand::copy;
use crate::components::ui::icons::{icon_clock, icon_ratio};

#[component]
pub fn VideoPlayer(
    src: String,
    // 海报/元信息随查看器异步就绪,用 Signal 响应式更新(React props 语义)。
    #[prop(into)] poster: Signal<Option<String>>,
    #[prop(into)] duration: Signal<Option<String>>,
    #[prop(into)] dimensions: Signal<Option<String>>,
    /// error.code(MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED = 4)上报给查看器。
    #[prop(optional)] on_source_error: Option<Callback<Option<u16>>>,
    #[prop(optional)] on_ready: Option<Callback<()>>,
    #[prop(optional)] on_buffering_change: Option<Callback<bool>>,
) -> impl IntoView {
    let video_ref = NodeRef::<leptos::html::Video>::new();
    let is_ready = RwSignal::new(false);
    let is_buffering = RwSignal::new(false);
    let is_seeking = RwSignal::new(false);

    // src 变化即复位状态(对齐 useEffect [src];本组件按 memory 重建,实际
    // 只在挂载时运行一次,语义与 React 相同)。
    let src_for_reset = src.clone();
    Effect::new(move |_| {
        let _ = src_for_reset.clone();
        is_ready.set(false);
        is_buffering.set(false);
        is_seeking.set(false);
    });

    // Capture the element while the effect body runs: React detaches refs
    // before unmount cleanup executes, so videoRef.current is null by then.
    // 卸载清理:暂停 + 清空 src + load(),停止后台缓冲。
    Effect::new(move |_| {
        let Some(video) = video_ref.get() else {
            return;
        };
        let video: web_sys::HtmlVideoElement = video.unchecked_ref::<web_sys::HtmlVideoElement>().clone();
        on_cleanup(move || {
            let _ = video.pause();
            video.remove_attribute("src");
            video.load();
        });
    });

    // 媒体 error 事件按 WHATWG 规范是普通 Event(非 ErrorEvent),
    // tachys 的 on:error 固定转型 ErrorEvent 会 miss:这里原生挂监听,
    // 把 video.error.code 上报(4 = 编码不支持)。
    Effect::new(move |_| {
        let Some(video) = video_ref.get() else {
            return;
        };
        let video: web_sys::HtmlVideoElement = video.unchecked_ref::<web_sys::HtmlVideoElement>().clone();
        let on_source_error = on_source_error;
        let video_for_handler = video.clone();
        let on_error: wasm_bindgen::closure::Closure<dyn Fn(web_sys::Event)> =
            wasm_bindgen::closure::Closure::new(move |_: web_sys::Event| {
                let code = video_for_handler.error().map(|error| error.code());
                if let Some(on_source_error) = on_source_error {
                    on_source_error.run(code);
                }
            });
        let _ = video.add_event_listener_with_callback(
            "error",
            on_error.as_ref().unchecked_ref(),
        );
        let on_error = send_wrapper::SendWrapper::new(on_error);
        on_cleanup(move || {
            let _ = video.remove_event_listener_with_callback(
                "error",
                on_error.as_ref().unchecked_ref(),
            );
        });
    });

    let show_state_overlay = move || (is_buffering.get() || is_seeking.get()).then(|| {
        let label = if is_seeking.get() {
            copy::DETAIL_SEEKING
        } else if is_buffering.get() {
            copy::DETAIL_BUFFERING
        } else {
            copy::DETAIL_MEDIA_LOADING
        };
        view! {
            <div aria-live="polite" class="absolute inset-0 flex items-center justify-center">
                <span class="spinner text-primary" />
                <span class="video-state-label">{label}</span>
            </div>
        }
    });
    let show_meta_badges = move || {
        (is_ready.get() && (duration.get().is_some() || dimensions.get().is_some())).then(|| {
            view! {
                <div class="pointer-events-none absolute left-3 top-3 z-10 flex flex-wrap gap-2">
                    {move || duration.get().map(|duration| {
                        view! {
                            <span class="inline-flex items-center gap-1 rounded-md border border-border bg-surface/85 px-2 py-1 text-xs text-foreground backdrop-blur-sm">
                                {icon_clock("size-3.5")}
                                {duration}
                            </span>
                        }
                    })}
                    {move || dimensions.get().map(|dimensions| {
                        view! {
                            <span class="inline-flex items-center gap-1 rounded-md border border-border bg-surface/85 px-2 py-1 text-xs text-foreground backdrop-blur-sm">
                                {icon_ratio("size-3.5")}
                                {dimensions}
                            </span>
                        }
                    })}
                </div>
            }
        })
    };

    view! {
        <div class="relative size-full">
            {move || show_state_overlay()}
            {move || show_meta_badges()}
            <video
                class=move || {
                    format!(
                        "size-full bg-surface-2 transition-opacity duration-200 {}",
                        if is_ready.get() { "opacity-100" } else { "opacity-0" },
                    )
                }
                controls
                on:canplay=move |_: web_sys::Event| {
                    is_ready.set(true);
                    if let Some(on_ready) = on_ready {
                        on_ready.run(());
                    }
                    if let Some(on_buffering_change) = on_buffering_change {
                        on_buffering_change.run(false);
                    }
                    is_buffering.set(false);
                    is_seeking.set(false);
                }
                on:loadeddata=move |_: web_sys::Event| {
                    is_ready.set(true);
                }
                on:playing=move |_: web_sys::Event| {
                    if let Some(on_buffering_change) = on_buffering_change {
                        on_buffering_change.run(false);
                    }
                    is_buffering.set(false);
                    is_seeking.set(false);
                }
                on:seeked=move |_: web_sys::Event| {
                    is_seeking.set(false);
                }
                on:seeking=move |_: web_sys::Event| {
                    is_seeking.set(true);
                    if let Some(on_buffering_change) = on_buffering_change {
                        on_buffering_change.run(true);
                    }
                }
                on:waiting=move |_: web_sys::Event| {
                    is_buffering.set(true);
                    if let Some(on_buffering_change) = on_buffering_change {
                        on_buffering_change.run(true);
                    }
                }
                poster={move || poster.get()}
                preload="metadata"
                node_ref={video_ref}
                src={src.clone()}
            />
        </div>
    }
}
