// 后台工作台:对齐 AdminPage.tsx 的功能与类名(紧凑迁移)。
use leptos::prelude::*;
use leptos::task::spawn_local;
use std::sync::Arc;
use leptos_router::hooks::use_navigate;
use wasm_bindgen::JsCast;

use crate::api::admin as admin_api;
use crate::api::types::MemorySummary;
use crate::brand::{self, Brand};
use crate::components::admin::login_card::AdminLoginCard;
use crate::components::admin::setup_card::BaiduSetupCard;
use crate::components::admin::status_dashboard::AdminStatusDashboard;
use crate::components::admin::thumbnail_preheat_card::{PreheatStartPayload, ThumbnailPreheatCard};

#[derive(Clone, Copy, Default)]
struct AdminCounts {
    photo: u32,
    video: u32,
}

#[component]
pub fn AdminPage() -> impl IntoView {
    let navigate = use_navigate();

    let is_admin = RwSignal::new(false);
    let login_error = RwSignal::new(None::<String>);
    let token_input = RwSignal::new(String::new());
    let is_logging_in = RwSignal::new(false);

    let memories: RwSignal<Vec<MemorySummary>> = RwSignal::new(Vec::new());
    let admin_total = RwSignal::new(0u32);
    let admin_page = RwSignal::new(1u32);
    let admin_page_size = RwSignal::new(50u32);
    let admin_kind = RwSignal::new(String::new());
    let admin_display = RwSignal::new(String::new());
    let admin_compatibility = RwSignal::new(String::new());
    let admin_status = RwSignal::new(String::new());
    let admin_search = RwSignal::new(String::new());
    let admin_search_input = RwSignal::new(String::new());
    let selected_ids: RwSignal<Vec<String>> = RwSignal::new(Vec::new());
    let is_loading = RwSignal::new(false);
    let global_counts = RwSignal::new(AdminCounts::default());
    let page_error = RwSignal::new(None::<String>);

    let remote_config: RwSignal<Option<admin_api::RemoteConfig>> = RwSignal::new(None);
    let is_authorizing = RwSignal::new(false);
    let is_syncing = RwSignal::new(false);
    let scan_note = RwSignal::new(None::<String>);
    let system_status: RwSignal<Option<admin_api::SystemStatus>> = RwSignal::new(None);
    let is_refreshing_status = RwSignal::new(false);
    let preheat_job: RwSignal<Option<admin_api::ThumbnailPreheatJob>> = RwSignal::new(None);
    let is_preheating = RwSignal::new(false);
    let is_cancelling_preheat = RwSignal::new(false);
    let page_toast = RwSignal::new(None::<String>);

    let do_authorize = move |_| {
        is_authorizing.set(true);
        spawn_local(async move {
            match admin_api::start_baidu_authorization().await {
                Ok(resp) => {
                    if let Some(window) = web_sys::window() {
                        let _ = window.location().set_href(&resp.authorize_url);
                    }
                }
                Err(e) => page_toast.set(Some(e.message)),
            }
            is_authorizing.set(false);
        });
    };

    let refresh_list = StoredValue::new(Arc::new(move || {
        is_loading.set(true);
        page_error.set(None);
        spawn_local(async move {
            let result = admin_api::get_admin_memories(admin_api::AdminMemoryQuery {
                keyword: Some(admin_search.get()),
                kind: Some(admin_kind.get()),
                display: Some(if admin_display.get().is_empty() {
                    "all".to_string()
                } else {
                    admin_display.get()
                }),
                compatibility: Some(if admin_compatibility.get().is_empty() {
                    "all".to_string()
                } else {
                    admin_compatibility.get()
                }),
                status: Some(admin_status.get()),
                page: Some(admin_page.get()),
                page_size: Some(admin_page_size.get()),
            })
            .await;
            is_loading.set(false);
            match result {
                Ok(resp) => {
                    memories.set(resp.items);
                    admin_total.set(resp.total);
                    global_counts.set(AdminCounts {
                        photo: resp.global_counts.photo,
                        video: resp.global_counts.video,
                    });
                    is_admin.set(true);
                }
                Err(e) => {
                    if e.status == 401 {
                        is_admin.set(false);
                    } else {
                        page_error.set(Some(e.message));
                    }
                }
            }
        });
    }));

    let refresh_list_for_effect = refresh_list.clone();
    Effect::new(move || {
        refresh_list.get_value()()
    });

    let do_login = Callback::new(move |e: leptos::ev::SubmitEvent| {
        e.prevent_default();
        is_logging_in.set(true);
        login_error.set(None);
        let token = token_input.get();
        let refresh_list = refresh_list.clone();
        spawn_local(async move {
            match admin_api::login_admin(&token).await {
                Ok(()) => {
                    is_logging_in.set(false);
                    is_admin.set(true);
                    refresh_list.get_value()()
                }
                Err(e) => {
                    is_logging_in.set(false);
                    login_error.set(Some(e.message));
                }
            }
        });
    });

    let do_logout = Callback::new(move |_: web_sys::MouseEvent| {
        spawn_local(async move {
            let _ = admin_api::logout_admin().await;
            is_admin.set(false);
            if let Some(window) = web_sys::window() {
                let _ = window.location().set_href("/");
            }
        });
    });

    let do_sync = Callback::new(move |_: web_sys::MouseEvent| {
        is_syncing.set(true);
        let refresh_list = refresh_list.clone();
        spawn_local(async move {
            match admin_api::sync_memories(5, 8, 5000, true, None).await {
                Ok(resp) => {
                    scan_note.set(Some(format!(
                        "{} {} / {} {}",
                        brand::copy::ADMIN_SYNC_DISCOVERED_PREFIX.to_string(),
                        resp.discovered,
                        brand::copy::ADMIN_SYNC_MATCHED_PREFIX.to_string(),
                        resp.matched
                    )));
                    refresh_list.get_value()()
                }
                Err(e) => scan_note.set(Some(e.message)),
            }
            is_syncing.set(false);
        });
    });


    let do_start_preheat = Callback::new(move |payload: PreheatStartPayload| {
        is_preheating.set(true);
        spawn_local(async move {
            let kind = payload.kind.as_deref();
            let size_refs: Vec<&str> = payload.sizes.iter().map(|s| s.as_str()).collect();
            match admin_api::start_thumbnail_preheat(&size_refs, kind, payload.limit, payload.include_failed)
                .await
            {
                Ok(job) => preheat_job.set(Some(job)),
                Err(e) => page_toast.set(Some(e.message)),
            }
            is_preheating.set(false);
        });
    });

    let do_cancel_preheat = Callback::new(move |_| {
        is_cancelling_preheat.set(true);
        spawn_local(async move {
            let job_id = preheat_job.get().map(|j| j.id);
            if let Some(id) = job_id {
                match admin_api::cancel_thumbnail_preheat(&id).await {
                    Ok(job) => preheat_job.set(Some(job)),
                    Err(e) => page_toast.set(Some(e.message)),
                }
            }
            is_cancelling_preheat.set(false);
        });
    });

    let do_refresh_status = Callback::new(move |_| {
        is_refreshing_status.set(true);
        spawn_local(async move {
            if let Ok(status) = admin_api::get_system_status().await {
                system_status.set(Some(status));
            }
            is_refreshing_status.set(false);
        });
    });

    view! {
        <div class="mx-auto max-w-5xl">
            {move || if !is_admin.get() {
                view! {
                    <AdminLoginCard
                        error=login_error.into()
                        submitting=Signal::derive(move || is_logging_in.get())
                        token=token_input
                        on_submit=do_login
                    />
                }
                .into_any()
            } else {
                view! {
                    <section class="page-enter">
                        <div class="flex flex-wrap items-start justify-between gap-3">
                            <div>
                                <h1 class="text-2xl font-semibold">{Brand::PAGE_TITLE_ADMIN}</h1>
                                <p class="mt-2 text-sm text-muted">
                                    {format!(
                                        "{}: {} {} / {} {}",
                                        brand::copy::ADMIN_GLOBAL_COUNTS_LABEL.to_string(),
                                        global_counts.get().photo,
                                        brand::copy::ADMIN_GLOBAL_PHOTO_SUFFIX.to_string(),
                                        global_counts.get().video,
                                        brand::copy::ADMIN_GLOBAL_VIDEO_SUFFIX.to_string(),
                                    )}
                                </p>
                            </div>
                            <div class="flex flex-wrap items-center gap-2">
                                <button
                                    class="inline-flex min-h-11 items-center rounded-md border border-border px-4 text-sm"
                                    disabled=move || is_syncing.get()
                                    on:click=move |e| do_sync.run(e)
                                >
                                    {if is_syncing.get() {
                                        brand::copy::ADMIN_SYNCING.to_string()
                                    } else {
                                        brand::copy::ADMIN_SYNC.to_string()
                                    }}
                                </button>
                                <button
                                    class="inline-flex min-h-11 items-center rounded-md border border-border px-4 text-sm"
                                    on:click=move |e| do_logout.run(e)
                                >
                                    {brand::copy::ADMIN_LOGOUT}
                                </button>
                            </div>
                        </div>

                        {scan_note.get().map(|note| {
                            view! { <p class="mt-3 text-sm text-muted">{note}</p> }
                        })}
                        {page_error.get().map(|e| {
                            view! { <p class="mt-3 text-sm text-error">{e}</p> }
                        })}

                        <div class="mt-6 flex flex-wrap items-center gap-2">
                            <input
                                aria-label={brand::copy::ADMIN_SEARCH_LABEL.to_string()}
                                class="min-h-11 flex-1 rounded-md border border-border bg-surface px-3 text-sm"
                                placeholder={brand::copy::ADMIN_SEARCH_PLACEHOLDER.to_string()}
                                value=admin_search_input.get()
                                on:input=move |e| {
                                    let input = e.target().and_then(|t| t.dyn_into::<web_sys::HtmlInputElement>().ok());
                                    if let Some(input) = input {
                                        admin_search_input.set(input.value());
                                    }
                                }
                                on:keydown=move |e: leptos::ev::KeyboardEvent| {
                                    if e.key() == "Enter" {
                                        admin_search.set(admin_search_input.get());
                                        admin_page.set(1);
                                        refresh_list.get_value()()
                                    }
                                }
                            />
                            <select
                                aria-label={brand::copy::ADMIN_FILTER_KIND_LABEL.to_string()}
                                class="min-h-11 rounded-md border border-border bg-surface px-3 text-sm"
                                on:change=move |e| {
                                    let select = e.target().and_then(|t| t.dyn_into::<web_sys::HtmlSelectElement>().ok());
                                    if let Some(select) = select {
                                        admin_kind.set(select.value());
                                        admin_page.set(1);
                                        refresh_list.get_value()()
                                    }
                                }
                            >
                                <option value="">{brand::copy::ADMIN_FILTER_KIND_ALL.to_string()}</option>
                                <option value="photo">{brand::copy::ADMIN_FILTER_KIND_PHOTO.to_string()}</option>
                                <option value="video">{brand::copy::ADMIN_FILTER_KIND_VIDEO.to_string()}</option>
                            </select>
                            <select
                                aria-label={brand::copy::ADMIN_FILTER_STATUS_LABEL.to_string()}
                                class="min-h-11 rounded-md border border-border bg-surface px-3 text-sm"
                                on:change=move |e| {
                                    let select = e.target().and_then(|t| t.dyn_into::<web_sys::HtmlSelectElement>().ok());
                                    if let Some(select) = select {
                                        admin_status.set(select.value());
                                        admin_page.set(1);
                                        refresh_list.get_value()()
                                    }
                                }
                            >
                                <option value="">{brand::copy::ADMIN_FILTER_STATUS_ALL.to_string()}</option>
                                <option value="published">{brand::copy::ADMIN_FILTER_STATUS_PUBLISHED.to_string()}</option>
                                <option value="hidden">{brand::copy::ADMIN_FILTER_STATUS_HIDDEN.to_string()}</option>
                                <option value="draft">{brand::copy::ADMIN_FILTER_STATUS_DRAFT.to_string()}</option>
                            </select>
                        </div>

                        <ul class="mt-4 grid gap-2">
                            {move || memories.get().into_iter().map(|memory| {
                                let id = memory.id.clone();
                                let title = memory.title.clone();
                                let kind = memory.kind.clone();
                                let status = memory.status.clone();
                                let checked = move || selected_ids.get().contains(&memory.id);
                                view! {
                                    <li class="flex items-center gap-3 rounded-lg border border-border p-3">
                                        <input
                                            type="checkbox"
                                            checked=checked()
                                            on:change=move |e| {
                                                let input = e.target().and_then(|t| t.dyn_into::<web_sys::HtmlInputElement>().ok());
                                                if let Some(input) = input {
                                                    let mut current = selected_ids.get();
                                                    if input.checked() {
                                                        current.push(id.clone());
                                                    } else {
                                                        current.retain(|v| v != &id);
                                                    }
                                                    selected_ids.set(current);
                                                }
                                            }
                                        />
                                        <span class="min-w-0 flex-1 truncate text-sm">{title}</span>
                                        <span class="text-xs text-muted">{kind}</span>
                                        <span class="text-xs text-muted">{status}</span>
                                    </li>
                                }
                            }).collect_view()}
                            {move || (memories.get().is_empty() && !is_loading.get()).then(|| {
                                view! { <li class="rounded-lg border border-border p-6 text-center text-sm text-muted">
                                    {brand::copy::ADMIN_LIST_EMPTY.to_string()}
                                </li> }
                            })}
                        </ul>

                        <BaiduSetupCard
                            configured=Signal::derive(move || remote_config.get().as_ref().map(|c| c.configured).unwrap_or(false))
                            authorized=Signal::derive(move || remote_config.get().as_ref().map(|c| c.authorized).unwrap_or(false))
                            docs_url=Signal::derive(move || remote_config.get().as_ref().map(|c| c.docs_url.clone()).unwrap_or_else(|| "https://pan.baidu.com/union/doc/".to_string()))
                            is_authorizing=Signal::derive(move || is_authorizing.get())
                            oauth_configured=Signal::derive(move || remote_config.get().as_ref().map(|c| c.oauth_configured).unwrap_or(false))
                            on_authorize=Callback::new(move |_| do_authorize(()))
                            redirect_uri=Signal::derive(move || remote_config.get().as_ref().map(|c| c.redirect_uri.clone()).unwrap_or_default())
                            scan_dir=Signal::derive(move || remote_config.get().as_ref().map(|c| c.scan_dir.clone()).unwrap_or_default())
                            token_expires_at=Signal::derive(move || remote_config.get().as_ref().and_then(|c| c.token_expires_at.clone()))
                        />

                        <ThumbnailPreheatCard
                            job=Signal::derive(move || preheat_job.get())
                            is_starting=Signal::derive(move || is_preheating.get())
                            is_cancelling=Signal::derive(move || is_cancelling_preheat.get())
                            on_cancel=do_cancel_preheat
                            on_start=do_start_preheat
                        />

                        <AdminStatusDashboard
                            status=Signal::derive(move || system_status.get())
                            is_refreshing=Signal::derive(move || is_refreshing_status.get())
                            on_refresh=do_refresh_status
                        />

                        {page_toast.get().map(|msg| {
                            view! { <p class="mt-4 text-sm text-error">{msg}</p> }
                        })}
                    </section>
                }
                .into_any()
            }}
        </div>
    }
}
