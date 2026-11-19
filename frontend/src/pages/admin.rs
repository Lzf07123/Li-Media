// 后台:M7 逐步迁移 AdminPage.tsx(1,932 行)与后台组件。
// 骨架版先挂登录入口文案。
use leptos::prelude::*;

use crate::brand::Brand;

#[component]
pub fn AdminPage() -> impl IntoView {
    view! {
        <section class="py-10">
            <h1 class="text-2xl font-semibold">{Brand::PAGE_TITLE_ADMIN}</h1>
            <p class="mt-2 text-muted">{crate::brand::copy::ADMIN_ENTRY}</p>
        </section>
    }
}
