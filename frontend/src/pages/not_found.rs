// 404 页(逐语义对齐 pages/NotFoundPage.tsx):EmptyState + document.title。
use std::sync::Arc;

use leptos::prelude::*;
use leptos_router::components::A;

use crate::brand::{copy, Brand};
use crate::components::ui::empty_state::EmptyState;
use crate::components::ui::icons::icon_file_question;
use crate::lib::document_title::use_document_title;

#[component]
pub fn NotFoundPage() -> impl IntoView {
    use_document_title(|| Brand::PAGE_TITLE_NOT_FOUND.to_string());

    view! {
        <div class="mt-8">
            <EmptyState
                action={None}
                art={Some(Arc::new(move || {
                    icon_file_question("size-[42px]").into_any()
                }) as ChildrenFn)}
            >
                <span class="mb-2 block text-xl font-semibold text-foreground">
                    {copy::NOT_FOUND_TITLE}
                </span>
                {copy::NOT_FOUND_TEXT}
                <A href="/" {..} class="empty-state-action text-primary">
                    {copy::BACK_HOME}
                </A>
            </EmptyState>
        </div>
    }
}
