// API 类型:对齐 lib/api.ts 中的后端响应结构(serde 命名 snake_case 直通)。
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct MemoryCounts {
    #[serde(default)]
    pub photo: u32,
    #[serde(default)]
    pub video: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemoryCardFile {
    #[serde(default)]
    pub id: String,
    // 来源(baidupan 等):后台「重试远程」入口以它判断。
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
    pub remote_state: String,
    #[serde(default)]
    pub thumbnail_state: String,
    #[serde(default)]
    pub stream_state: String,
    // 测试 mock 与旧后端响应都可能缺省该字段:兼容性未知按 unknown 兜底。
    #[serde(default = "default_browser_compatibility")]
    pub browser_compatibility: String,
    // ---- 以下字段仅后台列表响应提供;公开列表 mock 缺省 → 空值兜底 ----
    #[serde(default)]
    pub remote_path: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub thumbnail_failure_kind: Option<String>,
    #[serde(default)]
    pub browser_compatibility_error: Option<String>,
    #[serde(default)]
    pub last_synced_at: Option<String>,
    #[serde(default)]
    pub sync_error: Option<String>,
}

fn default_browser_compatibility() -> String {
    "unknown".to_string()
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemorySummary {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub kind: String,
    pub status: String,
    #[serde(default = "default_excluded")]
    pub media_display_state: String,
    #[serde(default = "default_excluded")]
    pub public_display_state: String,
    #[serde(default)]
    pub captured_at: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub thumbnail_path: Option<String>,
    #[serde(default)]
    pub duration_seconds: Option<u32>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub primary_file: Option<MemoryCardFile>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub file_url: String,
    #[serde(default)]
    pub thumbnail_url: Option<String>,
}

fn default_excluded() -> String {
    "excluded".to_string()
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemorySummaryListResponse {
    #[serde(default)]
    pub items: Vec<MemorySummary>,
    #[serde(default)]
    pub total: u32,
    #[serde(default)]
    pub page: u32,
    #[serde(default)]
    pub page_size: u32,
    #[serde(default)]
    pub counts: MemoryCounts,
    #[serde(default)]
    pub public_counts: MemoryCounts,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PublicMediaCounts {
    #[serde(default)]
    pub total: u32,
    #[serde(default)]
    pub photo: u32,
    #[serde(default)]
    pub video: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PublicPreheatStatusResponse {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub processed: u32,
    #[serde(default)]
    pub total: u32,
}
