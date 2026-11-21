// 后台表格徽章(对齐 StatusBadge.tsx / RemoteStateBadge.tsx / FileStatusBadge.tsx)。
use leptos::prelude::*;

use crate::brand::copy;
use crate::components::ui::badge::{Badge, BadgeTone};

fn status_copy(status: &str) -> String {
    match status {
        "pending" => copy::STATUS_PENDING.to_string(),
        "draft" => copy::STATUS_DRAFT.to_string(),
        "published" => copy::STATUS_PUBLISHED.to_string(),
        "hidden" => copy::STATUS_HIDDEN.to_string(),
        "error" => copy::STATUS_ERROR.to_string(),
        _ => status.to_string(),
    }
}

fn status_tone(status: &str) -> BadgeTone {
    match status {
        "published" => BadgeTone::Success,
        "pending" => BadgeTone::Warning,
        "draft" | "hidden" => BadgeTone::Muted,
        "error" => BadgeTone::Danger,
        _ => BadgeTone::Muted,
    }
}

/// 记忆状态徽章(对齐 StatusBadge.tsx)。
#[component]
pub fn StatusBadge(status: String) -> impl IntoView {
    let text = status_copy(&status);
    let tone = status_tone(&status);
    view! { <Badge tone=tone>{text}</Badge> }
}

fn file_status_copy(status: &str) -> String {
    match status {
        "discovered" => copy::FILE_DISCOVERED.to_string(),
        "pending" => copy::FILE_PENDING.to_string(),
        "syncing" => copy::FILE_SYNCING.to_string(),
        "matched" => copy::FILE_MATCHED.to_string(),
        "missing" => copy::FILE_MISSING.to_string(),
        "removed" => copy::FILE_REMOVED.to_string(),
        "failed" => copy::FILE_FAILED.to_string(),
        _ => status.to_string(),
    }
}

fn file_status_tone(status: &str) -> BadgeTone {
    match status {
        "matched" => BadgeTone::Success,
        "discovered" | "pending" => BadgeTone::Warning,
        "syncing" => BadgeTone::Primary,
        "missing" | "failed" => BadgeTone::Danger,
        "removed" => BadgeTone::Muted,
        _ => BadgeTone::Muted,
    }
}

/// 文件同步状态徽章(对齐 FileStatusBadge.tsx)。
#[component]
pub fn FileStatusBadge(status: String) -> impl IntoView {
    let text = file_status_copy(&status);
    let tone = file_status_tone(&status);
    view! { <Badge tone=tone>{text}</Badge> }
}

fn remote_state_copy(kind: &str, state: &str) -> String {
    match (kind, state) {
        ("remote", "unverified") => copy::ADMIN_REMOTE_UNVERIFIED.to_string(),
        ("remote", "ready") => copy::ADMIN_REMOTE_READY.to_string(),
        ("remote", "missing") => copy::ADMIN_REMOTE_MISSING.to_string(),
        ("remote", "failed") => copy::ADMIN_REMOTE_FAILED.to_string(),
        ("thumbnail", "missing") => copy::ADMIN_THUMBNAIL_MISSING.to_string(),
        ("thumbnail", "ready") => copy::ADMIN_THUMBNAIL_READY.to_string(),
        ("thumbnail", "retryable") => copy::ADMIN_THUMBNAIL_RETRYABLE.to_string(),
        ("thumbnail", "failed") => copy::ADMIN_THUMBNAIL_FAILED.to_string(),
        ("stream", "unavailable") => copy::ADMIN_STREAM_UNAVAILABLE.to_string(),
        ("stream", "ready") => copy::ADMIN_STREAM_READY.to_string(),
        ("stream", "failed") => copy::ADMIN_STREAM_FAILED.to_string(),
        (_, "ready") => copy::ADMIN_REMOTE_READY.to_string(),
        (_, "failed") => copy::ADMIN_REMOTE_FAILED.to_string(),
        (_, "missing") => copy::ADMIN_REMOTE_MISSING.to_string(),
        (_, other) => other.to_string(),
    }
}

fn remote_state_tone(state: &str) -> BadgeTone {
    match state {
        "ready" => BadgeTone::Success,
        "unverified" | "retryable" => BadgeTone::Warning,
        "missing" | "unavailable" => BadgeTone::Muted,
        "failed" => BadgeTone::Danger,
        _ => BadgeTone::Muted,
    }
}

/// 远端/派生/流状态徽章(kind: remote | thumbnail | stream,对齐 RemoteStateBadge.tsx)。
#[component]
pub fn RemoteStateBadge(kind: String, state: String) -> impl IntoView {
    let text = remote_state_copy(&kind, &state);
    let tone = remote_state_tone(&state);
    view! { <Badge tone=tone>{text}</Badge> }
}
