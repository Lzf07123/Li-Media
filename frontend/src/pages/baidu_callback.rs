// 百度 OAuth 回调页(逐语义对齐 pages/BaiduCallbackPage.tsx):
// 挂载时读取 code/state/error 并立刻清参(授权码不滞留地址栏与历史),
// 上报 /admin/baidu/callback 后按结果渲染成功/失败卡。
use leptos::prelude::*;
use leptos_router::components::A;
use leptos_router::hooks::{use_location, use_navigate, use_query_map};
use leptos_router::NavigateOptions;

use crate::api;
use crate::brand::copy;
use crate::components::ui::icons::{icon_circle_alert, icon_circle_check};
use crate::components::ui::media_skeleton::MediaSkeleton;
use crate::components::ui::notice::{Notice, NoticeTone};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CallbackState {
    Loading,
    Success,
    Failed,
}

#[component]
pub fn BaiduCallbackPage() -> impl IntoView {
    let query = use_query_map();
    let location = use_location();
    let navigate = use_navigate();

    let state = RwSignal::new(CallbackState::Loading);
    let error: RwSignal<Option<String>> = RwSignal::new(None);

    // 仅在挂载时读取一次回调参数;处理前先清参,授权码不滞留地址栏与历史。
    // 回调只在进入页面时处理一次;参数清除后无需重跑(全部 untracked 读取)。
    Effect::new(move |_| {
        let params = query.get_untracked();
        let code = params.get_str("code").map(str::to_string);
        let oauth_state = params.get_str("state").map(str::to_string);
        let oauth_error = params.get_str("error").map(str::to_string);

        let pathname = location.pathname.get_untracked();
        navigate(
            &pathname,
            NavigateOptions {
                replace: true,
                scroll: false,
                ..NavigateOptions::default()
            },
        );

        if oauth_error.is_some() || code.is_none() || oauth_state.is_none() {
            state.set(CallbackState::Failed);
            // URL error 参数只映射固定文案,不回显外部来源文本。
            error.set(Some(copy::ADMIN_REMOTE_CALLBACK_FAILED.to_string()));
            return;
        }

        let code = code.unwrap();
        let oauth_state = oauth_state.unwrap();
        let state_for_task = state;
        let error_for_task = error;
        wasm_bindgen_futures::spawn_local(async move {
            match api::complete_baidu_authorization(&code, &oauth_state).await {
                Ok(_) => {
                    state_for_task.set(CallbackState::Success);
                }
                Err(callback_error) => {
                    state_for_task.set(CallbackState::Failed);
                    error_for_task.set(Some(if callback_error.message.is_empty() {
                        copy::ADMIN_REMOTE_CALLBACK_FAILED.to_string()
                    } else {
                        callback_error.message
                    }));
                }
            }
        });
    });

    view! {
        {move || {
            if state.get() == CallbackState::Loading {
                return view! {
                    <MediaSkeleton column_count={2} count={1} />
                }
                .into_any();
            }
            if state.get() == CallbackState::Success {
                return view! {
                    <section aria-live="polite" class="mx-auto mt-16 max-w-xl">
                        <div class="card flex flex-col items-center gap-4 p-8 text-center">
                            {icon_circle_check("size-10 text-primary")}
                            <h1 class="text-2xl font-semibold">
                                {copy::ADMIN_REMOTE_CALLBACK_SUCCESS}
                            </h1>
                            <A href="/admin" {..} class="min-h-11 inline-flex items-center text-primary">
                                {copy::ADMIN_REMOTE_CALLBACK_RETURN}
                            </A>
                        </div>
                    </section>
                }
                .into_any();
            }
            view! {
                <section aria-live="polite" class="mx-auto mt-16 max-w-xl">
                    <div class="card flex flex-col gap-4 p-8">
                        <div class="flex items-center gap-3">
                            {icon_circle_alert("size-6 text-danger")}
                            <h1 class="text-2xl font-semibold">
                                {copy::ADMIN_REMOTE_CALLBACK_FAILED}
                            </h1>
                        </div>
                        {move || {
                            error.get().map(|error_message| {
                                view! {
                                    <Notice tone={NoticeTone::Error}>
                                        {error_message}
                                    </Notice>
                                }
                            })
                        }}
                        <A href="/admin" {..} class="min-h-11 inline-flex items-center text-primary">
                            {copy::ADMIN_REMOTE_CALLBACK_RETURN}
                        </A>
                    </div>
                </section>
            }
            .into_any()
        }}
    }
}
