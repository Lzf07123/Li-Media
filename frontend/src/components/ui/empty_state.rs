// EmptyState(对齐 components/ui/EmptyState.tsx):装饰图(可选)、
// 提示文本、动作区(可选)。children/action 用 ChildrenFn:提示文案
// 可随搜索/预热状态响应式更新。
use leptos::prelude::*;

#[component]
pub fn EmptyState(
    #[prop(into)] art: Option<ChildrenFn>,
    #[prop(into)] action: Option<ChildrenFn>,
    children: ChildrenFn,
) -> impl IntoView {
    let art_view = art.map(|art| {
        view! {
            <div aria-hidden="true" class="empty-state-art">
                {art()}
            </div>
        }
        .into_view()
    });
    let action_for_view = action.clone();

    view! {
        <div class="empty-state">
            {art_view}
            <p class="empty-state-text">{move || children()}</p>
            {move || {
                action_for_view
                    .as_ref()
                    .map(|action| {
                        view! { <div class="empty-state-action">{action()}</div> }
                    })
            }}
        </div>
    }
}
