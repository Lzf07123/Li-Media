// ProgressBar(对齐 components/ui/ProgressBar.tsx):role=progressbar
// + aria 数值,宽度经内联 style 收口在 0-100。
use leptos::prelude::*;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ProgressBarTone {
    #[default]
    Primary,
    Success,
    Warning,
    Danger,
}

impl ProgressBarTone {
    pub fn as_class(self) -> &'static str {
        match self {
            ProgressBarTone::Primary => "",
            ProgressBarTone::Success => "is-success",
            ProgressBarTone::Warning => "is-warning",
            ProgressBarTone::Danger => "is-danger",
        }
    }
}

#[component]
pub fn ProgressBar(
    #[prop(into)] label: String,
    #[prop(into)] value: f64,
    #[prop(default = ProgressBarTone::Primary)] tone: ProgressBarTone,
) -> impl IntoView {
    let bounded_value = value.clamp(0.0, 100.0);
    let tone_class = tone.as_class();

    view! {
        <div
            aria-valuemax="100"
            aria-valuemin="0"
            aria-valuenow={bounded_value}
            aria-label={label}
            role="progressbar"
        >
            <span class={format!("progress {}", tone_class)}>
                <span
                    class="progress-bar"
                    style={format!("width: {}%", bounded_value)}
                />
            </span>
        </div>
    }
}
