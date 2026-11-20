// Notice(对齐 components/ui/Notice.tsx):polite 状态提示条。
use leptos::prelude::*;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NoticeTone {
    Success,
    Warning,
    Error,
    #[default]
    Info,
}

impl NoticeTone {
    pub fn as_class(self) -> &'static str {
        match self {
            NoticeTone::Success => "notice-success",
            NoticeTone::Warning => "notice-warning",
            NoticeTone::Error => "notice-error",
            NoticeTone::Info => "notice-info",
        }
    }
}

#[component]
pub fn Notice(
    #[prop(default = NoticeTone::Info)] tone: NoticeTone,
    #[prop(optional, into)] class: String,
    children: Children,
) -> impl IntoView {
    view! {
        <div
            aria-live="polite"
            class={format!("notice {} {}", tone.as_class(), class)}
            role="status"
        >
            {children()}
        </div>
    }
}
