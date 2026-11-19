// 首页(回忆库):M7 逐步迁移 HomePage.tsx 的瀑布流/Hero/查看器/空间画廊。
// 骨架版先打通数据链路(get_memories + public-counts)。
use leptos::prelude::*;

use crate::api;
use crate::brand::Brand;

#[component]
pub fn HomePage() -> impl IntoView {
    let counts = LocalResource::new(move || async move {
        api::get_public_counts().await.ok()
    });

    view! {
        <section class="py-10">
            <h1 class="text-2xl font-semibold">{crate::brand::copy::LIBRARY_TITLE}</h1>
            <p class="mt-2 text-muted">{crate::brand::copy::LIBRARY_DESCRIPTION}</p>
            <p class="mt-6 text-sm text-muted">
                {move || match counts.get() {
                    Some(Some(c)) => format!("{} / {} — {}", c.photo, c.video, crate::brand::copy::PUBLIC_COUNT_DETAIL),
                    Some(None) => crate::brand::copy::PUBLIC_COUNT_FAILED.to_string(),
                    None => crate::brand::copy::PUBLIC_COUNT_LOADING.to_string(),
                }}
            </p>
        </section>
    }
}
