// 百度 OAuth 回调:M7 对齐 BaiduCallbackPage.tsx(读取 code/state 并上报)。
use leptos::prelude::*;

use crate::brand::Brand;

#[component]
pub fn BaiduCallbackPage() -> impl IntoView {
    view! {
        <section class="py-10">
            <h1 class="text-xl font-semibold">{Brand::NAME}</h1>
            <p class="mt-2 text-muted">{crate::brand::copy::ADMIN_ENTRY}</p>
        </section>
    }
}
