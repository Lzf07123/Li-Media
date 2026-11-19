// API 类型:对齐 lib/api.ts 中的后端响应结构(serde 命名 snake_case 直通)。
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct MemoryCounts {
    #[serde(default)]
    pub photo: u32,
    #[serde(default)]
    pub video: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MemoryCardFile {
    pub id: String,
    pub filename: String,
    pub remote_state: String,
    pub thumbnail_state: String,
    pub stream_state: String,
    pub browser_compatibility: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MemorySummaryListResponse {
    pub items: Vec<MemorySummary>,
    pub total: u32,
    pub page: u32,
    pub page_size: u32,
    pub counts: MemoryCounts,
    pub public_counts: MemoryCounts,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PublicMediaCounts {
    pub total: u32,
    pub photo: u32,
    pub video: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PublicPreheatStatusResponse {
    pub status: String,
    pub processed: u32,
    pub total: u32,
}
