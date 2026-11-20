// 登录卡片:对齐 AdminLoginCard.tsx。
use leptos::prelude::*;
use wasm_bindgen::JsCast;

use crate::brand::{self, Brand};
use crate::components::ui::avatar::{Avatar, AvatarSize};
use crate::components::ui::blur_text::BlurText;
use crate::components::ui::button::Button;
use crate::components::ui::input::Input;
use crate::components::ui::notice::{Notice, NoticeTone};

#[component]
pub fn AdminLoginCard(
    error: Signal<Option<String>>,
    submitting: Signal<bool>,
    token: RwSignal<String>,
    on_submit: Callback<leptos::ev::SubmitEvent>,
) -> impl IntoView {
    view! {
        <section class="card card-signature card-halo page-enter mx-auto max-w-md p-6 sm:p-8">
            <div class="flex flex-col items-center gap-3">
                <Avatar name={Brand::COPYRIGHT_HOLDER.to_string()} size=AvatarSize::Lg />
                <BlurText class="text-xl font-semibold" text={brand::copy::ADMIN_LOGIN_TITLE.to_string()} />
            </div>
            <p class="mt-2 text-sm text-muted">{brand::copy::ADMIN_LOGIN_DESCRIPTION}</p>

            <form class="mt-6 flex flex-col gap-3" on:submit=move |e| on_submit.run(e)>
                <Input
                    id="admin-token"
                    label_text={brand::copy::ADMIN_TOKEN_LABEL.to_string()}
                    on_input=Callback::new(move |e: web_sys::Event| {
                        let input = e.target().and_then(|t| t.dyn_into::<web_sys::HtmlInputElement>().ok());
                        if let Some(input) = input {
                            token.set(input.value());
                        }
                    })
                    input_type="password"
                />
                <Button disabled=move || submitting.get()>{brand::copy::ADMIN_LOGIN}</Button>
            </form>

            {move || error.get().map(|e| view! { <Notice class="mt-4" tone=NoticeTone::Error>{e}</Notice> })}
        </section>
    }
}
