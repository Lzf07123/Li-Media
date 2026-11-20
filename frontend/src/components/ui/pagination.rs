// Pagination(对齐 components/ui/Pagination.tsx):上一页/下一页IconButton。
use leptos::prelude::*;

use crate::brand::copy;
use super::icon_button::IconButton;
use super::icons::{icon_chevron_left, icon_chevron_right};

#[component]
pub fn Pagination(
    #[prop(into)] page: u32,
    #[prop(into)] page_size: u32,
    #[prop(into)] total: u32,
    on_page_change: Callback<i64>,
) -> impl IntoView {
    let page_count = if page_size == 0 {
        1u32
    } else {
        ((total + page_size - 1) / page_size).max(1)
    };

    let has_previous = page > 1;
    let has_next = page < page_count;

    view! {
        <nav aria-label=copy::PAGINATION_LABEL class="pagination">
            <IconButton
                aria_disabled={!has_previous}
                aria_label={copy::PREVIOUS_PAGE.to_string()}
                disabled={!has_previous}
                on_click={Callback::new(move |_| on_page_change.run(page as i64 - 1))}
            >
                {icon_chevron_left("")}
            </IconButton>
            <span class="pagination-info">
                {format!("{} / {}", page, page_count)}
            </span>
            <IconButton
                aria_disabled={!has_next}
                aria_label={copy::NEXT_PAGE.to_string()}
                disabled={!has_next}
                on_click={Callback::new(move |_| on_page_change.run(page as i64 + 1))}
            >
                {icon_chevron_right("")}
            </IconButton>
        </nav>
    }
}
