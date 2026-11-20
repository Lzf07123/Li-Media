// Badge(对齐 components/ui/Badge.tsx)。
use leptos::prelude::*;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BadgeTone {
    Primary,
    Success,
    Warning,
    Danger,
    #[default]
    Muted,
}

impl BadgeTone {
    pub fn as_class(self) -> &'static str {
        match self {
            BadgeTone::Primary => "badge-primary",
            BadgeTone::Success => "badge-success",
            BadgeTone::Warning => "badge-warning",
            BadgeTone::Danger => "badge-danger",
            BadgeTone::Muted => "badge-muted",
        }
    }
}

#[component]
pub fn Badge(
    #[prop(default = BadgeTone::Muted)] tone: BadgeTone,
    children: Children,
) -> impl IntoView {
    view! {
        <span class={format!("badge {}", tone.as_class())}>{children()}</span>
    }
}
