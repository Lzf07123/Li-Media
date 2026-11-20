// 系统状态仪表盘:对齐 AdminStatusDashboard.tsx 的分区与类名。
// SystemStatus 以 JSON 树承载,此处按分区渲染关键字段。
use leptos::prelude::*;

use crate::brand::{self, Brand};
use crate::api::admin::SystemStatus;
use crate::components::ui::button::{Button, ButtonVariant};

#[component]
pub fn AdminStatusDashboard(
    status: Signal<Option<SystemStatus>>,
    is_refreshing: Signal<bool>,
    on_refresh: Callback<()>,
) -> impl IntoView {
    let status_for_backend = status.clone();
    let status_for_redis = status.clone();
    let status_for_version = status.clone();
    let status_for_compliant = status.clone();
    let status_for_render = status.clone();
    let backend_status = move || {
        status_for_backend.get().and_then(|s| {
            s.backend.get("database").and_then(|d| d.get("status")).and_then(|v| v.as_str()).map(str::to_string)
        })
    };
    let redis_status = move || {
        status_for_redis.get().and_then(|s| {
            s.backend.get("redis").and_then(|d| d.get("status")).and_then(|v| v.as_str()).map(str::to_string)
        })
    };
    let app_version = move || {
        status_for_version.get().and_then(|s| {
            s.backend.get("version").and_then(|v| v.as_str()).map(str::to_string)
        })
    };
    let compliant = move || {
        status_for_compliant.get().and_then(|s| {
            s.source_zero.get("compliant").and_then(|v| v.as_bool())
        })
    };

    view! {
        <section aria-labelledby="status-title" class="card mt-6 p-6">
            <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 class="text-lg font-semibold" id="status-title">
                        {brand::copy::ADMIN_STATUS_TITLE}
                    </h2>
                    <p class="mt-2 text-sm text-muted">{brand::copy::ADMIN_STATUS_DESCRIPTION}</p>
                </div>
                <Button disabled=move || is_refreshing.get() on_click=Callback::new(move |_| on_refresh.run(())) variant=ButtonVariant::Secondary>
                    {if is_refreshing.get() {
                        brand::copy::ADMIN_STATUS_REFRESHING.to_string()
                    } else {
                        brand::copy::ADMIN_STATUS_REFRESH.to_string()
                    }}
                </Button>
            </div>

            {move || status_for_render.get().map(|s| {
                let _ = &s;
                let database = backend_status().unwrap_or_else(|| "unknown".to_string());
                let redis = redis_status().unwrap_or_else(|| "unknown".to_string());
                let version = app_version().unwrap_or_else(|| "-".to_string());
                let compliant_text = compliant()
                    .map(|ok| if ok {
                        brand::copy::ADMIN_STATUS_COMPLIANT.to_string()
                    } else {
                        brand::copy::ADMIN_STATUS_NON_COMPLIANT.to_string()
                    })
                    .unwrap_or_else(|| "-".to_string());
                view! {
                    <dl class="mt-4 grid gap-3 sm:grid-cols-2">
                        <div class="rounded-lg border border-border p-3">
                            <dt class="text-xs text-muted">{brand::copy::ADMIN_STATUS_APP}</dt>
                            <dd class="mt-1 text-sm">{version}</dd>
                        </div>
                        <div class="rounded-lg border border-border p-3">
                            <dt class="text-xs text-muted">{brand::copy::ADMIN_STATUS_DATABASE}</dt>
                            <dd class="mt-1 text-sm">{database}</dd>
                        </div>
                        <div class="rounded-lg border border-border p-3">
                            <dt class="text-xs text-muted">{brand::copy::ADMIN_STATUS_REDIS}</dt>
                            <dd class="mt-1 text-sm">{redis}</dd>
                        </div>
                        <div class="rounded-lg border border-border p-3">
                            <dt class="text-xs text-muted">{brand::copy::ADMIN_STATUS_SOURCE_ZERO}</dt>
                            <dd class="mt-1 text-sm">{compliant_text}</dd>
                        </div>
                    </dl>
                }
            })}
            {move || status.get().is_none().then(|| view! {
                <p class="mt-4 text-sm text-muted">{brand::copy::ADMIN_STATUS_EMPTY}</p>
            })}
        </section>
    }
}
