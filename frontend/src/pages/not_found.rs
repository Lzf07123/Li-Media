// 404 页(对齐 NotFoundPage.tsx 语义)。
use leptos::prelude::*;

use crate::brand::Brand;

#[component]
pub fn NotFoundPage() -> impl IntoView {
    view! {
        <section class="py-24 text-center">
            <h1 class="text-2xl font-semibold">{Brand::PAGE_TITLE_NOT_FOUND}</h1>
            <p class="mt-4 text-muted">{crate::brand::copy::NOT_FOUND_TEXT}</p>
            <a class="mt-8 inline-flex min-h-11 items-center rounded-md px-4 font-semibold text-primary" href="/">
                {crate::brand::copy::BACK_HOME}
            </a>
        </section>
    }
}
