// 页脚:对齐 SiteFooter.tsx(链接语义,M7 接入导航组件后统一 Link)。
use leptos::prelude::*;

use crate::brand::Brand;

#[component]
pub fn SiteFooter() -> impl IntoView {
    let year = js_sys::Date::new_0().get_full_year();
    view! {
        <footer class="site-footer">
            <div class="site-footer-inner">
                <span>{format!("© {} {}", year, Brand::COPYRIGHT_HOLDER)}</span>
                {(!Brand::ICP.is_empty()).then(|| view! { <span>{Brand::ICP}</span> })}
                {(!Brand::PUBLIC_SECURITY_FILING.is_empty()).then(|| view! { <span>{Brand::PUBLIC_SECURITY_FILING}</span> })}
                <span class="hidden sm:inline">{Brand::DESCRIPTION}</span>
                {Brand::FOOTER_LINKS.iter().map(|(label, href)| {
                    view! { <a href=*href>{*label}</a> }
                }).collect_view()}
                <a href="/admin">{crate::brand::copy::ADMIN_ENTRY}</a>
            </div>
        </footer>
    }
}
