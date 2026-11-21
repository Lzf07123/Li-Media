// 系统状态仪表盘:逐分区对齐 AdminStatusDashboard.tsx。
// SystemStatus 以 JSON 树承载,按分区读取关键字段渲染。
use leptos::prelude::*;
use serde_json::Value;

use crate::api::admin::SystemStatus;
use crate::brand::{self, Brand};
use crate::components::ui::button::{Button, ButtonVariant};
use crate::components::ui::icons;
use crate::components::ui::progress_bar::{ProgressBar, ProgressBarTone};
use crate::components::ui::status_dot::{StatusDot, StatusDotTone};
use crate::lib::format::{format_bytes, format_date_time};

// ---- JSON 取值助手 ----

fn jget<'a>(root: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = root;
    for key in path {
        current = current.get(key)?;
    }
    Some(current)
}

fn jstr(root: &Value, path: &[&str]) -> Option<String> {
    jget(root, path)
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

fn jnum(root: &Value, path: &[&str]) -> Option<f64> {
    jget(root, path).and_then(|v| v.as_f64())
}

fn jbool(root: &Value, path: &[&str]) -> Option<bool> {
    jget(root, path).and_then(|v| v.as_bool())
}

fn num_or_dash(value: Option<f64>) -> String {
    value
        .map(|v| {
            if v.fract() == 0.0 && v.abs() < 1e15 {
                format!("{}", v as i64)
            } else {
                format!("{}", v)
            }
        })
        .unwrap_or_else(|| "-".to_string())
}

fn bytes_or_dash(value: Option<f64>) -> String {
    value
        .and_then(|v| if v >= 0.0 { Some(v as u64) } else { None })
        .and_then(|v| format_bytes(Some(v)))
        .unwrap_or_else(|| "-".to_string())
}

fn failure_kind_label(kind: &str) -> String {
    let label = match kind {
        "unclassified" => brand::copy::admin_thumbnail_failure_reasons::UNCLASSIFIED,
        "unknown" => brand::copy::admin_thumbnail_failure_reasons::UNKNOWN,
        "disk_quota" => brand::copy::admin_thumbnail_failure_reasons::DISK_QUOTA,
        "remote_auth" => brand::copy::admin_thumbnail_failure_reasons::REMOTE_AUTH,
        "remote_forbidden" => brand::copy::admin_thumbnail_failure_reasons::REMOTE_FORBIDDEN,
        "remote_not_found" => brand::copy::admin_thumbnail_failure_reasons::REMOTE_NOT_FOUND,
        "baidu_rate_limited" => brand::copy::admin_thumbnail_failure_reasons::BAIDU_RATE_LIMITED,
        "remote_unavailable" => brand::copy::admin_thumbnail_failure_reasons::REMOTE_UNAVAILABLE,
        "cancelled" => brand::copy::admin_thumbnail_failure_reasons::CANCELLED,
        "source_truncated" => brand::copy::admin_thumbnail_failure_reasons::SOURCE_TRUNCATED,
        "temporary_empty" => brand::copy::admin_thumbnail_failure_reasons::TEMPORARY_EMPTY,
        "timeout" => brand::copy::admin_thumbnail_failure_reasons::TIMEOUT,
        "format_unsupported" => brand::copy::admin_thumbnail_failure_reasons::FORMAT_UNSUPPORTED,
        "mov_moov" => brand::copy::admin_thumbnail_failure_reasons::MOV_MOOV,
        "codec_unsupported" => brand::copy::admin_thumbnail_failure_reasons::CODEC_UNSUPPORTED,
        "temporary_io" => brand::copy::admin_thumbnail_failure_reasons::TEMPORARY_IO,
        other => return other.to_string(),
    };
    label.to_string()
}

fn preheat_status_label(status: &str) -> String {
    match status {
        "queued" => brand::copy::ADMIN_PREHEAT_QUEUED.to_string(),
        "running" => brand::copy::ADMIN_PREHEAT_RUNNING.to_string(),
        "completed" => brand::copy::ADMIN_PREHEAT_COMPLETED.to_string(),
        "cancelled" => brand::copy::ADMIN_PREHEAT_CANCELLED.to_string(),
        "failed" => brand::copy::ADMIN_PREHEAT_FAILED.to_string(),
        other => other.to_string(),
    }
}

fn format_cooldown(seconds: f64) -> String {
    if seconds <= 0.0 {
        return brand::copy::ADMIN_PREHEAT_HEALTH_COOLDOWN_OFF.to_string();
    }
    format!(
        "{} {}",
        (seconds / 60.0).round() as i64,
        brand::copy::ADMIN_MINUTES_UNIT
    )
}

fn format_download_timeout(seconds: f64) -> String {
    if seconds >= 60.0 {
        format!(
            "{} {}",
            (seconds / 60.0).round() as i64,
            brand::copy::ADMIN_MINUTES_UNIT
        )
    } else {
        format!("{} {}", seconds as i64, brand::copy::ADMIN_SECONDS_UNIT)
    }
}

// ---- 局部视图构件(对齐 Metric / ServiceMetric / SectionHeader / QueueMetric) ----

#[component]
fn Metric(label: String, value: String) -> impl IntoView {
    view! {
        <div class="flex min-w-0 items-baseline justify-between gap-3">
            <dt class="shrink-0 text-xs text-muted">{label}</dt>
            <dd class="min-w-0 text-right text-sm font-medium">{value}</dd>
        </div>
    }
}

#[component]
fn ServiceMetric(label: String, status_value: Option<String>) -> impl IntoView {
    let ok = status_value.as_deref() == Some("ok") || status_value.is_none();
    let tone = if ok { StatusDotTone::Connected } else { StatusDotTone::Invalid };
    let label_text = if ok {
        brand::copy::ADMIN_STATUS_HEALTHY.to_string()
    } else {
        brand::copy::ADMIN_STATUS_UNAVAILABLE.to_string()
    };
    view! {
        <div class="flex min-w-0 items-center justify-between gap-3">
            <dt class="shrink-0 text-xs text-muted">{label}</dt>
            <dd class="inline-flex min-w-0 items-center gap-2 text-right text-sm font-medium">
                <StatusDot tone=tone />
                {label_text}
            </dd>
        </div>
    }
}

#[component]
fn SectionHeader(title: String, id: String, icon_class: &'static str) -> impl IntoView {
    view! {
        <div class="flex h-6 items-center gap-2">
            <span aria-hidden="true" class={format!("size-4 shrink-0 text-primary {}", icon_class)}>
                {icon_class_content(icon_class)}
            </span>
            <h3 class="truncate text-sm font-semibold" id=id>
                {title}
            </h3>
        </div>
    }
}

fn icon_class_content(icon_class: &str) -> impl IntoView {
    match icon_class {
        "hard-drive" => icons::icon_hard_drive("size-4 shrink-0").into_any(),
        "activity" => icons::icon_activity("size-4 shrink-0").into_any(),
        "gauge" => icons::icon_gauge("size-4 shrink-0").into_any(),
        "layers" => icons::icon_layers("size-4 shrink-0").into_any(),
        "sliders" => icons::icon_sliders_horizontal("size-4 shrink-0").into_any(),
        "flame" => icons::icon_flame("size-4 shrink-0").into_any(),
        "database" => icons::icon_database("size-4 shrink-0").into_any(),
        _ => icons::icon_server("size-4 shrink-0").into_any(),
    }
}

#[component]
fn QueueMetric(
    label: String,
    queue: Value,
    completed: f64,
    rejected: f64,
) -> impl IntoView {
    let active = num_or_dash(jnum(&queue, &["active"]));
    let limit = num_or_dash(jnum(&queue, &["limit"]));
    let queued = num_or_dash(jnum(&queue, &["queued"]));
    let queue_limit = num_or_dash(jnum(&queue, &["queue_limit"]));
    view! {
        <div class="min-w-0">
            <div class="flex min-w-0 items-baseline justify-between gap-3">
                <dt class="shrink-0 text-xs text-muted">{label}</dt>
                <dd class="min-w-0 text-right text-sm font-medium">
                    {format!("{}/{} · {}/{}", active, limit, queued, queue_limit)}
                </dd>
            </div>
            <p class="mt-1 text-right text-xs text-muted">
                {format!(
                    "{} {} · {} {}",
                    brand::copy::ADMIN_QUEUE_COMPLETED,
                    num_or_dash(Some(completed)),
                    brand::copy::ADMIN_QUEUE_REJECTED,
                    num_or_dash(Some(rejected)),
                )}
            </p>
        </div>
    }
}

#[component]
pub fn AdminStatusDashboard(
    status: Signal<Option<SystemStatus>>,
    is_refreshing: Signal<bool>,
    on_refresh: Callback<()>,
) -> impl IntoView {
    view! {
        <div class="card mt-4 p-4">
            <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 class="text-lg font-semibold">{brand::copy::ADMIN_STATUS_TITLE}</h2>
                    <p class="mt-1 text-sm text-muted">{brand::copy::ADMIN_STATUS_DESCRIPTION}</p>
                </div>
                <div class="flex items-center gap-3">
                    <span class="text-xs text-muted">
                        {move || {
                            format!(
                                "{}: {}",
                                brand::copy::ADMIN_STATUS_GENERATED_AT,
                                status
                                    .get()
                                    .map(|s| s.generated_at)
                                    .and_then(|value| format_date_time(Some(value.as_str())))
                                    .unwrap_or_else(|| "-".to_string())
                            )
                        }}
                    </span>
                    <Button
                        disabled=move || is_refreshing.get()
                        on_click=Callback::new(move |_: web_sys::MouseEvent| on_refresh.run(()))
                        variant=ButtonVariant::Secondary
                    >
                        {move || {
                            if is_refreshing.get() {
                                brand::copy::ADMIN_STATUS_REFRESHING.to_string()
                            } else {
                                brand::copy::ADMIN_STATUS_REFRESH.to_string()
                            }
                        }}
                    </Button>
                </div>
            </div>

            {move || {
                let Some(data) = status.get() else {
                    return view! {
                        <div aria-hidden="true" class="shimmer mt-4 h-44 rounded-xl"></div>
                    }
                    .into_any();
                };

                // ---- 分区数据预读(一次读齐,闭包内不再追踪信号) ----
                let backend = &data.backend;
                let database_status = jstr(backend, &["database", "status"]);
                let redis_status = jstr(backend, &["redis", "status"]);
                let runtime = format!(
                    "{} · {}",
                    jstr(backend, &["python_version"]).unwrap_or_else(|| "-".to_string()),
                    jstr(backend, &["platform"]).unwrap_or_else(|| "-".to_string()),
                );
                let thread_pool = num_or_dash(jnum(backend, &["task_thread_pool_size"]));

                let remote = &data.remote_storage;
                let authorized = jbool(remote, &["authorized"]);
                let counts = jget(remote, &["counts"]).cloned().unwrap_or(Value::Null);
                let n = |path: &[&str]| jnum(&counts, path);
                let total = n(&["total"]);
                let remote_ready = n(&["remote_ready"]);
                let remote_missing = n(&["remote_missing"]);
                let remote_failed = n(&["remote_failed"]);
                let thumbnail_ready = n(&["thumbnail_ready"]);
                let thumbnail_retryable = n(&["thumbnail_retryable"]);
                let thumbnail_failed = n(&["thumbnail_failed"]);
                let home_ready = n(&["home_derivative_ready"]);
                let detail_ready = n(&["detail_derivative_ready"]);
                let detail_total = n(&["detail_derivative_total"]);
                let stream_failed = n(&["stream_failed"]);
                let failure_kinds = jget(&counts, &["thumbnail_failure_kinds"])
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();

                let resources = &data.resources;
                let memory_current = jnum(resources, &["cgroup", "memory_current_bytes"]);
                let memory_limit = jnum(resources, &["cgroup", "memory_max_bytes"])
                    .or_else(|| jnum(resources, &["limits", "backend_memory_bytes"]));
                let memory_ratio = memory_current
                    .zip(memory_limit)
                    .and_then(|(c, l)| if l > 0.0 { Some(c / l) } else { None });
                let filesystem_ratio = jnum(resources, &["filesystem", "usage_ratio"]);
                let filesystem_tone = if filesystem_ratio.map(|r| r >= 0.9).unwrap_or(false) {
                    ProgressBarTone::Danger
                } else if filesystem_ratio.map(|r| r >= 0.8).unwrap_or(false) {
                    ProgressBarTone::Warning
                } else {
                    ProgressBarTone::Primary
                };
                let temp_files = jnum(resources, &["temporary", "files"]);
                let temp_bytes = jnum(resources, &["temporary", "bytes"]);
                let temp_quota = jnum(resources, &["limits", "temp_disk_quota_bytes"]);
                let temp_ratio = temp_bytes
                    .zip(temp_quota)
                    .and_then(|(b, q)| if q > 0.0 { Some(b / q) } else { None });
                let disk_used = jnum(resources, &["filesystem", "used_bytes"]);
                let disk_total = jnum(resources, &["filesystem", "total_bytes"]);
                let active_jobs = jnum(&data.metrics, &["active_jobs"]);
                let oom_kill = jnum(resources, &["cgroup", "oom_kill"]);
                let threads = jnum(resources, &["process", "threads"]);
                let gc = jget(resources, &["garbage_collection"]);
                let gen0 = num_or_dash(gc.and_then(|g| jnum(g, &["gen0"])));
                let gen1 = num_or_dash(gc.and_then(|g| jnum(g, &["gen1"])));
                let gen2 = num_or_dash(gc.and_then(|g| jnum(g, &["gen2"])));
                let registry_paths = jnum(resources, &["temporary_registry", "paths"]);
                let pids_current = jnum(resources, &["cgroup", "pids_current"]);
                let queue_depth = jnum(&data.metrics, &["queue_depth"]);

                let caches = jget(resources, &["caches"]);
                let cache_rows: Vec<(&'static str, String, String, String)> = [
                    ("derived_thumbnails", brand::copy::ADMIN_CACHE_DERIVED),
                    ("temporary", brand::copy::ADMIN_CACHE_TEMPORARY),
                    ("nginx", brand::copy::ADMIN_CACHE_NGINX),
                ]
                .into_iter()
                .map(|(key, label)| {
                    let files = num_or_dash(caches.and_then(|c| jnum(c, &[key, "files"])));
                    let bytes = bytes_or_dash(caches.and_then(|c| jnum(c, &[key, "bytes"])));
                    let cache_status = caches
                        .and_then(|c| jstr(c, &[key, "status"]))
                        .unwrap_or_default();
                    let status_text = match cache_status.as_str() {
                        "unavailable" => brand::copy::ADMIN_CACHE_UNAVAILABLE.to_string(),
                        "truncated" => brand::copy::ADMIN_CACHE_TRUNCATED.to_string(),
                        "timeout" => brand::copy::ADMIN_CACHE_TIMEOUT.to_string(),
                        _ => String::new(),
                    };
                    (key, label.to_string(), format!("{} {} · {}", files, brand::copy::ADMIN_CACHE_FILES, bytes), status_text)
                })
                .collect();

                let configuration = jget(backend, &["configuration"]).cloned().unwrap_or(Value::Null);
                let c = |path: &[&str]| jnum(&configuration, path);
                let preheat_concurrency = format!(
                    "{} / {}",
                    num_or_dash(c(&["preheat_concurrency_limit"])),
                    num_or_dash(c(&["preheat_queue_limit"])),
                );
                let cooldown = format_cooldown(c(&["preheat_retry_cooldown_seconds"]).unwrap_or(0.0));
                let download_timeout =
                    format_download_timeout(c(&["source_download_timeout_seconds"]).unwrap_or(0.0));
                let derivative = format!(
                    "{} / {}",
                    num_or_dash(c(&["derivative_concurrency_limit"])),
                    num_or_dash(c(&["derivative_queue_limit"])),
                );
                let direct_probe = format!(
                    "{} / {}",
                    num_or_dash(c(&["direct_probe_concurrency_limit"])),
                    num_or_dash(c(&["direct_probe_queue_limit"])),
                );
                let scan_limit = num_or_dash(c(&["scan_concurrency_limit"]));
                let stream_limits = format!(
                    "{} / {}",
                    num_or_dash(c(&["stream_global_concurrency_limit"])),
                    num_or_dash(c(&["stream_user_concurrency_limit"])),
                );
                let temp_limits = format!(
                    "{} / {}",
                    num_or_dash(c(&["temp_max_files"])),
                    bytes_or_dash(c(&["temp_disk_quota_bytes"])),
                );

                let preheat_health = if data.preheat.is_object() {
                    data.preheat.clone()
                } else {
                    Value::Null
                };
                let history_jobs = jnum(&preheat_health, &["history_jobs"]).unwrap_or(0.0);
                let last_status = jstr(&preheat_health, &["last_status"]);
                let success_rate = jnum(&preheat_health, &["recent_success_rate"]).unwrap_or(1.0);
                let recent_generated = jnum(&preheat_health, &["recent_generated"]);
                let recent_cached = jnum(&preheat_health, &["recent_cached"]);
                let recent_failed = jnum(&preheat_health, &["recent_failed"]);

                let tasks = data.tasks.as_object().cloned().unwrap_or_default();
                let queue_rows: Vec<(String, Value, f64, f64)> = tasks
                    .into_iter()
                    .map(|(key, queue)| {
                        let label = match key.as_str() {
                            "scan" => brand::copy::ADMIN_QUEUE_SCAN.to_string(),
                            "direct_probe" => brand::copy::ADMIN_QUEUE_DIRECT_PROBE.to_string(),
                            "derivative" => brand::copy::ADMIN_QUEUE_DERIVATIVE.to_string(),
                            "preheat" => brand::copy::ADMIN_QUEUE_PREHEAT.to_string(),
                            "stream" => brand::copy::ADMIN_QUEUE_STREAM.to_string(),
                            other => other.to_string(),
                        };
                        let completed = jnum(&data.metrics, &[&format!("{}.completed", key)]).unwrap_or(0.0);
                        let rejected = jnum(&data.metrics, &[&format!("{}.rejected", key)]).unwrap_or(0.0);
                        (label, queue, completed, rejected)
                    })
                    .collect();

                view! {
                    <div class="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        <section aria-labelledby="backend-stack-status">
                            <SectionHeader
                                icon_class="server"
                                id="backend-stack-status".to_string()
                                title=brand::copy::ADMIN_BACKEND_TITLE.to_string()
                            />
                            <dl class="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                                <ServiceMetric label=brand::copy::ADMIN_BACKEND_API.to_string() status_value=Some("ok".to_string()) />
                                <ServiceMetric label=brand::copy::ADMIN_BACKEND_DATABASE.to_string() status_value=database_status />
                                <ServiceMetric label=brand::copy::ADMIN_BACKEND_REDIS.to_string() status_value=redis_status />
                                <ServiceMetric label=brand::copy::ADMIN_BACKEND_GOVERNOR.to_string() status_value=Some("ok".to_string()) />
                                <Metric label=brand::copy::ADMIN_BACKEND_RUNTIME.to_string() value=runtime />
                                <Metric label=brand::copy::ADMIN_BACKEND_THREAD_POOL.to_string() value=thread_pool />
                            </dl>
                        </section>

                        <section aria-labelledby="remote-storage-status">
                            <SectionHeader
                                icon_class="hard-drive"
                                id="remote-storage-status".to_string()
                                title=brand::copy::ADMIN_REMOTE_STORAGE_TITLE.to_string()
                            />
                            <dl class="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                                <Metric
                                    label=brand::copy::ADMIN_REMOTE_STORAGE_PROVIDER.to_string()
                                    value=brand::copy::ADMIN_REMOTE_STORAGE_BAIDU.to_string()
                                />
                                <Metric
                                    label=brand::copy::ADMIN_REMOTE_STORAGE_AUTHORIZED.to_string()
                                    value={if authorized == Some(true) { brand::copy::ADMIN_STATUS_AUTHORIZED.to_string() } else { brand::copy::ADMIN_STATUS_NOT_AUTHORIZED.to_string() } }
                                />
                                <Metric label=brand::copy::ADMIN_REMOTE_STORAGE_INDEXED.to_string() value=num_or_dash(total) />
                                <Metric label=brand::copy::ADMIN_REMOTE_STORAGE_READY.to_string() value=num_or_dash(remote_ready) />
                                <Metric label=brand::copy::ADMIN_REMOTE_STORAGE_MISSING.to_string() value=num_or_dash(remote_missing) />
                                <Metric label=brand::copy::ADMIN_REMOTE_STORAGE_FAILED.to_string() value=num_or_dash(remote_failed) />
                                <Metric label=brand::copy::ADMIN_REMOTE_STORAGE_PREVIEW_READY.to_string() value=num_or_dash(thumbnail_ready) />
                                <Metric label=brand::copy::ADMIN_REMOTE_STORAGE_PREVIEW_RETRYABLE.to_string() value=num_or_dash(thumbnail_retryable) />
                                <Metric label=brand::copy::ADMIN_REMOTE_STORAGE_PREVIEW_FAILED.to_string() value=num_or_dash(thumbnail_failed) />
                                <Metric
                                    label=brand::copy::ADMIN_DERIVATIVE_HOME.to_string()
                                    value=format!("{}/{}", num_or_dash(home_ready), num_or_dash(detail_total))
                                />
                                <Metric
                                    label=brand::copy::ADMIN_DERIVATIVE_DETAIL.to_string()
                                    value=format!("{}/{}", num_or_dash(detail_ready), num_or_dash(detail_total))
                                />
                                <Metric
                                    label=brand::copy::ADMIN_REMOTE_STORAGE_STREAM_FAILED.to_string()
                                    value=num_or_dash(stream_failed)
                                />
                            </dl>
                            {(!failure_kinds.is_empty()).then(|| {
                                let rows: Vec<_> = failure_kinds
                                    .iter()
                                    .map(|(kind, count)| {
                                        let label = failure_kind_label(kind);
                                        view! {
                                            <p class="text-xs text-muted">
                                                {format!("{}: {}", label, num_or_dash(count.as_f64()))}
                                            </p> } })
                                    .collect();
                                view! {
                                    <div class="mt-3 space-y-1">
                                        <p class="text-xs font-medium text-muted">
                                            {brand::copy::ADMIN_SCAN_FAILURE}
                                        </p>
                                        {rows}
                                    </div>
                                }
                            })}
                        </section>

                        <section aria-labelledby="resource-queue-status">
                            <SectionHeader
                                icon_class="activity"
                                id="resource-queue-status".to_string()
                                title=brand::copy::ADMIN_RESOURCE_TITLE.to_string()
                            />
                            <div class="mt-3 space-y-3">
                                {filesystem_ratio.map(|ratio| {
                                    view! {
                                        <ProgressBar
                                            label=brand::copy::ADMIN_RESOURCE_FILESYSTEM.to_string()
                                            tone=filesystem_tone
                                            value=ratio * 100.0
                                        />
                                    }
                                })}
                                {memory_current.zip(memory_limit).map(|(current, limit)| {
                                    view! {
                                        <ProgressBar
                                            label=brand::copy::ADMIN_RESOURCE_MEMORY.to_string()
                                            tone={if memory_ratio.map(|r| r >= 0.8).unwrap_or(false) { ProgressBarTone::Danger } else { ProgressBarTone::Primary } }
                                            value={memory_ratio.unwrap_or(0.0) * 100.0}
                                        />
                                    }
                                })}
                                <dl class="space-y-2">
                                    <Metric
                                        label=brand::copy::ADMIN_RESOURCE_MEMORY.to_string()
                                        value=format!("{} / {}", bytes_or_dash(memory_current), bytes_or_dash(memory_limit))
                                    />
                                    <Metric
                                        label=brand::copy::ADMIN_RESOURCE_TEMP.to_string()
                                        value=format!(
                                            "{} / {}",
                                            num_or_dash(temp_files),
                                            num_or_dash(temp_quota),
                                        )
                                    />
                                    <Metric
                                        label=brand::copy::ADMIN_RESOURCE_DISK.to_string()
                                        value=format!("{} / {}", bytes_or_dash(disk_used), bytes_or_dash(disk_total))
                                    />
                                    <Metric
                                        label=brand::copy::ADMIN_RESOURCE_ACTIVE_JOBS.to_string()
                                        value=num_or_dash(active_jobs)
                                    />
                                    <Metric
                                        label=brand::copy::ADMIN_RESOURCE_OOM.to_string()
                                        value=num_or_dash(oom_kill)
                                    />
                                </dl>
                                {temp_ratio.map(|ratio| {
                                    view! {
                                        <ProgressBar
                                            label=brand::copy::ADMIN_RESOURCE_TEMP.to_string()
                                            tone={if ratio >= 0.8 { ProgressBarTone::Danger } else { ProgressBarTone::Primary } }
                                            value={ratio * 100.0}
                                        />
                                    }
                                })}
                            </div>
                        </section>
                    </div>

                    <div class="mt-5 grid gap-5 sm:grid-cols-2 xl:grid-cols-5">
                        <section aria-labelledby="workload-status">
                            <SectionHeader
                                icon_class="gauge"
                                id="workload-status".to_string()
                                title=brand::copy::ADMIN_WORKLOAD_TITLE.to_string()
                            />
                            <dl class="mt-3 space-y-2">
                                <Metric label=brand::copy::ADMIN_RESOURCE_THREADS.to_string() value=num_or_dash(threads) />
                                <Metric
                                    label=brand::copy::ADMIN_RESOURCE_GARBAGE_COLLECTION.to_string()
                                    value=format!("{}/{}/{}", gen0, gen1, gen2)
                                />
                                <Metric
                                    label=brand::copy::ADMIN_RESOURCE_TEMPORARY_REGISTRY.to_string()
                                    value=num_or_dash(registry_paths)
                                />
                                <Metric label=brand::copy::ADMIN_RESOURCE_PIDS.to_string() value=num_or_dash(pids_current) />
                                <Metric
                                    label=brand::copy::ADMIN_RESOURCE_ACTIVE_JOBS.to_string()
                                    value=num_or_dash(active_jobs)
                                />
                                <Metric
                                    label=brand::copy::ADMIN_RESOURCE_QUEUE_DEPTH.to_string()
                                    value=num_or_dash(queue_depth)
                                />
                            </dl>
                        </section>

                        <section aria-labelledby="cache-status">
                            <SectionHeader
                                icon_class="layers"
                                id="cache-status".to_string()
                                title=brand::copy::ADMIN_CACHE_TITLE.to_string()
                            />
                            <dl class="mt-3 space-y-2">
                                {cache_rows.into_iter().map(|(_key, label, value, status_text)| {
                                    view! {
                                        <div>
                                            <div class="flex min-w-0 items-baseline justify-between gap-3">
                                                <dt class="shrink-0 text-xs text-muted">{label}</dt>
                                                <dd class="min-w-0 text-right text-sm font-medium">{value}</dd>
                                            </div>
                                            {(!status_text.is_empty()).then(|| {
                                                view! { <p class="text-right text-xs text-muted">{status_text}</p> }
                                            })}
                                        </div>
                                    }
                                }).collect_view()}
                            </dl>
                        </section>

                        <section aria-labelledby="resource-configuration-status">
                            <SectionHeader
                                icon_class="sliders"
                                id="resource-configuration-status".to_string()
                                title=brand::copy::ADMIN_CONFIGURATION_TITLE.to_string()
                            />
                            <dl class="mt-3 space-y-2">
                                <Metric
                                    label=brand::copy::ADMIN_CONFIG_PREHEAT_CONCURRENCY.to_string()
                                    value=preheat_concurrency
                                />
                                <Metric
                                    label=brand::copy::ADMIN_CONFIG_RETRY_COOLDOWN.to_string()
                                    value=cooldown
                                />
                                <Metric
                                    label=brand::copy::ADMIN_CONFIG_DOWNLOAD_TIMEOUT.to_string()
                                    value=download_timeout
                                />
                                <Metric
                                    label=brand::copy::ADMIN_CONFIG_DERIVATIVE.to_string()
                                    value=derivative
                                />
                                <Metric
                                    label=brand::copy::ADMIN_CONFIG_DIRECT_PROBE.to_string()
                                    value=direct_probe
                                />
                                <Metric label=brand::copy::ADMIN_CONFIG_SCAN.to_string() value=scan_limit />
                                <Metric
                                    label=brand::copy::ADMIN_CONFIG_STREAM_GLOBAL.to_string()
                                    value=stream_limits
                                />
                                <Metric label=brand::copy::ADMIN_CONFIG_TEMP.to_string() value=temp_limits />
                            </dl>
                        </section>

                        <section aria-labelledby="preheat-health-status">
                            <SectionHeader
                                icon_class="flame"
                                id="preheat-health-status".to_string()
                                title=brand::copy::ADMIN_PREHEAT_HEALTH_TITLE.to_string()
                            />
                            {(history_jobs == 0.0).then(|| {
                                view! {
                                    <p class="mt-3 text-xs text-muted">
                                        {brand::copy::ADMIN_PREHEAT_HEALTH_NO_HISTORY}
                                    </p>
                                }
                            })}
                            {(history_jobs > 0.0).then(|| {
                                view! {
                                    <dl class="mt-3 space-y-2">
                                        <Metric
                                            label=brand::copy::ADMIN_PREHEAT_HEALTH_LAST_STATUS.to_string()
                                            value=last_status
                                                .map(|status| preheat_status_label(&status))
                                                .unwrap_or_else(|| "-".to_string())
                                        />
                                        <Metric
                                            label=brand::copy::ADMIN_PREHEAT_HEALTH_SUCCESS_RATE.to_string()
                                            value=format!("{}%", (success_rate * 100.0).round() as i64)
                                        />
                                        <Metric
                                            label=brand::copy::ADMIN_PREHEAT_GENERATED.to_string()
                                            value=num_or_dash(recent_generated)
                                        />
                                        <Metric
                                            label=brand::copy::ADMIN_PREHEAT_CACHED.to_string()
                                            value=num_or_dash(recent_cached)
                                        />
                                        <Metric
                                            label=brand::copy::ADMIN_PREHEAT_FAILED_COUNT.to_string()
                                            value=num_or_dash(recent_failed)
                                        />
                                        <Metric
                                            label=brand::copy::ADMIN_PREHEAT_HEALTH_HISTORY.to_string()
                                            value=num_or_dash(Some(history_jobs))
                                        />
                                    </dl>
                                }
                            })}
                        </section>

                        <section aria-labelledby="task-queue-status">
                            <SectionHeader
                                icon_class="database"
                                id="task-queue-status".to_string()
                                title=brand::copy::ADMIN_QUEUE_TITLE.to_string()
                            />
                            <dl class="mt-3 space-y-2">
                                {queue_rows.into_iter().map(|(label, queue, completed, rejected)| {
                                    view! { <QueueMetric completed=completed label=label queue=queue rejected=rejected /> }
                                }).collect_view()}
                            </dl>
                        </section>
                    </div>
                }
                .into_any()
            }}
        </div>
    }
}
