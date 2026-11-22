// 后台工作台:逐语义对齐 pages/AdminPage.tsx(三分区 tab 深链、指标卡、
// 内容管理表格与批量流程、资源维护作业与清理确认、状态仪表盘)。
use std::rc::Rc;
use std::sync::Arc;

use leptos::prelude::*;
use leptos::task::spawn_local;
use leptos_router::hooks::{use_navigate, use_query_map};
use wasm_bindgen::{closure::Closure, JsCast};

use crate::api::admin as admin_api;
use crate::api::admin::{
    AdminBackgroundJob, CleanupResult, CleanupStats, RemoteConfig, RemoteScanTask,
    SystemStatus, ThumbnailPreheatJob,
};
use crate::api::types::MemorySummary;
use crate::brand::{self, Brand};
use crate::components::admin::badges::StatusBadge;
use crate::components::admin::login_card::AdminLoginCard;
use crate::components::admin::setup_card::BaiduSetupCard;
use crate::components::admin::status_dashboard::AdminStatusDashboard;
use crate::components::admin::thumbnail_preheat_card::{PreheatStartPayload, ThumbnailPreheatCard};
use crate::components::ui::badge::{Badge, BadgeTone};
use crate::components::ui::button::{Button, ButtonVariant};
use crate::components::ui::empty_state::EmptyState;
use crate::components::ui::icons::{
    icon_circle_check, icon_eye, icon_eye_off, icon_images, icon_refresh_cw, icon_trash,
};
use crate::components::ui::input::Input;
use crate::components::ui::modal::{Modal, ModalTone};
use crate::components::ui::notice::{Notice, NoticeTone};
use crate::components::ui::pagination::Pagination;
use crate::components::ui::progress_bar::{ProgressBar, ProgressBarTone};
use crate::components::ui::status_dot::{StatusDot, StatusDotTone};
use crate::components::ui::toast::{Toast, ToastTone, ToastViewport, TOAST_DURATION_MS};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AdminTab {
    Overview,
    Content,
    Maintenance,
}

impl AdminTab {
    fn from_query(value: Option<&str>) -> Self {
        match value {
            Some("content") => AdminTab::Content,
            Some("maintenance") => AdminTab::Maintenance,
            _ => AdminTab::Overview,
        }
    }

    fn id(self) -> &'static str {
        match self {
            AdminTab::Overview => "overview",
            AdminTab::Content => "content",
            AdminTab::Maintenance => "maintenance",
        }
    }

    fn label(self) -> &'static str {
        match self {
            AdminTab::Overview => brand::copy::ADMIN_TAB_OVERVIEW,
            AdminTab::Content => brand::copy::ADMIN_TAB_CONTENT,
            AdminTab::Maintenance => brand::copy::ADMIN_TAB_MAINTENANCE,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CountsState {
    Loading,
    Ready,
    Error,
}

/// 后台作业是否仍在推进(轮询与完成判定共用)。
fn job_is_waiting(status: &str) -> bool {
    status == "queued" || status == "running"
}

fn format_bytes_admin(bytes: u64) -> String {
    crate::lib::format::format_bytes(Some(bytes)).unwrap_or_else(|| format!("{} B", bytes))
}

#[component]
pub fn AdminPage() -> impl IntoView {
    let query = use_query_map();
    let navigate = use_navigate();

    // 分区走 URL 深链(?tab=content):刷新、分享、回退都落在同一分区;
    // 总览是默认值,不出现在 URL 里。
    let active_tab = Memo::new(move |_| AdminTab::from_query(query.get().get_str("tab")));
    let switch_tab = {
        let query = query.clone();
        let navigate = navigate.clone();
        move |tab: AdminTab| {
            let mut next = query.get_untracked().clone();
            if tab == AdminTab::Overview {
                next.remove("tab");
            } else {
                next.insert("tab", tab.id().to_string());
            }
            navigate(
                &format!("/admin{}", next.to_query_string()),
                leptos_router::NavigateOptions {
                    replace: true,
                    ..Default::default()
                },
            );
        }
    };

    let is_admin = RwSignal::new(false);
    let memories: RwSignal<Vec<MemorySummary>> = RwSignal::new(Vec::new());
    let is_loading = RwSignal::new(false);
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
    let error = RwSignal::new(None::<String>);
    let counts_state = RwSignal::new(CountsState::Loading);
    let display_counts = RwSignal::new((0u32, 0u32));
    let global_counts = RwSignal::new((0u32, 0u32));
    let status_counts = RwSignal::new((0u32, 0u32));
    let browser_counts = RwSignal::new((0u32, 0u32, 0u32));

    let scan_task: RwSignal<Option<RemoteScanTask>> = RwSignal::new(None);
    let remote_config: RwSignal<Option<RemoteConfig>> = RwSignal::new(None);
    let system_status: RwSignal<Option<SystemStatus>> = RwSignal::new(None);
    let is_refreshing_status = RwSignal::new(false);
    let preheat_job: RwSignal<Option<ThumbnailPreheatJob>> = RwSignal::new(None);
    let is_preheating = RwSignal::new(false);
    let is_cancelling_preheat = RwSignal::new(false);
    let is_authorizing = RwSignal::new(false);
    let is_syncing = RwSignal::new(false);
    let batch_job: RwSignal<Option<AdminBackgroundJob>> = RwSignal::new(None);
    let probe_job: RwSignal<Option<AdminBackgroundJob>> = RwSignal::new(None);
    let is_probing = RwSignal::new(false);
    let is_retrying_remote = RwSignal::new(None::<String>);
    let is_status_updating = RwSignal::new(false);
    let is_deleting = RwSignal::new(false);
    let pending_delete: RwSignal<Option<MemorySummary>> = RwSignal::new(None);
    let is_batch_editing = RwSignal::new(false);
    let batch_title = RwSignal::new(String::new());
    let batch_description = RwSignal::new(String::new());
    let batch_location = RwSignal::new(String::new());
    let batch_captured_at = RwSignal::new(String::new());
    let is_batch_updating = RwSignal::new(false);
    let pending_batch_action = RwSignal::new(Option::<String>::None);
    let pending_batch_preview = RwSignal::new(Option::<admin_api::BatchPreviewResponse>::None);
    let is_preparing_batch = RwSignal::new(false);
    let is_starting_batch = RwSignal::new(false);
    let is_cancelling_batch = RwSignal::new(false);
    let is_exporting = RwSignal::new(false);
    let is_cleaning = RwSignal::new(false);
    let pending_cleanup: RwSignal<Option<CleanupStats>> = RwSignal::new(None);
    let cleanup_result: RwSignal<Option<CleanupResult>> = RwSignal::new(None);
    let last_deleted = RwSignal::new(0u32);
    let toasts: RwSignal<Vec<Toast>> = RwSignal::new(Vec::new());
    let page_toast_seq = StoredValue::new(0u64);
    let scan_note = RwSignal::new(Option::<String>::None);

    let push_toast = StoredValue::new(Arc::new(move |message: String, tone: ToastTone| {
        page_toast_seq.update_value(|seq| *seq += 1);
        let id = page_toast_seq.get_value();
        toasts.update(|current| current.push(Toast { id, message, tone }));
        let toasts_for_timer = toasts;
        let callback: Closure<dyn Fn()> =
            Closure::new(move || {
                toasts_for_timer.update(|current| current.retain(|toast| toast.id != id));
            });
        if let Some(window) = web_sys::window() {
            let _ = window.set_timeout_with_callback_and_timeout_and_arguments_0(
                callback.as_ref().unchecked_ref(),
                TOAST_DURATION_MS as i32,
            );
        }
        std::mem::forget(callback);
    }));

    let clear_admin_filters = Callback::new({
        move |_: web_sys::MouseEvent| {
            admin_search.set(String::new());
            admin_search_input.set(String::new());
            admin_kind.set(String::new());
            admin_compatibility.set(String::new());
            admin_status.set(String::new());
            admin_display.set(String::new());
            admin_page.set(1);
        }
    });

    // 控制台面板数据(作业/配置/系统状态)与列表解耦:只在登录后更新。
    let refresh_console_data = StoredValue::new(Arc::new(move || {
        let scan_task = scan_task;
        let remote_config = remote_config;
        let preheat_job = preheat_job;
        let system_status = system_status;
        let batch_job = batch_job;
        let probe_job = probe_job;
        spawn_local(async move {
            if let Ok(latest) = admin_api::get_latest_remote_scan().await {
                scan_task.set(latest);
            }
            if let Ok(config) = admin_api::get_remote_config().await {
                remote_config.set(Some(config));
            }
            if let Ok(latest) = admin_api::get_latest_thumbnail_preheat().await {
                preheat_job.set(latest);
            }
            if let Ok(status) = admin_api::get_system_status().await {
                system_status.set(Some(status));
            }
            if let Ok(latest) = admin_api::get_latest_batch_status_job().await {
                batch_job.set(latest);
            }
            if let Ok(latest) = admin_api::get_latest_browser_compatibility_probe().await {
                probe_job.set(latest);
            }
        });
    }));

    let load_memories = StoredValue::new(Arc::new(move || {
        is_loading.set(true);
        counts_state.set(CountsState::Loading);
        let keyword = admin_search.get();
        let kind = admin_kind.get();
        let display = admin_display.get();
        let compatibility = admin_compatibility.get();
        let status = admin_status.get();
        let page = admin_page.get();
        let page_size = admin_page_size.get();
        spawn_local(async move {
            let result = admin_api::get_admin_memories(admin_api::AdminMemoryQuery {
                keyword: (!keyword.is_empty()).then_some(keyword),
                kind: (!kind.is_empty()).then_some(kind),
                display: (!display.is_empty()).then_some(display),
                compatibility: (!compatibility.is_empty()).then_some(compatibility),
                status: (!status.is_empty()).then_some(status),
                page: Some(page),
                page_size: Some(page_size),
            })
            .await;
            match result {
                Ok(resp) => {
                    memories.set(resp.items);
                    admin_total.set(resp.total);
                    display_counts
                        .set((resp.display_counts.displayable, resp.display_counts.excluded));
                    global_counts.set((resp.global_counts.photo, resp.global_counts.video));
                    status_counts
                        .set((resp.status_counts.published, resp.status_counts.unpublished));
                    browser_counts.set((
                        resp.browser_counts.supported,
                        resp.browser_counts.unsupported,
                        resp.browser_counts.unknown,
                    ));
                    is_admin.set(true);
                    counts_state.set(CountsState::Ready);
                    error.set(None);
                }
                Err(e) => {
                    is_admin.set(false);
                    counts_state.set(CountsState::Error);
                    error.set(if e.status == 401 {
                        None
                    } else {
                        Some(brand::copy::ADMIN_LOGIN_FAILED.to_string())
                    });
                }
            }
            is_loading.set(false);
        });
    }));

    // 挂载即拉取列表:成功(200)确立登录态,401 落回登录卡(React:useEffect loadMemories)。
    Effect::new(move |_| {
        load_memories.get_value()();
    });

    // 登录后进入工作台:面板数据(作业/配置/系统状态)一次性加载。
    Effect::new(move |_| {
        if is_admin.get() {
            refresh_console_data.get_value()();
        }
    });

    let token_input = RwSignal::new(String::new());
    let is_logging_in = RwSignal::new(false);

    let do_login = Callback::new(move |event: leptos::ev::SubmitEvent| {
        event.prevent_default();
        if is_logging_in.get_untracked() {
            return;
        }
        is_logging_in.set(true);
        error.set(None);
        let token = token_input.get();
        spawn_local(async move {
            match admin_api::login_admin(&token).await {
                Ok(()) => {
                    token_input.set(String::new());
                    is_logging_in.set(false);
                    is_admin.set(true);
                    load_memories.get_value()();
                }
                Err(_) => {
                    is_logging_in.set(false);
                    is_admin.set(false);
                    error.set(Some(brand::copy::ADMIN_LOGIN_FAILED.to_string()));
                }
            }
        });
    });

    let do_logout = Callback::new(move |_: web_sys::MouseEvent| {
        spawn_local(async move {
            let _ = admin_api::logout_admin().await;
            is_admin.set(false);
            memories.set(Vec::new());
            error.set(None);
            // 清空作业快照,顺带停止活跃任务轮询。
            scan_task.set(None);
            preheat_job.set(None);
            batch_job.set(None);
            probe_job.set(None);
        });
    });

    let refresh_system_status = StoredValue::new(Arc::new(move || {
        is_refreshing_status.set(true);
        let system_status = system_status;
        spawn_local(async move {
            match admin_api::get_system_status().await {
                Ok(status) => {
                    system_status.set(Some(status));
                    error.set(None);
                }
                Err(_) => error.set(Some(brand::copy::ADMIN_STATUS_REFRESH_FAILED.to_string())),
            }
            is_refreshing_status.set(false);
        });
    }));

    // 活跃任务轮询:对齐 React AdminPage 的 1s 轮询。启动扫描/预热/批量
    // 状态/兼容探测后只拿到 202 快照,必须持续拉取 latest 才能看到 queued →
    // running → completed 的推进;任务结束再刷新列表与系统状态。
    let is_polling_jobs = RwSignal::new(false);
    let poll_jobs = StoredValue::new(Arc::new(move || {
        if is_polling_jobs.get_untracked() {
            return;
        }
        is_polling_jobs.set(true);
        let load_memories = load_memories.get_value();
        let refresh_system_status = refresh_system_status.get_value();
        spawn_local(async move {
            let previous_scan = scan_task.get_untracked().map(|task| task.status);
            let previous_preheat = preheat_job.get_untracked().map(|job| job.status);
            let previous_batch = batch_job.get_untracked().map(|job| job.status);
            let previous_probe = probe_job.get_untracked().map(|job| job.status);

            let next_scan = admin_api::get_latest_remote_scan().await;
            let next_preheat = admin_api::get_latest_thumbnail_preheat().await;
            let next_batch = admin_api::get_latest_batch_status_job().await;
            let next_probe = admin_api::get_latest_browser_compatibility_probe().await;

            let mut reload_memories = false;
            if let Ok(next) = next_scan {
                let finished = previous_scan.as_deref() == Some("running")
                    && next.as_ref().is_none_or(|task| task.status != "running");
                reload_memories |= finished;
                scan_task.set(next);
            }
            if let Ok(next) = next_preheat {
                let finished = previous_preheat.as_deref().is_some_and(job_is_waiting)
                    && next.as_ref().is_none_or(|job| !job_is_waiting(&job.status));
                if finished {
                    reload_memories = true;
                    refresh_system_status();
                }
                preheat_job.set(next);
            }
            if let Ok(next) = next_batch {
                let finished = previous_batch.as_deref().is_some_and(job_is_waiting)
                    && next.as_ref().is_none_or(|job| !job_is_waiting(&job.status));
                reload_memories |= finished;
                batch_job.set(next);
            }
            if let Ok(next) = next_probe {
                let finished = previous_probe.as_deref().is_some_and(job_is_waiting)
                    && next.as_ref().is_none_or(|job| !job_is_waiting(&job.status));
                reload_memories |= finished;
                probe_job.set(next);
            }
            if reload_memories {
                load_memories();
            }
            is_polling_jobs.set(false);
        });
    }));

    // 仅在任一任务 queued/running 时挂 1s 定时器,任务结束后自动停止。
    // Closure 用 mem::forget 常驻(页面生命周期内最多一个,与 toast 定时器
    // 同策略);StoredValue 只保存可清理的 interval handle。
    let poll_interval: StoredValue<Option<i32>> = StoredValue::new(None);
    Effect::new(move |_| {
        let active = scan_task.get().is_some_and(|task| task.status == "running")
            || preheat_job.get().is_some_and(|job| job_is_waiting(&job.status))
            || batch_job.get().is_some_and(|job| job_is_waiting(&job.status))
            || probe_job.get().is_some_and(|job| job_is_waiting(&job.status));
        if active {
            if poll_interval.get_value().is_none() {
                if let Some(window) = web_sys::window() {
                    let callback: Closure<dyn Fn()> =
                        Closure::new(move || poll_jobs.get_value()());
                    if let Ok(handle) = window
                        .set_interval_with_callback_and_timeout_and_arguments_0(
                            callback.as_ref().unchecked_ref(),
                            1000,
                        )
                    {
                        poll_interval.set_value(Some(handle));
                        std::mem::forget(callback);
                    }
                }
            }
        } else if let Some(handle) = poll_interval.get_value() {
            if let Some(window) = web_sys::window() {
                window.clear_interval_with_handle(handle);
            }
            poll_interval.set_value(None);
        }
    });
    on_cleanup(move || {
        if let Some(handle) = poll_interval.get_value() {
            if let Some(window) = web_sys::window() {
                window.clear_interval_with_handle(handle);
            }
        }
    });

    let do_authorize = Callback::new(move |_: ()| {
        is_authorizing.set(true);
        spawn_local(async move {
            match admin_api::start_baidu_authorization().await {
                Ok(resp) => {
                    if let Some(window) = web_sys::window() {
                        let _ = window.location().set_href(&resp.authorize_url);
                    }
                }
                Err(_) => {
                    is_authorizing.set(false);
                    error.set(Some(brand::copy::ADMIN_REMOTE_AUTHORIZE_FAILED.to_string()));
                }
            }
        });
    });

    let do_sync = Callback::new(move |_: web_sys::MouseEvent| {
        if is_syncing.get_untracked() {
            return;
        }
        is_syncing.set(true);
        let push_toast = push_toast.get_value();
        spawn_local(async move {
            match admin_api::sync_memories(5000, 8, 5000, true, None).await {
                Ok(resp) => {
                    error.set(None);
                    last_deleted.set(resp.deleted);
                    let queued = resp.scan_task.status == "running";
                    push_toast(
                        if queued {
                            brand::copy::ADMIN_SCAN_QUEUED.to_string()
                        } else {
                            brand::copy::ADMIN_SYNC_SUCCESS.to_string()
                        },
                        ToastTone::Success,
                    );
                    scan_task.set(Some(resp.scan_task));
                    load_memories.get_value()();
                }
                Err(_) => {
                    error.set(Some(brand::copy::ADMIN_SYNC_FAILED.to_string()));
                }
            }
            is_syncing.set(false);
        });
    });

    let do_start_preheat = Callback::new(move |payload: PreheatStartPayload| {
        is_preheating.set(true);
        let push_toast = push_toast.get_value();
        spawn_local(async move {
            let kind = payload.kind.as_deref();
            let size_refs: Vec<&str> = payload.sizes.iter().map(|s| s.as_str()).collect();
            match admin_api::start_thumbnail_preheat(
                &size_refs,
                kind,
                payload.limit,
                payload.include_failed,
            )
            .await
            {
                Ok(new_job) => {
                    preheat_job.set(Some(new_job));
                    error.set(None);
                    push_toast(
                        brand::copy::ADMIN_PREHEAT_QUEUED_TOAST.to_string(),
                        ToastTone::Success,
                    );
                }
                Err(err) => error.set(Some(if err.message.is_empty() {
                    brand::copy::ADMIN_PREHEAT_FAILED_TOAST.to_string()
                } else {
                    err.message
                })),
            }
            is_preheating.set(false);
        });
    });

    let do_cancel_preheat = Callback::new(move |_: ()| {
        is_cancelling_preheat.set(true);
        let push_toast = push_toast.get_value();
        spawn_local(async move {
            if let Some(current) = preheat_job.get_untracked() {
                match admin_api::cancel_thumbnail_preheat(&current.id).await {
                    Ok(updated) => {
                        preheat_job.set(Some(updated));
                        error.set(None);
                        push_toast(
                            brand::copy::ADMIN_PREHEAT_CANCEL_SUCCESS.to_string(),
                            ToastTone::Info,
                        );
                    }
                    Err(_) => push_toast(
                        brand::copy::ADMIN_PREHEAT_CANCEL_FAILED.to_string(),
                        ToastTone::Error,
                    ),
                }
            }
            is_cancelling_preheat.set(false);
        });
    });

    let prepare_batch = Callback::new(move |target: String| {
        is_preparing_batch.set(true);
        pending_batch_action.set(Some(target));
        let kind = admin_kind.get();
        let search = admin_search.get();
        let display = admin_display.get();
        let compatibility = admin_compatibility.get();
        let status = admin_status.get();
        spawn_local(async move {
            let result = admin_api::preview_batch_status_change(
                (kind == "photo" || kind == "video").then_some(kind.as_str()),
                (!search.is_empty()).then_some(search.as_str()),
                if display == "displayable" || display == "excluded" {
                    display.as_str()
                } else {
                    "all"
                },
                if compatibility == "supported"
                    || compatibility == "unsupported"
                    || compatibility == "unknown"
                {
                    compatibility.as_str()
                } else {
                    "all"
                },
                (status == "published" || status == "hidden").then_some(status.as_str()),
            )
            .await;
            match result {
                Ok(preview) => {
                    pending_batch_preview.set(Some(preview));
                    error.set(None);
                }
                Err(_) => {
                    pending_batch_action.set(None);
                    pending_batch_preview.set(None);
                    error.set(Some(brand::copy::ADMIN_BATCH_FILTER_FAILED.to_string()));
                }
            }
            is_preparing_batch.set(false);
        });
    });

    let close_batch_modal = Callback::new(move |_: ()| {
        pending_batch_action.set(None);
        pending_batch_preview.set(None);
    });

    let confirm_batch = Callback::new(move |_: ()| {
        let Some(target) = pending_batch_action.get_untracked() else {
            return;
        };
        is_starting_batch.set(true);
        let push_toast = push_toast.get_value();
        let kind = admin_kind.get();
        let search = admin_search.get();
        let display = admin_display.get();
        let compatibility = admin_compatibility.get();
        let status = admin_status.get();
        spawn_local(async move {
            let result = admin_api::start_batch_status_change(
                (kind == "photo" || kind == "video").then_some(kind.as_str()),
                (!search.is_empty()).then_some(search.as_str()),
                if display == "displayable" || display == "excluded" {
                    display.as_str()
                } else {
                    "all"
                },
                if compatibility == "supported"
                    || compatibility == "unsupported"
                    || compatibility == "unknown"
                {
                    compatibility.as_str()
                } else {
                    "all"
                },
                (status == "published" || status == "hidden").then_some(status.as_str()),
                &target,
                true,
            )
            .await;
            match result {
                Ok(job) => {
                    batch_job.set(Some(job));
                    pending_batch_action.set(None);
                    pending_batch_preview.set(None);
                    error.set(None);
                    push_toast(
                        brand::copy::ADMIN_BATCH_FILTER_QUEUED.to_string(),
                        ToastTone::Success,
                    );
                }
                Err(_) => error.set(Some(brand::copy::ADMIN_BATCH_FILTER_FAILED.to_string())),
            }
            is_starting_batch.set(false);
        });
    });

    let cancel_batch_job = Callback::new(move |_: web_sys::MouseEvent| {
        let Some(current) = batch_job.get_untracked() else {
            return;
        };
        is_cancelling_batch.set(true);
        spawn_local(async move {
            match admin_api::cancel_batch_status_job(&current.id).await {
                Ok(updated) => {
                    batch_job.set(Some(updated));
                    error.set(None);
                }
                Err(_) => error.set(Some(brand::copy::ADMIN_BATCH_FILTER_FAILED.to_string())),
            }
            is_cancelling_batch.set(false);
        });
    });

    let start_probe = Callback::new(move |_: web_sys::MouseEvent| {
        is_probing.set(true);
        let push_toast = push_toast.get_value();
        spawn_local(async move {
            match admin_api::start_browser_compatibility_probe(25).await {
                Ok(job) => {
                    probe_job.set(Some(job));
                    error.set(None);
                    push_toast(
                        brand::copy::ADMIN_COMPATIBILITY_PROBE_QUEUED.to_string(),
                        ToastTone::Success,
                    );
                }
                Err(_) => {
                    error.set(Some(brand::copy::ADMIN_COMPATIBILITY_PROBE_FAILED.to_string()))
                }
            }
            is_probing.set(false);
        });
    });

    let cancel_probe = Callback::new(move |_: web_sys::MouseEvent| {
        let Some(current) = probe_job.get_untracked() else {
            return;
        };
        is_probing.set(true);
        spawn_local(async move {
            if let Ok(updated) = admin_api::cancel_browser_compatibility_probe(&current.id).await {
                probe_job.set(Some(updated));
            } else {
                error.set(Some(brand::copy::ADMIN_COMPATIBILITY_PROBE_FAILED.to_string()));
            }
            is_probing.set(false);
        });
    });

    let retry_remote = Callback::new(move |memory_id: String| {
        let Some(memory) = memories
            .get_untracked()
            .into_iter()
            .find(|item| item.id == memory_id)
        else {
            return;
        };
        let Some(file) = memory.primary_file else {
            return;
        };
        is_retrying_remote.set(Some(memory_id.clone()));
        let push_toast = push_toast.get_value();
        spawn_local(async move {
            match admin_api::retry_remote_entry(&file.id).await {
                Ok(_) => {
                    push_toast(
                        brand::copy::ADMIN_REMOTE_RETRY_QUEUED_TOAST.to_string(),
                        ToastTone::Success,
                    );
                    load_memories.get_value()();
                }
                Err(_) => push_toast(
                    brand::copy::ADMIN_REMOTE_RETRY_FAILED_TOAST.to_string(),
                    ToastTone::Error,
                ),
            }
            is_retrying_remote.set(None);
        });
    });

    let change_status = Callback::new(move |(memory_id, status): (String, String)| {
        if is_status_updating.get_untracked() {
            return;
        }
        is_status_updating.set(true);
        let push_toast = push_toast.get_value();
        spawn_local(async move {
            let changes = serde_json::json!({ "status": status });
            match admin_api::update_memory(&memory_id, &changes).await {
                Ok(_) => {
                    push_toast(brand::copy::ADMIN_STATUS_CHANGED_TOAST.to_string(), ToastTone::Success);
                    load_memories.get_value()();
                }
                Err(_) => push_toast(
                    brand::copy::ADMIN_STATUS_UPDATE_FAILED.to_string(),
                    ToastTone::Error,
                ),
            }
            is_status_updating.set(false);
        });
    });

    let remove_memory = Callback::new(move |_: ()| {
        let Some(memory) = pending_delete.get_untracked() else {
            return;
        };
        if is_deleting.get_untracked() {
            return;
        }
        is_deleting.set(true);
        let memory_id = memory.id.clone();
        let push_toast = push_toast.get_value();
        spawn_local(async move {
            match admin_api::delete_memory(&memory_id).await {
                Ok(()) => {
                    pending_delete.set(None);
                    selected_ids.update(|current| current.retain(|id| id != &memory_id));
                    push_toast(brand::copy::ADMIN_DELETE_SUCCESS_TOAST.to_string(), ToastTone::Success);
                    load_memories.get_value()();
                }
                Err(_) => push_toast(brand::copy::ADMIN_DELETE_FAILED.to_string(), ToastTone::Error),
            }
            is_deleting.set(false);
        });
    });

    let prepare_cleanup = Callback::new(move |_: web_sys::MouseEvent| {
        is_cleaning.set(true);
        spawn_local(async move {
            match admin_api::request_local_media_cleanup(false).await {
                Ok(result) => {
                    cleanup_result.set(None);
                    pending_cleanup.set(Some(result.stats));
                    error.set(None);
                }
                Err(_) => error.set(Some(brand::copy::ADMIN_CLEANUP_FAILED.to_string())),
            }
            is_cleaning.set(false);
        });
    });

    let confirm_cleanup = Callback::new(move |_: ()| {
        is_cleaning.set(true);
        let push_toast = push_toast.get_value();
        spawn_local(async move {
            match admin_api::request_local_media_cleanup(true).await {
                Ok(result) => {
                    let warning = result.file_cleanup_error.is_some();
                    cleanup_result.set(Some(result));
                    pending_cleanup.set(None);
                    selected_ids.set(Vec::new());
                    error.set(if warning {
                        Some(brand::copy::ADMIN_CLEANUP_FILE_WARNING.to_string())
                    } else {
                        None
                    });
                    push_toast(
                        if warning {
                            brand::copy::ADMIN_CLEANUP_FILE_WARNING.to_string()
                        } else {
                            brand::copy::ADMIN_CLEANUP_SUCCESS.to_string()
                        },
                        if warning { ToastTone::Warning } else { ToastTone::Success },
                    );
                    load_memories.get_value()();
                }
                Err(_) => error.set(Some(brand::copy::ADMIN_CLEANUP_FAILED.to_string())),
            }
            is_cleaning.set(false);
        });
    });

    let close_cleanup_modal = Callback::new(move |_: ()| {
        pending_cleanup.set(None);
    });

    let close_delete_modal = Callback::new(move |_: ()| {
        pending_delete.set(None);
    });

    let close_batch_edit_modal = Callback::new(move |_: ()| {
        is_batch_editing.set(false);
    });

    let submit_batch_edit = Callback::new(move |_: ()| {
        if is_batch_updating.get_untracked() {
            return;
        }
        is_batch_updating.set(true);
        let ids = selected_ids.get_untracked();
        let title = batch_title.get_untracked();
        let description = batch_description.get_untracked();
        let location = batch_location.get_untracked();
        let captured_at = batch_captured_at.get_untracked();
        let push_toast = push_toast.get_value();
        spawn_local(async move {
            let mut changes = serde_json::Map::new();
            if !title.is_empty() {
                changes.insert("title".to_string(), serde_json::json!(title));
            }
            if !description.is_empty() {
                changes.insert("description".to_string(), serde_json::json!(description));
            }
            if !location.is_empty() {
                changes.insert("location".to_string(), serde_json::json!(location));
            }
            if !captured_at.is_empty() {
                changes.insert("captured_at".to_string(), serde_json::json!(captured_at));
            }
            let result =
                admin_api::batch_update_memories(&ids, &serde_json::Value::Object(changes)).await;
            match result {
                Ok(updated) => {
                    error.set(None);
                    let toast = if updated.changed > 0 {
                        brand::copy::ADMIN_BATCH_CHANGED_TOAST
                            .replace("{changed}", &updated.changed.to_string())
                            .replace("{skipped}", &updated.skipped.to_string())
                    } else {
                        brand::copy::ADMIN_BATCH_SKIPPED_TOAST.to_string()
                    };
                    push_toast(
                        toast,
                        if updated.changed > 0 { ToastTone::Success } else { ToastTone::Info },
                    );
                    selected_ids.set(Vec::new());
                    load_memories.get_value()();
                }
                Err(_) => error.set(Some(brand::copy::ADMIN_STATUS_UPDATE_FAILED.to_string())),
            }
            is_batch_updating.set(false);
            is_batch_editing.set(false);
            batch_title.set(String::new());
            batch_description.set(String::new());
            batch_location.set(String::new());
            batch_captured_at.set(String::new());
        });
    });

    let export_selected = Callback::new(move |_: web_sys::MouseEvent| {
        if is_exporting.get_untracked() {
            return;
        }
        is_exporting.set(true);
        let ids = selected_ids.get_untracked();
        spawn_local(async move {
            match admin_api::export_memories(&ids).await {
                Ok(report) => {
                    let payload = serde_json::to_string_pretty(&report).unwrap_or_default();
                    if let Some(document) =
                        web_sys::window().and_then(|window| window.document())
                    {
                        let blob =
                            web_sys::Blob::new_with_str_sequence(&js_sys::Array::of1(&payload.into()))
                                .ok();
                        if let Some(blob) = blob {
                            let url = web_sys::Url::create_object_url_with_blob(&blob).ok();
                            if let Some(url) = url {
                                if let Ok(anchor) = document.create_element("a") {
                                    let _ = anchor.set_attribute("href", &url);
                                    let _ = anchor.set_attribute(
                                        "download",
                                        &format!("limedia-report-{}.json", js_sys::Date::now() as u64),
                                    );
                                    if let Some(html_anchor) =
                                        anchor.dyn_ref::<web_sys::HtmlElement>()
                                    {
                                        let _ = html_anchor.click();
                                    }
                                }
                                let _ = web_sys::Url::revoke_object_url(&url);
                            }
                        }
                    }
                    error.set(None);
                }
                Err(_) => error.set(Some(brand::copy::ADMIN_EXPORT_FAILED.to_string())),
            }
            is_exporting.set(false);
        });
    });

    let apply_selected_status = Callback::new(move |target: String| {
        if is_batch_updating.get_untracked() {
            return;
        }
        is_batch_updating.set(true);
        let ids = selected_ids.get_untracked();
        let push_toast = push_toast.get_value();
        spawn_local(async move {
            let changes = serde_json::json!({ "status": target });
            let result = admin_api::batch_update_memories(&ids, &changes).await;
            match result {
                Ok(updated) => {
                    error.set(None);
                    let toast = if updated.changed > 0 {
                        brand::copy::ADMIN_BATCH_CHANGED_TOAST
                            .replace("{changed}", &updated.changed.to_string())
                            .replace("{skipped}", &updated.skipped.to_string())
                    } else {
                        brand::copy::ADMIN_BATCH_SKIPPED_TOAST.to_string()
                    };
                    push_toast(
                        toast,
                        if updated.changed > 0 { ToastTone::Success } else { ToastTone::Info },
                    );
                    selected_ids.set(Vec::new());
                    load_memories.get_value()();
                }
                Err(_) => error.set(Some(brand::copy::ADMIN_STATUS_UPDATE_FAILED.to_string())),
            }
            is_batch_updating.set(false);
        });
    });

    view! {
        <div class="mx-auto max-w-5xl">
            {move || {
                if !is_admin.get() {
                    return view! {
                        <AdminLoginCard
                            error=error.into()
                            submitting=Signal::derive(move || is_logging_in.get())
                            token=token_input
                            on_submit=do_login
                        />
                    }
                    .into_any();
                }

                let tab = active_tab.get();
                let counts_ready = counts_state.get() == CountsState::Ready;
                let counts_loading = counts_state.get() == CountsState::Loading;
                let count_text = move |text: String| {
                    if counts_ready {
                        text
                    } else if counts_loading {
                        brand::copy::ADMIN_COUNTS_LOADING.to_string()
                    } else {
                        brand::copy::ADMIN_COUNTS_UNAVAILABLE.to_string()
                    }
                };

                view! {
                    <section aria-labelledby="admin-title" class="page-enter">
                        <div class="flex flex-wrap items-start justify-between gap-4">
                            <div>
                                <h1 class="text-3xl font-semibold" id="admin-title">
                                    {brand::copy::ADMIN_TITLE}
                                </h1>
                                <p class="mt-2 text-sm text-muted">{brand::copy::ADMIN_DESCRIPTION}</p>
                            </div>
                            <Button
                                disabled=false
                                on_click=do_logout
                                variant=ButtonVariant::Secondary
                            >
                                {brand::copy::ADMIN_LOGOUT}
                            </Button>
                        </div>

                        {move || {
                            error.get().map(|message| {
                                view! { <Notice class="mt-4" tone=NoticeTone::Error>{message}</Notice> }
                            })
                        }}

                        <button
                            class="skip-link"
                            on:click={
                                let switch_tab = switch_tab.clone();
                                move |_: web_sys::MouseEvent| switch_tab(AdminTab::Content)
                            }
                            type="button"
                        >
                            {brand::copy::ADMIN_SKIP_TO_CONTENT}
                        </button>

                        <div
                            aria-label=brand::copy::ADMIN_TAB_LABEL
                            class="admin-tabbar scroll-tabs mt-6"
                            role="tablist"
                        >
                            {[AdminTab::Overview, AdminTab::Content, AdminTab::Maintenance]
                                .into_iter()
                                .map(|candidate| {
                                    let switch_tab = switch_tab.clone();
                                    let is_active = candidate == tab;
                                    view! {
                                        <button
                                            aria-controls=format!("admin-panel-{}", candidate.id())
                                            aria-selected=is_active
                                            class="scroll-tab"
                                            data-active={if is_active { "true" } else { "false" }}
                                            id=format!("admin-tab-{}", candidate.id())
                                            on:click=move |_: web_sys::MouseEvent| switch_tab(candidate)
                                            role="tab"
                                            tabindex={if is_active { 0 } else { -1 }}
                                            type="button"
                                        >
                                            {candidate.label()}
                                        </button>
                                    }
                                })
                                .collect_view()}
                        </div>

                        // ---- 总览分区 ----
                        <div
                            aria-labelledby="admin-tab-overview"
                            class="mt-4"
                            hidden=tab != AdminTab::Overview
                            id="admin-panel-overview"
                            role="tabpanel"
                        >
                            {move || {
                                let (photo, video) = global_counts.get();
                                let (displayable, excluded) = display_counts.get();
                                let (supported, unsupported, unknown) = browser_counts.get();
                                let (published, unpublished) = status_counts.get();
                                view! {
                                    <div class="admin-metric-grid">
                                        <dl aria-label=brand::copy::ADMIN_GLOBAL_COUNTS_LABEL class="card min-w-52 flex-1 p-4">
                                            <dt class="text-xs text-muted">{brand::copy::ADMIN_GLOBAL_COUNTS_LABEL}</dt>
                                            <dd class="mt-1 text-lg font-semibold">
                                                {count_text(format!("{} / {} / {}", photo + video, photo, video))}
                                            </dd>
                                            <dd class="admin-metric-legend">
                                                {format!(
                                                    "{} / {} / {}",
                                                    brand::copy::ADMIN_FILTER_ALL,
                                                    brand::copy::PHOTO_KIND,
                                                    brand::copy::VIDEO_KIND,
                                                )}
                                            </dd>
                                        </dl>
                                        <dl aria-label=brand::copy::ADMIN_DISPLAY_HEALTH_SUMMARY class="card min-w-52 flex-1 p-4">
                                            <dt class="text-xs text-muted">{brand::copy::ADMIN_DISPLAY_HEALTH_SUMMARY}</dt>
                                            <dd class="mt-1 text-lg font-semibold">
                                                {count_text(format!("{} / {}", displayable, excluded))}
                                            </dd>
                                            <dd class="admin-metric-legend">
                                                {format!(
                                                    "{} / {}",
                                                    brand::copy::ADMIN_DISPLAYABLE,
                                                    brand::copy::ADMIN_DISPLAY_EXCLUDED,
                                                )}
                                            </dd>
                                        </dl>
                                        <dl aria-label=brand::copy::ADMIN_COMPATIBILITY_SUMMARY class="card min-w-52 flex-1 p-4">
                                            <dt class="text-xs text-muted">{brand::copy::ADMIN_COMPATIBILITY_SUMMARY}</dt>
                                            <dd class="mt-1 text-lg font-semibold">
                                                {count_text(format!("{} / {} / {}", supported, unsupported, unknown))}
                                            </dd>
                                            <dd class="admin-metric-legend">
                                                {format!(
                                                    "{} / {} / {}",
                                                    brand::copy::ADMIN_COMPATIBILITY_SUPPORTED,
                                                    brand::copy::ADMIN_COMPATIBILITY_UNSUPPORTED,
                                                    brand::copy::ADMIN_COMPATIBILITY_UNKNOWN,
                                                )}
                                            </dd>
                                        </dl>
                                        <dl aria-label=brand::copy::STATUS_PUBLISHED class="card min-w-52 flex-1 p-4">
                                            <dt class="text-xs text-muted">
                                                {format!(
                                                    "{} / {}",
                                                    brand::copy::STATUS_PUBLISHED,
                                                    brand::copy::ADMIN_UNPUBLISHED,
                                                )}
                                            </dt>
                                            <dd class="mt-1 text-lg font-semibold">
                                                {count_text(format!("{} / {}", published, unpublished))}
                                            </dd>
                                        </dl>
                                    </div>
                                }
                            }}

                            <AdminStatusDashboard
                                is_refreshing=Signal::derive(move || is_refreshing_status.get())
                                on_refresh=Callback::new(move |_: ()| {
                                    refresh_system_status.get_value()();
                                })
                                status=Signal::derive(move || system_status.get())
                            />

                            {move || {
                                remote_config.get().map(|config| {
                                    view! {
                                        <BaiduSetupCard
                                            authorized=Signal::derive(move || config.authorized)
                                            configured=Signal::derive(move || config.configured)
                                            docs_url=Signal::derive(move || config.docs_url.clone())
                                            is_authorizing=Signal::derive(move || is_authorizing.get())
                                            oauth_configured=Signal::derive(move || config.oauth_configured)
                                            on_authorize=do_authorize
                                            redirect_uri=Signal::derive(move || config.redirect_uri.clone())
                                            scan_dir=Signal::derive(move || config.scan_dir.clone())
                                            token_expires_at=Signal::derive(move || config.token_expires_at.clone())
                                        />
                                    }
                                })
                            }}
                        </div>

                        // ---- 内容管理分区 ----
                        <div
                            aria-labelledby="admin-tab-content"
                            class="mt-4"
                            hidden=tab != AdminTab::Content
                            id="admin-panel-content"
                            role="tabpanel"
                        >
                            <div class="admin-page-head">
                                <div>
                                    <p class="admin-eyebrow">{brand::copy::ADMIN_MEDIA_WORKSPACE_TITLE}</p>
                                    <h2 class="admin-heading" id="media-workspace-title">
                                        {brand::copy::ADMIN_ALL_MEMORIES}
                                    </h2>
                                    <p class="mt-2 text-sm text-muted">
                                        {brand::copy::ADMIN_MEDIA_WORKSPACE_DESCRIPTION}
                                    </p>
                                </div>
                            </div>

                            <section aria-labelledby="admin-filter-title" class="admin-panel mt-4">
                                <div class="admin-panel-head">
                                    <div>
                                        <h3 class="admin-panel-title" id="admin-filter-title">
                                            {brand::copy::ADMIN_FILTER_TITLE}
                                        </h3>
                                        <p class="admin-panel-description">
                                            {brand::copy::ADMIN_FILTER_DESCRIPTION}
                                        </p>
                                    </div>
                                    <div aria-live="polite" class="admin-result-meta">
                                        <span>{brand::copy::ADMIN_LIST_SUMMARY}</span>
                                        <strong>
                                            {move || {
                                                if counts_state.get() == CountsState::Ready {
                                                    admin_total.get().to_string()
                                                } else if counts_state.get() == CountsState::Loading {
                                                    brand::copy::ADMIN_COUNTS_LOADING.to_string()
                                                } else {
                                                    brand::copy::ADMIN_COUNTS_UNAVAILABLE.to_string()
                                                }
                                            }}
                                        </strong>
                                    </div>
                                </div>

                                <form
                                    class="admin-filter-grid"
                                    on:submit=move |event: web_sys::SubmitEvent| {
                                        event.prevent_default();
                                        admin_search.set(admin_search_input.get_untracked().trim().to_string());
                                        admin_page.set(1);
                                        load_memories.get_value()();
                                    }
                                >
                                    <div class="admin-filter-field admin-filter-field--wide">
                                        <Input
                                            id="admin-search"
                                            label_text=brand::copy::ADMIN_SEARCH_LABEL.to_string()
                                            on_input=Callback::new(move |event: web_sys::Event| {
                                                let input = event
                                                    .target()
                                                    .and_then(|t| t.dyn_into::<web_sys::HtmlInputElement>().ok());
                                                if let Some(input) = input {
                                                    admin_search_input.set(input.value());
                                                }
                                            })
                                            value=admin_search_input.get()
                                        />
                                    </div>
                                    <label class="admin-filter-field" for="admin-kind-filter">
                                        {brand::copy::ADMIN_FILTER_LABEL}
                                        <select
                                            class="select"
                                            id="admin-kind-filter"
                                            on:change=move |e| {
                                                let select = e.target().and_then(|t| t.dyn_into::<web_sys::HtmlSelectElement>().ok());
                                                if let Some(select) = select {
                                                    admin_kind.set(select.value());
                                                    admin_page.set(1);
                                                    load_memories.get_value()();
                                                }
                                            }
                                            prop:value=move || admin_kind.get()
                                        >
                                            <option value="">{brand::copy::ADMIN_FILTER_ALL}</option>
                                            <option value="photo">{brand::copy::PHOTO_KIND}</option>
                                            <option value="video">{brand::copy::VIDEO_KIND}</option>
                                        </select>
                                    </label>
                                    <label class="admin-filter-field" for="admin-compatibility-filter">
                                        {brand::copy::ADMIN_COMPATIBILITY_FILTER_LABEL}
                                        <select
                                            class="select"
                                            id="admin-compatibility-filter"
                                            on:change=move |e| {
                                                let select = e.target().and_then(|t| t.dyn_into::<web_sys::HtmlSelectElement>().ok());
                                                if let Some(select) = select {
                                                    admin_compatibility.set(select.value());
                                                    admin_page.set(1);
                                                    load_memories.get_value()();
                                                }
                                            }
                                            prop:value=move || admin_compatibility.get()
                                        >
                                            <option value="">{brand::copy::ADMIN_FILTER_ALL}</option>
                                            <option value="supported">{brand::copy::ADMIN_COMPATIBILITY_SUPPORTED}</option>
                                            <option value="unsupported">{brand::copy::ADMIN_COMPATIBILITY_UNSUPPORTED}</option>
                                            <option value="unknown">{brand::copy::ADMIN_COMPATIBILITY_UNKNOWN}</option>
                                        </select>
                                    </label>
                                    <label class="admin-filter-field" for="admin-status-filter">
                                        {brand::copy::ADMIN_STATUS_HEADER}
                                        <select
                                            class="select"
                                            id="admin-status-filter"
                                            on:change=move |e| {
                                                let select = e.target().and_then(|t| t.dyn_into::<web_sys::HtmlSelectElement>().ok());
                                                if let Some(select) = select {
                                                    admin_status.set(select.value());
                                                    admin_page.set(1);
                                                    load_memories.get_value()();
                                                }
                                            }
                                            prop:value=move || admin_status.get()
                                        >
                                            <option value="">{brand::copy::ADMIN_FILTER_ALL}</option>
                                            <option value="published">{brand::copy::STATUS_PUBLISHED}</option>
                                            <option value="hidden">{brand::copy::STATUS_HIDDEN}</option>
                                        </select>
                                    </label>
                                    <label class="admin-filter-field" for="admin-display-filter">
                                        {brand::copy::ADMIN_DISPLAY_HEALTH_LABEL}
                                        <select
                                            class="select"
                                            id="admin-display-filter"
                                            on:change=move |e| {
                                                let select = e.target().and_then(|t| t.dyn_into::<web_sys::HtmlSelectElement>().ok());
                                                if let Some(select) = select {
                                                    admin_display.set(select.value());
                                                    admin_page.set(1);
                                                    load_memories.get_value()();
                                                }
                                            }
                                            prop:value=move || admin_display.get()
                                        >
                                            <option value="">{brand::copy::ADMIN_FILTER_ALL}</option>
                                            <option value="displayable">{brand::copy::ADMIN_DISPLAYABLE}</option>
                                            <option value="excluded">{brand::copy::ADMIN_DISPLAY_EXCLUDED}</option>
                                        </select>
                                    </label>
                                    <label class="admin-filter-field" for="admin-page-size">
                                        {brand::copy::ADMIN_PAGE_SIZE_LABEL}
                                        <select
                                            class="select"
                                            id="admin-page-size"
                                            on:change=move |e| {
                                                let select = e.target().and_then(|t| t.dyn_into::<web_sys::HtmlSelectElement>().ok());
                                                if let Some(select) = select {
                                                    admin_page_size.set(select.value().parse().unwrap_or(50));
                                                    admin_page.set(1);
                                                    load_memories.get_value()();
                                                }
                                            }
                                            prop:value=move || admin_page_size.get().to_string()
                                        >
                                            <option value="20">20</option>
                                            <option value="50">50</option>
                                            <option value="100">100</option>
                                        </select>
                                    </label>
                                    <div class="admin-filter-actions">
                                        <Button
                                            disabled=false
                                            on_click=Callback::new(move |event: web_sys::MouseEvent| {
                                                event.prevent_default();
                                                admin_search.set(admin_search_input.get_untracked().trim().to_string());
                                                admin_page.set(1);
                                                load_memories.get_value()();
                                            })
                                            variant=ButtonVariant::Primary
                                        >
                                            {brand::copy::ADMIN_FILTER_APPLY}
                                        </Button>
                                        <Button
                                            disabled=false
                                            on_click=Callback::new(move |event: web_sys::MouseEvent| clear_admin_filters.run(event))
                                            variant=ButtonVariant::Secondary
                                        >
                                            {brand::copy::ADMIN_CLEAR_FILTERS}
                                        </Button>
                                    </div>
                                </form>

                                {move || {
                                    let active_filter_items: Vec<String> = [
                                        (!admin_search.get().is_empty()).then(|| {
                                            format!("{}: {}", brand::copy::ADMIN_SEARCH_LABEL, admin_search.get())
                                        }),
                                        (!admin_kind.get().is_empty()).then(|| {
                                            format!(
                                                "{}: {}",
                                                brand::copy::ADMIN_FILTER_LABEL,
                                                if admin_kind.get() == "photo" {
                                                    brand::copy::PHOTO_KIND.to_string()
                                                } else {
                                                    brand::copy::VIDEO_KIND.to_string()
                                                }
                                            )
                                        }),
                                        (!admin_compatibility.get().is_empty()).then(|| {
                                            format!(
                                                "{}: {}",
                                                brand::copy::ADMIN_COMPATIBILITY_FILTER_LABEL,
                                                admin_compatibility.get()
                                            )
                                        }),
                                        (!admin_status.get().is_empty()).then(|| {
                                            format!(
                                                "{}: {}",
                                                brand::copy::ADMIN_STATUS_HEADER,
                                                if admin_status.get() == "published" {
                                                    brand::copy::STATUS_PUBLISHED.to_string()
                                                } else {
                                                    brand::copy::STATUS_HIDDEN.to_string()
                                                }
                                            )
                                        }),
                                        (!admin_display.get().is_empty()).then(|| {
                                            format!(
                                                "{}: {}",
                                                brand::copy::ADMIN_DISPLAY_HEALTH_LABEL,
                                                if admin_display.get() == "displayable" {
                                                    brand::copy::ADMIN_DISPLAYABLE.to_string()
                                                } else {
                                                    brand::copy::ADMIN_DISPLAY_EXCLUDED.to_string()
                                                }
                                            )
                                        }),
                                    ]
                                    .into_iter()
                                    .flatten()
                                    .collect();
                                    view! {
                                        <div class="admin-filter-meta">
                                            <div class="admin-chip-row">
                                                <span class="admin-chip-label">
                                                    {if active_filter_items.is_empty() {
                                                        brand::copy::ADMIN_NO_ACTIVE_FILTERS
                                                    } else {
                                                        brand::copy::ADMIN_ACTIVE_FILTERS
                                                    }}
                                                </span>
                                                {active_filter_items
                                                    .into_iter()
                                                    .map(|item| {
                                                        view! {
                                                            <span class="admin-filter-chip">
                                                                <span>{item}</span>
                                                            </span>
                                                        }
                                                    })
                                                    .collect_view()}
                                            </div>
                                        </div>
                                    }
                                }}
                            </section>

                            <section aria-labelledby="admin-scope-actions-title" class="admin-panel mt-4">
                                <div class="admin-panel-head">
                                    <div>
                                        <h3 class="admin-panel-title" id="admin-scope-actions-title">
                                            {brand::copy::ADMIN_FILTER_ACTIONS_TITLE}
                                        </h3>
                                        <p class="admin-panel-description">
                                            {brand::copy::ADMIN_FILTER_ACTIONS_DESCRIPTION}
                                        </p>
                                    </div>
                                    <div class="admin-action-row">
                                        <Button
                                            disabled=move || {
                                                is_preparing_batch.get()
                                                    || batch_job.get().is_some_and(|job| job.status == "running")
                                            }
                                            on_click=Callback::new(move |_: web_sys::MouseEvent| {
                                                prepare_batch.run("published".to_string());
                                            })
                                            variant=ButtonVariant::Primary
                                        >
                                            {brand::copy::ADMIN_BATCH_PUBLISH_FILTER}
                                        </Button>
                                        <Button
                                            disabled=move || {
                                                is_preparing_batch.get()
                                                    || batch_job.get().is_some_and(|job| job.status == "running")
                                            }
                                            on_click=Callback::new(move |_: web_sys::MouseEvent| {
                                                prepare_batch.run("hidden".to_string());
                                            })
                                            variant=ButtonVariant::Secondary
                                        >
                                            {brand::copy::ADMIN_BATCH_HIDE_FILTER}
                                        </Button>
                                    </div>
                                </div>
                            </section>

                            {move || {
                                (!selected_ids.with(Vec::is_empty)).then(|| {
                                    let count = selected_ids.with(Vec::len);
                                    view! {
                                        <section aria-labelledby="admin-selected-actions-title" class="admin-panel mt-4">
                                            <div class="admin-panel-head">
                                                <div>
                                                    <h3 class="admin-panel-title" id="admin-selected-actions-title">
                                                        {brand::copy::ADMIN_SELECTED_ACTIONS_TITLE}
                                                    </h3>
                                                    <p class="admin-panel-description">
                                                        {brand::copy::ADMIN_SELECTED_ACTIONS_DESCRIPTION}
                                                    </p>
                                                </div>
                                                <span class="admin-selected-count">
                                                    {format!("{} {}", brand::copy::ADMIN_SELECTED_COUNT, count)}
                                                </span>
                                            </div>
                                            <div class="admin-action-row">
                                                <Button
                                                    disabled=false
                                                    on_click=Callback::new(move |_: web_sys::MouseEvent| {
                                                        is_batch_editing.set(true);
                                                    })
                                                    variant=ButtonVariant::Primary
                                                >
                                                    {brand::copy::ADMIN_BATCH_EDIT}
                                                </Button>
                                                <Button
                                                    disabled=move || is_batch_updating.get()
                                                    on_click=Callback::new(move |_: web_sys::MouseEvent| {
                                                        apply_selected_status.run("published".to_string());
                                                    })
                                                    variant=ButtonVariant::Primary
                                                >
                                                    {brand::copy::ADMIN_BATCH_PUBLISH}
                                                </Button>
                                                <Button
                                                    disabled=move || is_batch_updating.get()
                                                    on_click=Callback::new(move |_: web_sys::MouseEvent| {
                                                        apply_selected_status.run("hidden".to_string());
                                                    })
                                                    variant=ButtonVariant::Secondary
                                                >
                                                    {brand::copy::ADMIN_BATCH_HIDE}
                                                </Button>
                                                <Button
                                                    disabled=move || is_exporting.get()
                                                    on_click=Callback::new(move |event: web_sys::MouseEvent| export_selected.run(event))
                                                    variant=ButtonVariant::Secondary
                                                >
                                                    {brand::copy::ADMIN_EXPORT_REPORT}
                                                </Button>
                                            </div>
                                        </section>
                                    }
                                })
                            }}

                            {move || {
                                batch_job.get().map(|current| {
                                    let running = current.status == "running" || current.status == "queued";
                                    view! {
                                        <div class="card mt-4 p-4">
                                            <div class="flex flex-wrap items-start justify-between gap-3">
                                                <div>
                                                    <h3 class="text-sm font-semibold">
                                                        {brand::copy::ADMIN_BATCH_JOB_TITLE}
                                                    </h3>
                                                    <p class="mt-1 text-xs text-muted">{current.action.clone()}</p>
                                                </div>
                                                {running.then(|| {
                                                    view! {
                                                        <Button
                                                            disabled=move || is_cancelling_batch.get()
                                                            on_click=Callback::new(move |event: web_sys::MouseEvent| cancel_batch_job.run(event))
                                                            variant=ButtonVariant::Secondary
                                                        >
                                                            {brand::copy::ADMIN_BATCH_JOB_CANCEL}
                                                        </Button>
                                                    }
                                                })}
                                            </div>
                                            <ProgressBar
                                                label=brand::copy::ADMIN_SCAN_PROGRESS.to_string()
                                                tone={if current.status == "failed" { ProgressBarTone::Danger } else { ProgressBarTone::Primary } }
                                                value={if current.total > 0 { (current.processed as f64 / current.total as f64) * 100.0 } else { 0.0 } }
                                            />
                                            <dl class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                                                <div>
                                                    <dt class="text-xs text-muted">{brand::copy::ADMIN_SCAN_STATUS}</dt>
                                                    <dd class="text-sm">{current.status.clone()}</dd>
                                                </div>
                                                <div>
                                                    <dt class="text-xs text-muted">{brand::copy::ADMIN_SCAN_PROGRESS}</dt>
                                                    <dd class="text-sm">
                                                        {format!("{} / {}", current.processed, current.total)}
                                                    </dd>
                                                </div>
                                                <div>
                                                    <dt class="text-xs text-muted">{brand::copy::ADMIN_BATCH_JOB_CHANGED}</dt>
                                                    <dd class="text-sm">{current.changed}</dd>
                                                </div>
                                                <div>
                                                    <dt class="text-xs text-muted">{brand::copy::ADMIN_BATCH_JOB_SKIPPED}</dt>
                                                    <dd class="text-sm">{current.skipped}</dd>
                                                </div>
                                                <div>
                                                    <dt class="text-xs text-muted">{brand::copy::ADMIN_BATCH_JOB_FAILED}</dt>
                                                    <dd class="text-sm">{current.failed}</dd>
                                                </div>
                                            </dl>
                                            {current.error_message.as_ref().map(|message| {
                                                view! {
                                                    <p class="mt-3 text-sm text-muted">
                                                        <span class="font-medium">
                                                            {format!("{}: ", brand::copy::ADMIN_BATCH_JOB_RETRY_REASON)}
                                                        </span>
                                                        {message.clone()}
                                                    </p>
                                                }
                                            })}
                                        </div>
                                    }
                                })
                            }}

                            {move || {
                                let memories_list = memories.get();
                                let is_loading_value = is_loading.get();
                                let selected = selected_ids.get();
                                let retrying = is_retrying_remote.get();
                                if is_loading_value {
                                    // 骨架行与真实表格同壳同列数,加载完成不发生布局跳变
                                    let rows: Vec<_> = (0..8)
                                        .map(|index| {
                                            view! {
                                                <tr>
                                                    <td colspan="8">
                                                        <div
                                                            class="shimmer h-10 rounded-lg"
                                                            style=format!("animation-delay: {}ms", index * 60)
                                                        ></div>
                                                    </td>
                                                </tr>
                                            }
                                        })
                                        .collect();
                                    view! {
                                        <div aria-hidden="true" class="admin-table-shell table-shell mt-4">
                                            <table>
                                                <tbody>{rows}</tbody>
                                            </table>
                                        </div>
                                    }
                                    .into_any()
                                } else if memories_list.is_empty() {
                                    view! {
                                        <div class="admin-table-shell table-shell mt-4">
                                            <table>
                                                <tbody>
                                                    <tr class="table-empty-row">
                                                        <td colspan="8">
                                                            <EmptyState
                                                                action=Some(std::sync::Arc::new(|| ().into_any()) as ChildrenFn)
                                                                art=Some(std::sync::Arc::new(|| {
                                                                    view! {
                                                                        <span class="mb-2 inline-block text-muted">
                                                                            {icon_images("size-8")}
                                                                        </span>
                                                                    }
                                                                        .into_any()
                                                                }) as ChildrenFn)
                                                            >
                                                                {brand::copy::ADMIN_EMPTY}
                                                            </EmptyState>
                                                        </td>
                                                    </tr>
                                                </tbody>
                                            </table>
                                        </div>
                                    }
                                    .into_any()
                                } else {
                                    let rows: Vec<_> = memories_list
                                        .iter()
                                        .map(|memory| {
                                            let memory_id = memory.id.clone();
                                            let memory_snapshot = memory.clone();
                                            let title = memory.title.clone();
                                            let remote_path = memory
                                                .primary_file
                                                .as_ref()
                                                .and_then(|file| file.remote_path.clone())
                                                .unwrap_or_default();
                                            let display_state = memory.media_display_state.clone();
                                            let kind = memory.kind.clone();
                                            let status = memory.status.clone();
                                            let file = memory.primary_file.clone();
                                            let cloud_ready = file.as_ref().map(|file| file.remote_state == "ready").unwrap_or(false);
                                            let media_healthy = file.as_ref().map(|file| {
                                                if file.thumbnail_state != "ready" {
                                                    return false;
                                                }
                                                if kind == "video" {
                                                    file.stream_state == "ready"
                                                        && file.browser_compatibility == "supported"
                                                } else {
                                                    true
                                                }
                                            }).unwrap_or(false);
                                            let last_synced = file.as_ref().and_then(|file| {
                                                file.last_synced_at
                                                    .as_deref()
                                                    .and_then(|value| crate::lib::format::format_date_time(Some(value)))
                                            });
                                            let sync_error = file.as_ref().and_then(|file| file.sync_error.clone());
                                            let is_selected = selected.contains(&memory_id);
                                            let kind_text = if kind == "video" {
                                                brand::copy::VIDEO_KIND.to_string()
                                            } else {
                                                brand::copy::PHOTO_KIND.to_string()
                                            };
                                            let source_is_baidupan = file
                                                .as_ref()
                                                .map(|file| file.source == "baidupan")
                                                .unwrap_or(false);
                                            let retry_disabled = retrying == Some(memory_id.clone());
                                            view! {
                                                <tr>
                                                    <td>
                                                        <input
                                                            aria-label=format!("{} {}", brand::copy::ADMIN_SELECT_MEMORY, title)
                                                            class="admin-check"
                                                            prop:checked=is_selected
                                                            type="checkbox"
                                                            on:change={
                                                                let memory_id = memory_id.clone();
                                                                move |event: web_sys::Event| {
                                                                    let input = event
                                                                        .target()
                                                                        .and_then(|t| t.dyn_into::<web_sys::HtmlInputElement>().ok());
                                                                    if let Some(input) = input {
                                                                        selected_ids.update(|current| {
                                                                            if input.checked() {
                                                                                if !current.contains(&memory_id) {
                                                                                    current.push(memory_id.clone());
                                                                                }
                                                                            } else {
                                                                                current.retain(|id| id != &memory_id);
                                                                            }
                                                                        });
                                                                    }
                                                                }
                                                            }
                                                        />
                                                    </td>
                                                    <td>
                                                        <p class="font-medium">{title}</p>
                                                        <p class="mt-1 text-xs text-muted">{remote_path}</p>
                                                        <div class="mt-2">
                                                            {if display_state == "excluded" {
                                                                view! {
                                                                    <Badge tone=BadgeTone::Danger>
                                                                        {brand::copy::ADMIN_DISPLAY_EXCLUDED}
                                                                    </Badge>
                                                                }
                                                                .into_any()
                                                            } else {
                                                                view! {
                                                                    <Badge tone=BadgeTone::Success>
                                                                        {brand::copy::ADMIN_DISPLAYABLE}
                                                                    </Badge>
                                                                }
                                                                .into_any()
                                                            }}
                                                        </div>
                                                    </td>
                                                    <td>{kind_text}</td>
                                                    <td>
                                                        <StatusBadge status=status.clone() />
                                                    </td>
                                                    <td>
                                                        {match file.clone() {
                                                            Some(file) if cloud_ready => view! {
                                                                <Badge tone=BadgeTone::Muted>
                                                                    <span class="inline-flex items-center gap-1">
                                                                        {icon_circle_check("size-3")}
                                                                        {brand::copy::ADMIN_CLOUD_READY_BADGE}
                                                                    </span>
                                                                </Badge>
                                                            }
                                                            .into_any(),
                                                            Some(file) => view! {
                                                                <div class="flex flex-col items-start gap-1">
                                                                    <crate::components::admin::badges::FileStatusBadge
                                                                        status=file.status.clone().unwrap_or_default()
                                                                    />
                                                                    <crate::components::admin::badges::RemoteStateBadge
                                                                        kind={"remote".to_string()}
                                                                        state=file.remote_state.clone()
                                                                    />
                                                                </div>
                                                            }
                                                            .into_any(),
                                                            None => view! { {brand::copy::FILE_MISSING} }.into_any(),
                                                        }}
                                                    </td>
                                                    <td>
                                                        {match file.clone() {
                                                            Some(file) if media_healthy => view! {
                                                                <Badge tone=BadgeTone::Muted>
                                                                    <span class="inline-flex items-center gap-1">
                                                                        {icon_circle_check("size-3")}
                                                                        {brand::copy::ADMIN_MEDIA_HEALTHY_BADGE}
                                                                    </span>
                                                                </Badge>
                                                            }
                                                            .into_any(),
                                                            Some(file) => view! {
                                                                <div class="flex flex-col items-start gap-1">
                                                                    <crate::components::admin::badges::RemoteStateBadge
                                                                        kind={"thumbnail".to_string()}
                                                                        state=file.thumbnail_state.clone()
                                                                    />
                                                                    {(kind == "video").then(|| {
                                                                        let compat_badge = if file.browser_compatibility == "supported" {
                                                                            view! {
                                                                                <Badge tone=BadgeTone::Success>
                                                                                    {brand::copy::ADMIN_COMPATIBILITY_SUPPORTED}
                                                                                </Badge>
                                                                            }
                                                                            .into_any()
                                                                        } else if file.browser_compatibility == "unsupported" {
                                                                            view! {
                                                                                <Badge tone=BadgeTone::Danger>
                                                                                    {brand::copy::ADMIN_COMPATIBILITY_UNSUPPORTED}
                                                                                </Badge>
                                                                            }
                                                                            .into_any()
                                                                        } else {
                                                                            view! {
                                                                                <Badge tone=BadgeTone::Warning>
                                                                                    {brand::copy::ADMIN_COMPATIBILITY_UNKNOWN}
                                                                                </Badge>
                                                                            }
                                                                            .into_any()
                                                                        };
                                                                        view! {
                                                                            <>
                                                                                <crate::components::admin::badges::RemoteStateBadge
                                                                                    kind={"stream".to_string()}
                                                                                    state=file.stream_state.clone()
                                                                                />
                                                                                {compat_badge}
                                                                            </>
                                                                        }
                                                                    })}
                                                                </div>
                                                            }
                                                            .into_any(),
                                                            None => ().into_any(),
                                                        }}
                                                    </td>
                                                    <td>
                                                        <p class="text-sm">
                                                            {last_synced
                                                                .unwrap_or_else(|| brand::copy::ADMIN_NEVER_SYNCED.to_string())}
                                                        </p>
                                                        {sync_error.map(|message| {
                                                            view! {
                                                                <p class="table-cell-clip text-xs text-muted">{message}</p>
                                                            }
                                                        })}
                                                    </td>
                                                    <td>
                                                        <div class="flex flex-wrap gap-1.5">
                                                            {if status != "published" {
                                                                view! {
                                                                    <button
                                                                        aria-label=brand::copy::ADMIN_PUBLISH
                                                                        class="icon-btn"
                                                                        disabled=move || is_status_updating.get().then(|| "disabled".to_string())
                                                                        on:click={
                                                                            let memory_id = memory_id.clone();
                                                                            move |_: web_sys::MouseEvent| {
                                                                                change_status.run((memory_id.clone(), "published".to_string()));
                                                                            }
                                                                        }
                                                                        title=brand::copy::ADMIN_PUBLISH
                                                                        type="button"
                                                                    >
                                                                        {icon_eye("size-4")}
                                                                    </button>
                                                                }
                                                                .into_any()
                                                            } else {
                                                                view! {
                                                                    <button
                                                                        aria-label=brand::copy::ADMIN_HIDE
                                                                        class="icon-btn"
                                                                        disabled=move || is_status_updating.get().then(|| "disabled".to_string())
                                                                        on:click={
                                                                            let memory_id = memory_id.clone();
                                                                            move |_: web_sys::MouseEvent| {
                                                                                change_status.run((memory_id.clone(), "hidden".to_string()));
                                                                            }
                                                                        }
                                                                        title=brand::copy::ADMIN_HIDE
                                                                        type="button"
                                                                    >
                                                                        {icon_eye_off("size-4")}
                                                                    </button>
                                                                }
                                                                .into_any()
                                                            }}
                                                            {source_is_baidupan.then(|| {
                                                                let memory_id_for_retry = memory_id.clone();
                                                                view! {
                                                                    <button
                                                                        aria-label=brand::copy::ADMIN_RETRY_REMOTE
                                                                        class="icon-btn"
                                                                        disabled=retry_disabled.then(|| "disabled".to_string())
                                                                        on:click=move |_: web_sys::MouseEvent| {
                                                                            retry_remote.run(memory_id_for_retry.clone());
                                                                        }
                                                                        title=brand::copy::ADMIN_RETRY_REMOTE
                                                                        type="button"
                                                                    >
                                                                        {icon_refresh_cw("size-4")}
                                                                    </button>
                                                                }
                                                            })}
                                                            <button
                                                                aria-label=brand::copy::ADMIN_DELETE
                                                                class="icon-btn"
                                                                on:click=move |_: web_sys::MouseEvent| {
                                                                    pending_delete.set(Some(memory_snapshot.clone()));
                                                                }
                                                                title=brand::copy::ADMIN_DELETE
                                                                type="button"
                                                            >
                                                                {icon_trash("size-4")}
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            }
                                        })
                                        .collect();
                                    let all_ids: Vec<String> = memories_list
                                        .iter()
                                        .map(|item| item.id.clone())
                                        .collect();
                                    view! {
                                        <div class="admin-table-shell table-shell mt-4">
                                            <table>
                                                <thead>
                                                    <tr>
                                                        <th scope="col">
                                                            <input
                                                                aria-label=brand::copy::ADMIN_SELECT_ALL
                                                                class="admin-check"
                                                                prop:checked=selected.len() == memories_list.len()
                                                                    && !memories_list.is_empty()
                                                                type="checkbox"
                                                                on:change=move |event: web_sys::Event| {
                                                                    let input = event
                                                                        .target()
                                                                        .and_then(|t| t.dyn_into::<web_sys::HtmlInputElement>().ok());
                                                                    if let Some(input) = input {
                                                                        if input.checked() {
                                                                            selected_ids.set(all_ids.clone());
                                                                        } else {
                                                                            selected_ids.set(Vec::new());
                                                                        }
                                                                    }
                                                                }
                                                            />
                                                        </th>
                                                        <th scope="col">{brand::copy::ADMIN_FILE_HEADER}</th>
                                                        <th scope="col">{brand::copy::ADMIN_KIND_HEADER}</th>
                                                        <th scope="col">{brand::copy::ADMIN_STATUS_HEADER}</th>
                                                        <th scope="col">{brand::copy::ADMIN_CLOUD_HEADER}</th>
                                                        <th scope="col">{brand::copy::ADMIN_MEDIA_HEALTH_HEADER}</th>
                                                        <th scope="col">{brand::copy::ADMIN_LAST_SYNCED_HEADER}</th>
                                                        <th scope="col">{brand::copy::ADMIN_ACTIONS_HEADER}</th>
                                                    </tr>
                                                </thead>
                                                <tbody>{rows}</tbody>
                                            </table>
                                        </div>
                                    }
                                    .into_any()
                                }
                            }}

                            {move || {
                                (admin_total.get() > 0).then(|| {
                                    view! {
                                        <div class="mt-4 flex justify-center">
                                            <Pagination
                                                on_page_change=Callback::new(move |page: i64| {
                                                    admin_page.set(page.max(1) as u32);
                                                    load_memories.get_value()();
                                                })
                                                page=admin_page.get()
                                                page_size=admin_page_size.get()
                                                total=admin_total.get()
                                            />
                                        </div>
                                    }
                                })
                            }}
                        </div>

                        // ---- 资源维护分区 ----
                        <div
                            aria-labelledby="admin-tab-maintenance"
                            class="mt-4"
                            hidden=tab != AdminTab::Maintenance
                            id="admin-panel-maintenance"
                            role="tabpanel"
                        >
                            <div class="admin-page-head">
                                <div>
                                    <p class="admin-eyebrow">{brand::copy::ADMIN_MAINTENANCE_EYEBROW}</p>
                                    <h2 class="admin-heading" id="admin-maintenance-title">
                                        {brand::copy::ADMIN_MAINTENANCE_TITLE}
                                    </h2>
                                    <p class="mt-2 text-sm text-muted">
                                        {brand::copy::ADMIN_MAINTENANCE_DESCRIPTION}
                                    </p>
                                </div>
                                <Button
                                    disabled=move || is_syncing.get()
                                    on_click=Callback::new(move |event: web_sys::MouseEvent| do_sync.run(event))
                                    variant=ButtonVariant::Primary
                                >
                                    {icon_refresh_cw("size-4")}
                                    {brand::copy::ADMIN_SYNC}
                                </Button>
                            </div>

                            <ThumbnailPreheatCard
                                is_cancelling=Signal::derive(move || is_cancelling_preheat.get())
                                is_starting=Signal::derive(move || is_preheating.get())
                                job=Signal::derive(move || preheat_job.get())
                                on_cancel=Callback::new(move |_: ()| {
                                    do_cancel_preheat.run(());
                                })
                                on_start=do_start_preheat
                            />

                            <div class="card mt-4 flex flex-wrap items-center justify-between gap-3 p-4">
                                <div>
                                    <h3 class="text-sm font-semibold">
                                        {brand::copy::ADMIN_COMPATIBILITY_PROBE_TITLE}
                                    </h3>
                                    <p class="mt-1 text-xs text-muted">
                                        {brand::copy::ADMIN_COMPATIBILITY_PROBE_DESCRIPTION}
                                    </p>
                                </div>
                                <div class="flex gap-2">
                                    <Button
                                        disabled=move || {
                                            is_probing.get()
                                                || probe_job
                                                    .get()
                                                    .is_some_and(|job| job.status == "running" || job.status == "queued")
                                        }
                                        on_click=Callback::new(move |event: web_sys::MouseEvent| start_probe.run(event))
                                        variant=ButtonVariant::Primary
                                    >
                                        {move || {
                                            if is_probing.get() {
                                                brand::copy::ADMIN_COMPATIBILITY_PROBING.to_string()
                                            } else {
                                                brand::copy::ADMIN_COMPATIBILITY_PROBE.to_string()
                                            }
                                        }}
                                    </Button>
                                    {move || {
                                        probe_job
                                            .get()
                                            .is_some_and(|job| job.status == "running" || job.status == "queued")
                                            .then(|| {
                                                view! {
                                                    <Button
                                                        disabled=move || is_probing.get()
                                                        on_click=Callback::new(move |event: web_sys::MouseEvent| cancel_probe.run(event))
                                                        variant=ButtonVariant::Secondary
                                                    >
                                                        {brand::copy::ADMIN_BATCH_JOB_CANCEL}
                                                    </Button>
                                                }
                                            })
                                    }}
                                </div>
                            </div>

                            {move || {
                                probe_job.get().map(|current| {
                                    view! {
                                        <div class="card mt-4 p-4">
                                            <ProgressBar
                                                label=brand::copy::ADMIN_COMPATIBILITY_PROBE_TITLE.to_string()
                                                tone={if current.status == "failed" { ProgressBarTone::Danger } else { ProgressBarTone::Primary } }
                                                value={if current.total > 0 { (current.processed as f64 / current.total as f64) * 100.0 } else { 0.0 } }
                                            />
                                            <dl class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                                                <div>
                                                    <dt class="text-xs text-muted">{brand::copy::ADMIN_SCAN_STATUS}</dt>
                                                    <dd class="text-sm">{current.status.clone()}</dd>
                                                </div>
                                                <div>
                                                    <dt class="text-xs text-muted">{brand::copy::ADMIN_SCAN_PROGRESS}</dt>
                                                    <dd class="text-sm">
                                                        {format!("{} / {}", current.processed, current.total)}
                                                    </dd>
                                                </div>
                                                <div>
                                                    <dt class="text-xs text-muted">{brand::copy::ADMIN_BATCH_JOB_CHANGED}</dt>
                                                    <dd class="text-sm">{current.changed}</dd>
                                                </div>
                                                <div>
                                                    <dt class="text-xs text-muted">{brand::copy::ADMIN_BATCH_JOB_FAILED}</dt>
                                                    <dd class="text-sm">{current.failed}</dd>
                                                </div>
                                            </dl>
                                        </div>
                                    }
                                })
                            }}

                            {move || {
                                scan_task.get().map(|task| {
                                    let tone = if task.status == "completed" {
                                        StatusDotTone::Connected
                                    } else if task.status == "running" {
                                        StatusDotTone::Connecting
                                    } else {
                                        StatusDotTone::Invalid
                                    };
                                    let status_text = if task.status == "running" {
                                        brand::copy::ADMIN_SCAN_RUNNING.to_string()
                                    } else if task.status == "completed" {
                                        brand::copy::ADMIN_SCAN_COMPLETED.to_string()
                                    } else {
                                        brand::copy::ADMIN_SCAN_FAILED.to_string()
                                    };
                                    let completed_at = task
                                        .completed_at
                                        .as_deref()
                                        .and_then(|value| crate::lib::format::format_date_time(Some(value)));
                                    view! {
                                        <div class="card mt-4 p-4">
                                            <div class="flex flex-wrap items-start justify-between gap-3">
                                                <div>
                                                    <h3 class="text-sm font-semibold">
                                                        {brand::copy::ADMIN_REMOTE_SCAN_TITLE}
                                                    </h3>
                                                    <p class="mt-1 text-xs text-muted">{task.remote_dir.clone()}</p>
                                                </div>
                                                {(task.status == "failed").then(|| {
                                                    view! {
                                                        <Button
                                                            disabled=move || is_syncing.get()
                                                            on_click=Callback::new(move |event: web_sys::MouseEvent| do_sync.run(event))
                                                            variant=ButtonVariant::Secondary
                                                        >
                                                            {brand::copy::ADMIN_RESUME_SCAN}
                                                        </Button>
                                                    }
                                                })}
                                            </div>
                                            <ProgressBar
                                                label=brand::copy::ADMIN_SCAN_PROGRESS.to_string()
                                                tone={if task.status == "failed" { ProgressBarTone::Danger } else { ProgressBarTone::Primary } }
                                                value={if task.max_items > 0 { (task.processed_items as f64 / task.max_items as f64) * 100.0 } else { 0.0 } }
                                            />
                                            <dl class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                                                <div>
                                                    <dt class="text-xs text-muted">{brand::copy::ADMIN_SCAN_STATUS}</dt>
                                                    <dd class="text-sm">
                                                        <span class="inline-flex items-center gap-2">
                                                            <StatusDot tone=tone />
                                                            {status_text}
                                                        </span>
                                                    </dd>
                                                </div>
                                                <div>
                                                    <dt class="text-xs text-muted">{brand::copy::ADMIN_SCAN_PROGRESS}</dt>
                                                    <dd class="text-sm">
                                                        {format!("{} / {}", task.processed_items, task.max_items)}
                                                    </dd>
                                                </div>
                                                <div>
                                                    <dt class="text-xs text-muted">{brand::copy::ADMIN_SCAN_FILES}</dt>
                                                    <dd class="text-sm">{task.scanned_files}</dd>
                                                </div>
                                                <div>
                                                    <dt class="text-xs text-muted">{brand::copy::ADMIN_SCAN_DIRECTORIES}</dt>
                                                    <dd class="text-sm">{task.scanned_directories}</dd>
                                                </div>
                                                <div>
                                                    <dt class="text-xs text-muted">{brand::copy::ADMIN_SCAN_DISCOVERED}</dt>
                                                    <dd class="text-sm">{task.discovered}</dd>
                                                </div>
                                                <div>
                                                    <dt class="text-xs text-muted">{brand::copy::ADMIN_SCAN_SKIPPED}</dt>
                                                    <dd class="text-sm">{task.skipped}</dd>
                                                </div>
                                                <div>
                                                    <dt class="text-xs text-muted">{brand::copy::STATUS_DELETED_COUNT}</dt>
                                                    <dd class="text-sm">{last_deleted.get()}</dd>
                                                </div>
                                                <div>
                                                    <dt class="text-xs text-muted">{brand::copy::STATUS_COMPLETION_TIME}</dt>
                                                    <dd class="text-sm">
                                                        {completed_at.unwrap_or_else(|| {
                                                            if task.status == "running" {
                                                                brand::copy::ADMIN_SCAN_RUNNING.to_string()
                                                            } else {
                                                                brand::copy::ADMIN_NEVER_SYNCED.to_string()
                                                            }
                                                        })}
                                                    </dd>
                                                </div>
                                            </dl>
                                            {task.failure_reason.map(|reason| {
                                                view! {
                                                    <p class="mt-3 text-sm text-muted">
                                                        <span class="font-medium">
                                                            {format!("{}: ", brand::copy::ADMIN_SCAN_FAILURE)}
                                                        </span>
                                                        {reason}
                                                    </p>
                                                }
                                            })}
                                        </div>
                                    }
                                })
                            }}

                            <div class="card mt-4 flex flex-wrap items-center gap-3 p-4">
                                <div class="mr-auto">
                                    <h3 class="text-sm font-semibold">{brand::copy::ADMIN_CLEANUP_TITLE}</h3>
                                    <p class="mt-1 text-xs text-muted">{brand::copy::ADMIN_CLEANUP_DESCRIPTION}</p>
                                </div>
                                <Button
                                    disabled=move || is_cleaning.get()
                                    on_click=Callback::new(move |event: web_sys::MouseEvent| prepare_cleanup.run(event))
                                    variant=ButtonVariant::Danger
                                >
                                    {move || {
                                        if is_cleaning.get() && pending_cleanup.get().is_none() {
                                            brand::copy::ADMIN_CLEANUP_RUNNING.to_string()
                                        } else {
                                            brand::copy::ADMIN_CLEANUP.to_string()
                                        }
                                    }}
                                </Button>
                            </div>

                            {move || {
                                cleanup_result.get().map(|result| {
                                    let stats = &result.stats;
                                    view! {
                                        <dl class="card mt-4 grid grid-cols-2 gap-3 p-4 sm:grid-cols-5">
                                            <div>
                                                <dt class="text-xs text-muted">{brand::copy::ADMIN_CLEANUP_MEMORIES}</dt>
                                                <dd class="text-sm">{stats.memories}</dd>
                                            </div>
                                            <div>
                                                <dt class="text-xs text-muted">{brand::copy::ADMIN_CLEANUP_REMOTE_INDEXES}</dt>
                                                <dd class="text-sm">{stats.remote_file_indexes}</dd>
                                            </div>
                                            <div>
                                                <dt class="text-xs text-muted">{brand::copy::ADMIN_CLEANUP_THUMBNAILS}</dt>
                                                <dd class="text-sm">{stats.thumbnail_files}</dd>
                                            </div>
                                            <div>
                                                <dt class="text-xs text-muted">{brand::copy::ADMIN_CLEANUP_BYTES}</dt>
                                                <dd class="text-sm">{format_bytes_admin(stats.estimated_bytes_to_free)}</dd>
                                            </div>
                                        </dl>
                                    }
                                })
                            }}
                        </div>

                        <a class="mt-8 inline-flex min-h-11 items-center text-primary" href="/">
                            {brand::copy::BACK_HOME}
                        </a>

                        <Modal
                            on_close=Callback::new(move |_: ()| close_delete_modal.run(()))
                            open=Signal::derive(move || pending_delete.get().is_some())
                            title=brand::copy::ADMIN_DELETE_CONFIRM_TITLE.to_string()
                            tone=ModalTone::Danger
                        >
                            <p class="mt-3 text-sm text-muted">{brand::copy::ADMIN_DELETE_CONFIRM_TEXT}</p>
                            <div class="mt-6 flex justify-end gap-2">
                                <Button
                                    disabled=false
                                    on_click=Callback::new(move |_: web_sys::MouseEvent| close_delete_modal.run(()))
                                    variant=ButtonVariant::Secondary
                                >
                                    {brand::copy::ADMIN_CANCEL}
                                </Button>
                                <Button
                                    disabled=move || is_deleting.get()
                                    on_click=Callback::new(move |_: web_sys::MouseEvent| remove_memory.run(()))
                                    variant=ButtonVariant::Danger
                                >
                                    {brand::copy::ADMIN_CONFIRM_DELETE}
                                </Button>
                            </div>
                        </Modal>

                        <Modal
                            on_close=Callback::new(move |_: ()| close_batch_edit_modal.run(()))
                            open=Signal::derive(move || is_batch_editing.get())
                            title=brand::copy::ADMIN_BATCH_EDIT_TITLE.to_string()
                        >
                            <div class="mt-4 grid gap-3">
                                <Input
                                    id="batch-title"
                                    label_text=brand::copy::ADMIN_TITLE_LABEL.to_string()
                                    on_input=Callback::new(move |event: web_sys::Event| {
                                        let input = event
                                            .target()
                                            .and_then(|t| t.dyn_into::<web_sys::HtmlInputElement>().ok());
                                        if let Some(input) = input {
                                            batch_title.set(input.value());
                                        }
                                    })
                                    value=batch_title.get()
                                />
                                <Input
                                    id="batch-captured-at"
                                    input_type="datetime-local"
                                    label_text=brand::copy::ADMIN_CAPTURED_AT_LABEL.to_string()
                                    on_input=Callback::new(move |event: web_sys::Event| {
                                        let input = event
                                            .target()
                                            .and_then(|t| t.dyn_into::<web_sys::HtmlInputElement>().ok());
                                        if let Some(input) = input {
                                            batch_captured_at.set(input.value());
                                        }
                                    })
                                    value=batch_captured_at.get()
                                />
                                <Input
                                    id="batch-location"
                                    label_text=brand::copy::ADMIN_LOCATION_LABEL.to_string()
                                    on_input=Callback::new(move |event: web_sys::Event| {
                                        let input = event
                                            .target()
                                            .and_then(|t| t.dyn_into::<web_sys::HtmlInputElement>().ok());
                                        if let Some(input) = input {
                                            batch_location.set(input.value());
                                        }
                                    })
                                    value=batch_location.get()
                                />
                                <crate::components::ui::input::TextArea
                                    id="batch-description"
                                    label_text=brand::copy::ADMIN_DESCRIPTION_LABEL.to_string()
                                    on_input=Callback::new(move |event: web_sys::Event| {
                                        let area = event
                                            .target()
                                            .and_then(|t| t.dyn_into::<web_sys::HtmlTextAreaElement>().ok());
                                        if let Some(area) = area {
                                            batch_description.set(area.value());
                                        }
                                    })
                                    value=batch_description.get()
                                />
                            </div>
                            <div class="mt-6 flex justify-end gap-2">
                                <Button
                                    disabled=false
                                    on_click=Callback::new(move |_: web_sys::MouseEvent| close_batch_edit_modal.run(()))
                                    variant=ButtonVariant::Secondary
                                >
                                    {brand::copy::ADMIN_CANCEL}
                                </Button>
                                <Button
                                    disabled=move || is_batch_updating.get()
                                    on_click=Callback::new(move |_: web_sys::MouseEvent| submit_batch_edit.run(()))
                                    variant=ButtonVariant::Primary
                                >
                                    {brand::copy::ADMIN_BATCH_SAVE}
                                </Button>
                            </div>
                        </Modal>

                        <BatchConfirmModal
                            action=Signal::derive(move || pending_batch_action.get())
                            is_starting=Signal::derive(move || is_starting_batch.get())
                            on_close=close_batch_modal
                            on_confirm=Callback::new(move |_: ()| confirm_batch.run(()))
                            preview=Signal::derive(move || pending_batch_preview.get())
                        />

                        <Modal
                            on_close=Callback::new(move |_: ()| close_cleanup_modal.run(()))
                            open=Signal::derive(move || pending_cleanup.get().is_some())
                            title=brand::copy::ADMIN_CLEANUP_CONFIRM_TITLE.to_string()
                            tone=ModalTone::Danger
                        >
                            <p class="mt-3 text-sm text-muted">{brand::copy::ADMIN_CLEANUP_CONFIRM_TEXT}</p>
                            <CleanupStatsGrid pending=Signal::derive(move || pending_cleanup.get()) />
                            <div class="mt-6 flex justify-end gap-2">
                                <Button
                                    disabled=false
                                    on_click=Callback::new(move |_: web_sys::MouseEvent| close_cleanup_modal.run(()))
                                    variant=ButtonVariant::Secondary
                                >
                                    {brand::copy::ADMIN_CANCEL}
                                </Button>
                                <Button
                                    disabled=move || is_cleaning.get()
                                    on_click=Callback::new(move |_: web_sys::MouseEvent| confirm_cleanup.run(()))
                                    variant=ButtonVariant::Danger
                                >
                                    {move || {
                                        if is_cleaning.get() {
                                            brand::copy::ADMIN_CLEANUP_RUNNING.to_string()
                                        } else {
                                            brand::copy::ADMIN_CLEANUP_CONFIRM.to_string()
                                        }
                                    }}
                                </Button>
                            </div>
                        </Modal>

                        <ToastViewport
                            on_dismiss=Callback::new(move |id: u64| {
                                toasts.update(|current| current.retain(|toast| toast.id != id));
                            })
                            toasts=toasts.into()
                        />
                    </section>
                }
                .into_any()
            }}
        </div>
    }
}

// 批量确认弹窗:预览统计 + 确认/取消(对齐 React 批量状态变更 Modal)。
#[component]
fn BatchConfirmModal(
    preview: Signal<Option<admin_api::BatchPreviewResponse>>,
    action: Signal<Option<String>>,
    is_starting: Signal<bool>,
    on_confirm: Callback<()>,
    on_close: Callback<()>,
) -> impl IntoView {
    let is_hidden = Memo::new(move |_| action.get().as_deref() == Some("hidden"));
    view! {
        <Modal
            on_close=Callback::new(move |_: ()| on_close.run(()))
            open=Signal::derive(move || action.get().is_some() && preview.get().is_some())
            title=brand::copy::ADMIN_BATCH_FILTER_CONFIRM_TITLE.to_string()
            tone={if is_hidden.get() { ModalTone::Danger } else { ModalTone::Info }}
        >
            {move || {
                let data = preview.get()?;
                Some(view! {
                    <div>
                        {(data.is_full_library).then(|| {
                            view! {
                                <p class="mt-3 text-sm font-medium text-destructive">
                                    {brand::copy::ADMIN_BATCH_FILTER_ALL_WARNING}
                                </p>
                            }
                        })}
                        <dl class="mt-4 grid grid-cols-2 gap-3 rounded-xl bg-surface-2 p-3">
                            <div>
                                <dt class="text-xs text-muted">{brand::copy::ADMIN_BATCH_FILTER_SCOPE}</dt>
                                <dd class="text-sm">
                                    {format!(
                                        "{}/{}",
                                        data.filter_snapshot
                                            .get("kind")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("all"),
                                        data.filter_snapshot
                                            .get("display")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("all"),
                                    )}
                                </dd>
                            </div>
                            <div>
                                <dt class="text-xs text-muted">{brand::copy::ADMIN_BATCH_FILTER_TOTAL}</dt>
                                <dd class="text-sm">{data.total}</dd>
                            </div>
                            <div>
                                <dt class="text-xs text-muted">{brand::copy::ADMIN_BATCH_FILTER_KIND}</dt>
                                <dd class="text-sm">{format!("{} / {}", data.counts.photo, data.counts.video)}</dd>
                            </div>
                            <div>
                                <dt class="text-xs text-muted">{brand::copy::ADMIN_BATCH_FILTER_STATUS}</dt>
                                <dd class="text-sm">
                                    {format!("{} / {}", data.status_counts.published, data.status_counts.unpublished)}
                                </dd>
                            </div>
                            <div>
                                <dt class="text-xs text-muted">{brand::copy::ADMIN_BATCH_FILTER_DISPLAY}</dt>
                                <dd class="text-sm">
                                    {format!("{} / {}", data.display_counts.displayable, data.display_counts.excluded)}
                                </dd>
                            </div>
                            <div>
                                <dt class="text-xs text-muted">{brand::copy::ADMIN_BATCH_FILTER_BROWSER}</dt>
                                <dd class="text-sm">
                                    {format!(
                                        "{} / {} / {}",
                                        data.browser_counts.supported,
                                        data.browser_counts.unsupported,
                                        data.browser_counts.unknown,
                                    )}
                                </dd>
                            </div>
                        </dl>
                        <div class="mt-6 flex justify-end gap-2">
                            <Button
 disabled=false on_click=Callback::new(move |_: web_sys::MouseEvent| on_close.run(())) variant=ButtonVariant::Secondary>
                                {brand::copy::ADMIN_BATCH_FILTER_CANCEL}
                            </Button>
                            <Button
                                disabled=move || is_starting.get()
                                on_click=Callback::new(move |_: web_sys::MouseEvent| on_confirm.run(()))
                                variant={if is_hidden.get() { ButtonVariant::Danger } else { ButtonVariant::Primary }}
                            >
                                {brand::copy::ADMIN_BATCH_FILTER_CONFIRM}
                            </Button>
                        </div>
                    </div>
                })
            }}
        </Modal>
    }
}

// 清理确认弹窗统计格。
#[component]
fn CleanupStatsGrid(pending: Signal<Option<CleanupStats>>) -> impl IntoView {
    view! {
        {move || {
            let stats = pending.get()?;
            Some(view! {
                <dl class="mt-4 grid grid-cols-2 gap-3 rounded-xl bg-surface-2 p-3">
                    <div>
                        <dt class="text-xs text-muted">{brand::copy::ADMIN_CLEANUP_MEMORIES}</dt>
                        <dd class="text-sm">{stats.memories}</dd>
                    </div>
                    <div>
                        <dt class="text-xs text-muted">{brand::copy::ADMIN_CLEANUP_REMOTE_INDEXES}</dt>
                        <dd class="text-sm">{stats.remote_file_indexes}</dd>
                    </div>
                    <div>
                        <dt class="text-xs text-muted">{brand::copy::ADMIN_CLEANUP_SCAN_TASKS}</dt>
                        <dd class="text-sm">{stats.scan_tasks}</dd>
                    </div>
                    <div>
                        <dt class="text-xs text-muted">{brand::copy::ADMIN_CLEANUP_BYTES}</dt>
                        <dd class="text-sm">{format_bytes_admin(stats.estimated_bytes_to_free)}</dd>
                    </div>
                </dl>
            })
        }}
    }
}

fn status_is_matched(file: &crate::api::types::MemoryCardFile) -> bool {
    // MemoryCardFile 不含同步状态字段:云就绪以远程 ready 为口径。
    file.remote_state == "ready"
}

fn total_page(page: u32) -> u32 {
    page
}
