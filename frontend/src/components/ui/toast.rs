// Toast(对齐 components/ui/Toast.tsx):viewport + 进度发丝线 + 关闭按钮。
// 自动消失时长与 CSS 进度动画共用同一常量。
use leptos::prelude::*;

use crate::brand::copy;
use super::icon_button::IconButton;
use super::icons::icon_x;

pub const TOAST_DURATION_MS: u32 = 3600;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToastTone {
    Success,
    Error,
    Info,
    Warning,
}

impl ToastTone {
    pub fn as_class(self) -> &'static str {
        match self {
            ToastTone::Success => "toast-success",
            ToastTone::Error => "toast-error",
            ToastTone::Info => "toast-info",
            ToastTone::Warning => "toast-warning",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Toast {
    pub id: u64,
    pub message: String,
    pub tone: ToastTone,
}

#[component]
pub fn ToastViewport(
    toasts: Signal<Vec<Toast>>,
    on_dismiss: Callback<u64>,
) -> impl IntoView {
    view! {
        <div aria-live="polite" class="toast-viewport">
            {move || {
                toasts
                    .get()
                    .into_iter()
                    .enumerate()
                    .map(|(index, toast)| {
                        let id = toast.id;
                        view! {
                            <div
                                class={format!("toast toast-enter {}", toast.tone.as_class())}
                                style={format!("--toast-index: {}", index)}
                            >
                                <div class="min-w-0">
                                    <p class="toast-title">{toast.message}</p>
                                </div>
                                <span
                                    aria-hidden="true"
                                    class="toast-progress"
                                    style={format!("animation-duration: {}ms", TOAST_DURATION_MS)}
                                />
                                <IconButton
                                    aria_label={copy::CLOSE.to_string()}
                                    class="toast-close ml-auto"
                                    disabled={false}
                                    on_click={Callback::new(move |_| on_dismiss.run(id))}
                                >
                                    {icon_x("")}
                                </IconButton>
                            </div>
                        }
                    })
                    .collect_view()
            }}
        </div>
    }
}
