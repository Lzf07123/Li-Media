// 氛围层(V1.5 暗夜档案馆):静态胶片颗粒 + 单枚极淡光晕。
// 无动画静态层,不参与 prefers-reduced-motion 分支。
use leptos::prelude::*;

#[component]
pub fn AmbientBackground() -> impl IntoView {
    view! {
        <div aria-hidden="true" class="ambient-layer">
            <span class="ambient-halo" />
            <span class="ambient-grain" />
        </div>
    }
}
