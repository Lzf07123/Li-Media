// StatusDot(对齐 components/ui/StatusDot.tsx):连接状态圆点 + sr-only 标签。
use leptos::prelude::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusDotTone {
    Connected,
    Connecting,
    Disconnected,
    Invalid,
}

impl StatusDotTone {
    pub fn as_class(self) -> &'static str {
        match self {
            StatusDotTone::Connected => "status-connected",
            StatusDotTone::Connecting => "status-connecting",
            StatusDotTone::Disconnected => "status-disconnected",
            StatusDotTone::Invalid => "status-invalid",
        }
    }
}

#[component]
pub fn StatusDot(
    tone: StatusDotTone,
    #[prop(optional, into)] label: Option<String>,
) -> impl IntoView {
    let label_view = label.map(|label| {
        view! { <span class="sr-only">{label}</span> }.into_view()
    });

    view! {
        <span class="inline-flex items-center gap-2">
            <span aria-hidden="true" class={format!("status-dot {}", tone.as_class())} />
            {label_view}
        </span>
    }
}
