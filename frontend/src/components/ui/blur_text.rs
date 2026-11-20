// BlurText(对齐 components/ui/BlurText.tsx):逐词模糊入场,词序经
// --blur-index 交给 CSS;sr-only 保留完整可读文本。
use leptos::prelude::*;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BlurTextTag {
    #[default]
    Span,
    H1,
    H2,
    H3,
}

#[component]
pub fn BlurText(
    #[prop(into)] text: String,
    #[prop(default = BlurTextTag::Span)] tag: BlurTextTag,
    #[prop(optional, into)] class: String,
    #[prop(optional, into)] id: String,
) -> impl IntoView {
    let words: Vec<&str> = text.split_whitespace().filter(|w| !w.is_empty()).collect();
    let last_index = words.len().saturating_sub(1);

    let rendered = words
        .iter()
        .enumerate()
        .map(|(index, word)| {
            let trailing = if index < last_index { " " } else { "" };
            view! {
                <span
                    class="blur-unit"
                    style={format!("--blur-index: {}", index)}
                >
                    {format!("{}{}", word, trailing)}
                </span>
            }
            .into_view()
        })
        .collect_view();

    let sr_only = view! { <span class="sr-only">{text.clone()}</span> };
    let visual = view! {
        <span aria-hidden="true">
            {rendered}
        </span>
    }
    .into_view();

    match tag {
        BlurTextTag::Span => view! {
            <span class={class.clone()} id={(!id.is_empty()).then(|| id.clone())}>
                {sr_only} {visual}
            </span>
        }
        .into_any(),
        BlurTextTag::H1 => view! {
            <h1 class={class.clone()} id={(!id.is_empty()).then(|| id.clone())}>
                {sr_only.clone()} {visual.clone()}
            </h1>
        }
        .into_any(),
        BlurTextTag::H2 => view! {
            <h2 class={class.clone()} id={(!id.is_empty()).then(|| id.clone())}>
                {sr_only.clone()} {visual.clone()}
            </h2>
        }
        .into_any(),
        BlurTextTag::H3 => view! {
            <h3 class={class} id={(!id.is_empty()).then(|| id)}>
                {sr_only} {visual}
            </h3>
        }
        .into_any(),
    }
}
