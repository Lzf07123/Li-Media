// 百度网盘接入引导卡:对齐 BaiduSetupCard.tsx。
use leptos::prelude::*;

use crate::brand::{self, Brand};
use crate::components::ui::badge::{Badge, BadgeTone};
use crate::components::ui::button::{Button, ButtonVariant};
use crate::lib::format::format_date_time;

#[component]
pub fn BaiduSetupCard(
    configured: Signal<bool>,
    authorized: Signal<bool>,
    docs_url: Signal<String>,
    is_authorizing: Signal<bool>,
    oauth_configured: Signal<bool>,
    on_authorize: Callback<()>,
    redirect_uri: Signal<String>,
    scan_dir: Signal<String>,
    token_expires_at: Signal<Option<String>>,
) -> impl IntoView {
    let steps = [
        brand::copy::ADMIN_REMOTE_GUIDE_CREATE_APP.to_string(),
        brand::copy::ADMIN_REMOTE_GUIDE_TOKEN.to_string(),
        brand::copy::ADMIN_REMOTE_GUIDE_DIRECTORY.to_string(),
        brand::copy::ADMIN_REMOTE_GUIDE_SCAN.to_string(),
    ];

    let badge_tone = {
        if authorized.get() {
            BadgeTone::Success
        } else if configured.get() {
            BadgeTone::Warning
        } else {
            BadgeTone::Muted
        }
    };
    let badge_text = if authorized.get() {
        brand::copy::ADMIN_REMOTE_AUTHORIZED.to_string()
    } else if configured.get() {
        brand::copy::ADMIN_REMOTE_CREDENTIAL_CONFIGURED.to_string()
    } else {
        brand::copy::ADMIN_REMOTE_CREDENTIAL_MISSING.to_string()
    };

    view! {
        <aside aria-labelledby="baidu-setup-title" class="card mt-6 p-6">
            <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 class="text-lg font-semibold" id="baidu-setup-title">
                        {brand::copy::ADMIN_REMOTE_GUIDE_TITLE}
                    </h2>
                    <p class="mt-2 text-sm text-muted">{brand::copy::ADMIN_REMOTE_GUIDE_DESCRIPTION}</p>
                </div>
                <Badge tone={badge_tone}>{badge_text}</Badge>
            </div>

            <ol class="mt-5 grid gap-3">
                {steps.into_iter().enumerate().map(|(index, text)| {
                    view! {
                        <li class="flex items-start gap-3">
                            <span
                                aria-hidden="true"
                                class="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 text-primary"
                            >
                                {format!("{}", index + 1)}
                            </span>
                            <span class="min-w-0 text-sm leading-6">
                                <span class="sr-only">{format!("{}. ", index + 1)}</span>
                                {text}
                            </span>
                        </li>
                    }
                }).collect_view()}
            </ol>

            <div class="mt-5 flex flex-wrap items-center justify-between gap-3">
                <div class="grid min-w-0 gap-2">
                    <p class="min-w-0 text-sm">
                        <span class="text-muted">{brand::copy::ADMIN_REMOTE_SCAN_DIR_LABEL}{": "}</span>
                        <code class="break-all">{scan_dir.get()}</code>
                    </p>
                    <p class="min-w-0 text-sm">
                        <span class="text-muted">{brand::copy::ADMIN_REMOTE_REDIRECT_LABEL}{": "}</span>
                        <code class="break-all">{redirect_uri.get()}</code>
                    </p>
                    <p class="min-w-0 text-sm">
                        <span class="text-muted">{brand::copy::ADMIN_REMOTE_TOKEN_EXPIRY}{": "}</span>
                        {move || {
                            token_expires_at
                                .get()
                                .and_then(|t| format_date_time(Some(t.as_str())))
                                .unwrap_or_else(|| brand::copy::ADMIN_REMOTE_NEVER_EXPIRES.to_string())
                        }}
                    </p>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                    <Button disabled=move || is_authorizing.get() on_click=Callback::new(move |_: web_sys::MouseEvent| on_authorize.run(())) variant={if authorized.get() { ButtonVariant::Secondary } else { ButtonVariant::Primary }}>
                        {move || if is_authorizing.get() {
                            brand::copy::ADMIN_REMOTE_AUTHORIZING.to_string()
                        } else {
                            brand::copy::ADMIN_REMOTE_AUTHORIZE.to_string()
                        }}
                    </Button>
                    <a
                        class="inline-flex min-h-11 items-center gap-2 text-primary"
                        href={docs_url.get()}
                        rel="noreferrer"
                        target="_blank"
                    >
                        {brand::copy::ADMIN_REMOTE_GUIDE_DOCS}
                    </a>
                </div>
            </div>

            {move || (!configured.get()).then(|| {
                view! {
                    <p class="mt-3 flex items-start gap-2 text-sm text-muted">
                        {brand::copy::ADMIN_REMOTE_CREDENTIAL_HINT.to_string()}
                    </p>
                }
            })}
            {move || (!oauth_configured.get() && configured.get()).then(|| {
                view! {
                    <p class="mt-3 flex items-start gap-2 text-sm text-muted">
                        {brand::copy::ADMIN_REMOTE_OAUTH_MISSING.to_string()}
                    </p>
                }
            })}
        </aside>
    }
}
