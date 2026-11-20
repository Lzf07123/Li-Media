// admin API 客户端:对齐 lib/api.ts 的 admin 系列函数(登录/列表/批量/
// 同步/预热/探测/清理/导出)。类型见 types.rs 与本文件局部定义。
use serde::{Deserialize, Serialize};

use super::{get, post, request, ApiError};
use super::types::*;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct MemoryAdminListResponse {
    #[serde(default)]
    pub items: Vec<MemorySummary>,
    #[serde(default)]
    pub total: u32,
    #[serde(default)]
    pub display_counts: DisplayCounts,
    #[serde(default)]
    pub filtered_display_counts: DisplayCounts,
    #[serde(default)]
    pub global_counts: MemoryCounts,
    #[serde(default)]
    pub status_counts: StatusCounts,
    #[serde(default)]
    pub filtered_status_counts: StatusCounts,
    #[serde(default)]
    pub browser_counts: BrowserCounts,
    #[serde(default)]
    pub filtered_browser_counts: BrowserCounts,
    #[serde(default)]
    pub page: u32,
    #[serde(default)]
    pub page_size: u32,
    #[serde(default)]
    pub counts: MemoryCounts,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct DisplayCounts {
    #[serde(default)]
    pub displayable: u32,
    #[serde(default)]
    pub excluded: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct StatusCounts {
    #[serde(default)]
    pub published: u32,
    #[serde(default)]
    pub unpublished: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct BrowserCounts {
    #[serde(default)]
    pub supported: u32,
    #[serde(default)]
    pub unsupported: u32,
    #[serde(default)]
    pub unknown: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RemoteConfig {
    pub configured: bool,
    pub oauth_configured: bool,
    pub authorized: bool,
    pub scan_dir: String,
    pub redirect_uri: String,
    pub docs_url: String,
    #[serde(default)]
    pub token_expires_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RemoteScanTask {
    pub id: String,
    pub remote_dir: String,
    pub status: String,
    pub max_depth: u32,
    pub max_items: u32,
    pub delete_missing: bool,
    pub processed_items: u32,
    pub scanned_files: u32,
    pub scanned_directories: u32,
    pub discovered: u32,
    pub refreshed: u32,
    pub skipped: u32,
    #[serde(default)]
    pub limit_reached: bool,
    #[serde(default)]
    pub failure_reason: Option<String>,
    pub started_at: String,
    #[serde(default)]
    pub completed_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SyncResponse {
    pub discovered: u32,
    pub matched: u32,
    pub deleted: u32,
    pub failed: u32,
    pub scan_task: RemoteScanTask,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CleanupStats {
    pub memories: u32,
    pub remote_file_indexes: u32,
    pub scan_tasks: u32,
    pub thumbnail_files: u32,
    pub nginx_cache_files: u32,
    pub estimated_bytes_to_free: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CleanupResult {
    pub dry_run: bool,
    pub stats: CleanupStats,
    #[serde(default)]
    pub duration_seconds: f64,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub file_cleanup_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SystemStatus {
    pub generated_at: String,
    pub backend: serde_json::Value,
    pub remote_storage: serde_json::Value,
    pub source_zero: serde_json::Value,
    pub preheat: serde_json::Value,
    pub tasks: serde_json::Value,
    pub metrics: serde_json::Value,
    pub resources: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ThumbnailPreheatJob {
    pub id: String,
    pub sizes: Vec<u32>,
    #[serde(default)]
    pub kind: Option<String>,
    pub limit: u32,
    pub concurrency: u32,
    pub queue_limit: u32,
    #[serde(default)]
    pub include_failed: bool,
    pub status: String,
    pub total: u32,
    pub processed: u32,
    pub generated: u32,
    pub cached: u32,
    pub failed: u32,
    #[serde(default)]
    pub skipped: u32,
    pub source_bytes_downloaded: u64,
    pub derivative_duration_ms: u64,
    #[serde(default)]
    pub size_results: serde_json::Value,
    #[serde(default)]
    pub message: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AdminBackgroundJob {
    pub id: String,
    pub action: String,
    pub status: String,
    #[serde(default)]
    pub filter_snapshot: serde_json::Value,
    #[serde(default)]
    pub resource_ids: Vec<String>,
    #[serde(default)]
    pub total: u32,
    #[serde(default)]
    pub processed: u32,
    #[serde(default)]
    pub changed: u32,
    #[serde(default)]
    pub skipped: u32,
    #[serde(default)]
    pub failed: u32,
    #[serde(default)]
    pub error_message: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BatchPreviewResponse {
    #[serde(default)]
    pub filter_snapshot: serde_json::Value,
    #[serde(default)]
    pub total: u32,
    #[serde(default)]
    pub counts: MemoryCounts,
    #[serde(default)]
    pub status_counts: StatusCounts,
    #[serde(default)]
    pub display_counts: DisplayCounts,
    #[serde(default)]
    pub browser_counts: BrowserCounts,
    #[serde(default)]
    pub is_full_library: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BatchUpdateResponse {
    pub changed: u32,
    pub skipped: u32,
    pub updated: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExportResponse {
    pub exported_at: String,
    pub items: Vec<MemorySummary>,
    pub total: u32,
}

#[derive(Clone, Debug, Default)]
pub struct AdminMemoryQuery {
    pub keyword: Option<String>,
    pub kind: Option<String>,
    pub display: Option<String>,
    pub compatibility: Option<String>,
    pub status: Option<String>,
    pub page: Option<u32>,
    pub page_size: Option<u32>,
}

impl AdminMemoryQuery {
    fn to_query(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        let mut push = |key: &str, value: &Option<String>| {
            if let Some(v) = value {
                if !v.is_empty() {
                    parts.push(format!(
                        "{}={}",
                        key,
                        js_sys::encode_uri_component(v)
                    ));
                }
            }
        };
        push("keyword", &self.keyword);
        push("kind", &self.kind);
        push("display", &self.display);
        push("compatibility", &self.compatibility);
        push("status", &self.status);
        if let Some(page) = self.page {
            parts.push(format!("page={}", page));
        }
        if let Some(size) = self.page_size {
            parts.push(format!("page_size={}", size));
        }
        if parts.is_empty() {
            String::new()
        } else {
            format!("?{}", parts.join("&"))
        }
    }
}

pub async fn get_admin_memories(params: AdminMemoryQuery) -> Result<MemoryAdminListResponse, ApiError> {
    request(&format!("/admin/memories{}", params.to_query()), "GET", None).await
}

pub async fn login_admin(token: &str) -> Result<(), ApiError> {
    request::<()>(
        "/admin/login",
        "POST",
        Some(format!("{{\"token\":{}}}", serde_json::to_string(token).unwrap_or_default())),
    )
    .await
}

pub async fn logout_admin() -> Result<(), ApiError> {
    request("/admin/logout", "POST", None).await
}

pub async fn sync_memories(
    max_files: u32,
    max_depth: u32,
    max_items: u32,
    delete_missing: bool,
    resume_task_id: Option<String>,
) -> Result<SyncResponse, ApiError> {
    let resume = resume_task_id
        .map(|id| format!("\"resume_task_id\":\"{}\",", id))
        .unwrap_or_default();
    let body = format!(
        "{{{}\"max_files\":{},\"max_depth\":{},\"max_items\":{},\"delete_missing\":{}}}",
        resume, max_files, max_depth, max_items, delete_missing
    );
    post("/admin/sync", body).await
}

pub async fn get_latest_remote_scan() -> Result<Option<RemoteScanTask>, ApiError> {
    get_job_or_null("/admin/remote-scan/latest").await
}

pub async fn get_remote_config() -> Result<RemoteConfig, ApiError> {
    get("/admin/remote-config").await
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BaiduAuthorizeResponse {
    pub authorize_url: String,
    pub expires_at: String,
}

pub async fn start_baidu_authorization() -> Result<BaiduAuthorizeResponse, ApiError> {
    get("/admin/baidu/authorize").await
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BaiduCallbackResponse {
    pub authorized: bool,
    #[serde(default)]
    pub expires_at: Option<String>,
}

pub async fn complete_baidu_authorization(code: &str, state: &str) -> Result<BaiduCallbackResponse, ApiError> {
    let body = format!("{{\"code\":{},\"state\":{}}}",
        serde_json::to_string(code).unwrap_or_default(),
        serde_json::to_string(state).unwrap_or_default());
    post("/admin/baidu/callback", body).await
}

pub async fn get_system_status() -> Result<SystemStatus, ApiError> {
    get("/admin/system/status").await
}

pub async fn start_thumbnail_preheat(
    sizes: &[&str],
    kind: Option<&str>,
    limit: u32,
    include_failed: bool,
) -> Result<ThumbnailPreheatJob, ApiError> {
    let kind_json = kind
        .map(|k| format!("\"{}\"", k))
        .unwrap_or_else(|| "null".to_string());
    let body = format!(
        "{{\"sizes\":{},\"kind\":{},\"limit\":{},\"include_failed\":{}}}",
        serde_json::to_string(sizes).unwrap_or_else(|_| "[\"240\"]".to_string()),
        kind_json,
        limit,
        include_failed
    );
    post("/admin/thumbnails/preheat", body).await
}

pub async fn get_latest_thumbnail_preheat() -> Result<Option<ThumbnailPreheatJob>, ApiError> {
    get_job_or_null("/admin/thumbnails/preheat/latest").await
}

pub async fn preview_thumbnail_preheat() -> Result<u32, ApiError> {
    #[derive(Deserialize)]
    struct Resp {
        #[serde(default)]
        total: u32,
    }
    let resp: Resp = get("/admin/thumbnails/preheat/preview").await?;
    Ok(resp.total)
}

pub async fn cancel_thumbnail_preheat(job_id: &str) -> Result<ThumbnailPreheatJob, ApiError> {
    post(&format!("/admin/thumbnails/preheat/{}/cancel", job_id), "{}".to_string()).await
}

pub async fn start_browser_compatibility_probe(limit: u32) -> Result<AdminBackgroundJob, ApiError> {
    post("/admin/browser-compatibility/probe", format!("{{\"limit\":{}}}", limit)).await
}

pub async fn get_latest_browser_compatibility_probe() -> Result<Option<AdminBackgroundJob>, ApiError> {
    get_job_or_null("/admin/browser-compatibility/probe/latest").await
}

pub async fn cancel_browser_compatibility_probe(job_id: &str) -> Result<AdminBackgroundJob, ApiError> {
    post(&format!("/admin/browser-compatibility/probe/{}/cancel", job_id), "{}".to_string()).await
}

pub async fn preview_batch_status_change(
    kind: Option<&str>,
    keyword: Option<&str>,
    display: &str,
    compatibility: &str,
    status: Option<&str>,
) -> Result<BatchPreviewResponse, ApiError> {
    let body = format!(
        "{{\"kind\":{},\"keyword\":{},\"display\":\"{}\",\"compatibility\":\"{}\",\"status\":{}}}",
        json_or_null(kind),
        json_or_null(keyword),
        display,
        compatibility,
        json_or_null(status)
    );
    post("/admin/memories/batch-preview", body).await
}

pub async fn start_batch_status_change(
    kind: Option<&str>,
    keyword: Option<&str>,
    display: &str,
    compatibility: &str,
    status: Option<&str>,
    target_status: &str,
    confirm: bool,
) -> Result<AdminBackgroundJob, ApiError> {
    let body = format!(
        "{{\"kind\":{},\"keyword\":{},\"display\":\"{}\",\"compatibility\":\"{}\",\"status\":{},\"target_status\":\"{}\",\"confirm\":{}}}",
        json_or_null(kind),
        json_or_null(keyword),
        display,
        compatibility,
        json_or_null(status),
        target_status,
        confirm
    );
    post("/admin/memories/batch-status", body).await
}

pub async fn get_latest_batch_status_job() -> Result<Option<AdminBackgroundJob>, ApiError> {
    get_job_or_null("/admin/memories/batch-status/latest").await
}

pub async fn cancel_batch_status_job(job_id: &str) -> Result<AdminBackgroundJob, ApiError> {
    post(&format!("/admin/memories/batch-status/{}/cancel", job_id), "{}".to_string()).await
}

pub async fn retry_remote_entry(file_id: &str) -> Result<MemorySummary, ApiError> {
    post(&format!("/admin/remote-entries/{}/retry", file_id), "{}".to_string()).await
}

pub async fn request_local_media_cleanup(confirm: bool) -> Result<CleanupResult, ApiError> {
    post("/admin/cleanup", format!("{{\"confirm\":{}}}", confirm)).await
}

pub async fn update_memory(
    id: &str,
    changes: &serde_json::Value,
) -> Result<MemorySummary, ApiError> {
    request(
        &format!("/admin/memories/{}", id),
        "PATCH",
        Some(changes.to_string()),
    )
    .await
}

pub async fn delete_memory(id: &str) -> Result<(), ApiError> {
    request::<()>(
        &format!("/admin/memories/{}", id),
        "DELETE",
        None,
    )
    .await
}

pub async fn batch_update_memories(
    ids: &[String],
    changes: &serde_json::Value,
) -> Result<BatchUpdateResponse, ApiError> {
    let mut payload = changes.clone();
    if let serde_json::Value::Object(ref mut map) = payload {
        map.insert("ids".to_string(), serde_json::json!(ids));
    }
    request(
        "/admin/memories/batch",
        "PATCH",
        Some(payload.to_string()),
    )
    .await
}

pub async fn export_memories(ids: &[String]) -> Result<ExportResponse, ApiError> {
    let payload = serde_json::json!({ "ids": ids });
    post("/admin/memories/export", payload.to_string()).await
}

// ---- 内部助手 ----

async fn get_job_or_null<T: serde::de::DeserializeOwned>(path: &str) -> Result<Option<T>, ApiError> {
    match request::<serde_json::Value>(path, "GET", None).await {
        Ok(value) => {
            if value.is_null() {
                Ok(None)
            } else {
                serde_json::from_value(value)
                    .map(Some)
                    .map_err(|e| ApiError { status: 0, message: format!("响应结构异常: {}", e) })
            }
        }
        Err(e) => Err(e),
    }
}

fn json_or_null(value: Option<&str>) -> String {
    match value {
        Some(v) => serde_json::to_string(v).unwrap_or_else(|_| "null".to_string()),
        None => "null".to_string(),
    }
}

