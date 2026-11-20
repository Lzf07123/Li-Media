// API 层:对齐原 lib/api.ts 的 fetch 封装与 URL 安全校验。
pub mod types;

use serde::de::DeserializeOwned;
use wasm_bindgen::JsValue;

use types::*;

const DEFAULT_REQUEST_TIMEOUT_MS: f64 = 60_000.0;

pub fn api_base_url() -> String {
    // 对齐 import.meta.env.VITE_API_BASE_URL ?? "/api/v1"。
    let value = web_sys::window()
        .and_then(|w| js_sys::Reflect::get(&w, &"__LIMEDIA_API_BASE_URL__".into()).ok())
        .and_then(|v| v.as_string())
        .unwrap_or_default();
    if value.is_empty() {
        "/api/v1".to_string()
    } else {
        value
    }
}

fn is_safe_media_url(url: &str) -> bool {
    // 同源相对路径直接放行;绝对 URL 只允许 http(s),
    // 防止服务端被入侵或配置错误时把 javascript:/data: 注入下载锚点。
    if url.starts_with('/') {
        return true;
    }
    if let Ok(parsed) = web_sys::Url::new(url) {
        let protocol = parsed.protocol();
        return protocol == "https:" || protocol == "http:";
    }
    false
}

pub fn resolve_media_url(path: &str) -> String {
    if path.starts_with("http://") || path.starts_with("https://") {
        return path.to_string();
    }
    let base = api_base_url();
    if !path.starts_with('/') || !base.starts_with("http") {
        return path.to_string();
    }
    match web_sys::Url::new(&base) {
        Ok(parsed) => format!("{}{}", parsed.origin(), path),
        Err(_) => path.to_string(),
    }
}

pub fn resolve_trusted_media_url(path: &str) -> Option<String> {
    if is_safe_media_url(path) {
        Some(resolve_media_url(path))
    } else {
        None
    }
}

pub fn resolve_thumbnail_url(path: Option<&str>, size: &str) -> Option<String> {
    let path = path?;
    let mut url = resolve_media_url(path);
    url.push_str(if url.contains('?') { "&" } else { "?" });
    url.push_str(&format!("ratio=1&size={}", size));
    Some(url)
}

pub fn append_query_param(url: &str, key: &str, value: &str) -> String {
    let separator = if url.contains('?') { "&" } else { "?" };
    format!(
        "{}{}{}={}",
        url,
        separator,
        js_sys::encode_uri_component(key),
        js_sys::encode_uri_component(value)
    )
}

pub fn resolve_thumbnail_src_set(path: Option<&str>) -> Option<String> {
    let path = path?;
    let parts: Vec<String> = ["480", "768", "1280"]
        .iter()
        .filter_map(|size| resolve_thumbnail_url(Some(path), size).map(|u| format!("{} {}w", u, size)))
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(", "))
    }
}

// ---- fetch 封装(对齐 request<T>:credentials include + 60s 超时) ----

#[derive(Debug)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

async fn read_api_error_message(response: &web_sys::Response) -> String {
    match response.json().ok() {
        Some(promise) => match wasm_bindgen_futures::JsFuture::from(promise).await {
            Ok(payload) => {
                let detail = js_sys::Reflect::get(&payload, &"detail".into()).ok();
                if let Some(detail) = detail {
                    if let Some(s) = detail.as_string() {
                        return s;
                    }
                }
                fallback_status_message(response.status())
            }
            Err(_) => fallback_status_message(response.status()),
        },
        None => fallback_status_message(response.status()),
    }
}

fn fallback_status_message(status: u16) -> String {
    match status {
        401 => "登录状态已失效，请重新登录".to_string(),
        404 => "资源不存在".to_string(),
        429 => "请求过于频繁，请稍后重试".to_string(),
        502 => "远程媒体暂时不可用".to_string(),
        _ => format!("请求失败（{}）", status),
    }
}

async fn raw_request(
    path: &str,
    method: &str,
    body: Option<String>,
    accept: &str,
) -> Result<(u16, Option<JsValue>), ApiError> {
    let window = web_sys::window().ok_or_else(|| ApiError {
        status: 0,
        message: "浏览器环境不可用".to_string(),
    })?;
    let base = api_base_url();
    let url = format!("{}{}", base, path);

    let mut init = web_sys::RequestInit::new();
    init.method(method)
        .credentials(web_sys::RequestCredentials::Include)
        .mode(web_sys::RequestMode::SameOrigin);
    let mut headers = web_sys::Headers::new()
        .map_err(|_| ApiError { status: 0, message: "请求头构造失败".to_string() })?;
    headers
        .set("Accept", accept)
        .map_err(|_| ApiError { status: 0, message: "请求头构造失败".to_string() })?;
    if let Some(body) = body {
        headers
            .set("Content-Type", "application/json")
            .map_err(|_| ApiError { status: 0, message: "请求头构造失败".to_string() })?;
        init.body(Some(&JsValue::from_str(&body)));
    }
    init.headers(&headers.into());

    let request =
        web_sys::Request::new_with_str_and_init(&url, &init).map_err(|_| ApiError {
            status: 0,
            message: "请求构造失败".to_string(),
        })?;

    // 60s 超时(对齐 AbortSignal.timeout)。
    if let Some(controller) = web_sys::AbortController::new().ok() {
        init_signal_timeout(&window, &controller, &request);
    }

    let promise = window.fetch_with_request(&request);
    let response = wasm_bindgen_futures::JsFuture::from(promise)
        .await
        .map_err(|_| ApiError {
            status: 0,
            message: "网络请求失败".to_string(),
        })?;
    let response: web_sys::Response = response.into();

    let status = response.status();
    if status == 204 {
        return Ok((status, None));
    }
    if !response.ok() {
        return Err(ApiError {
            status,
            message: read_api_error_message(&response).await,
        });
    }
    let json = response
        .json()
        .map_err(|_| ApiError { status, message: fallback_status_message(status) })?;
    let value = wasm_bindgen_futures::JsFuture::from(json)
        .await
        .map_err(|_| ApiError { status, message: "响应解析失败".to_string() })?;
    Ok((status, Some(value)))
}

fn init_signal_timeout(window: &web_sys::Window, controller: &web_sys::AbortController, request: &web_sys::Request) {
    let controller_value = wasm_bindgen::JsValue::from(controller);
    let callback = js_sys::Function::new_with_args(
        "controllerRef",
        "controllerRef.abort();",
    );
    js_sys::Reflect::set(callback.as_ref(), &"controllerRef".into(), &controller_value).ok();
    // 保存回调引用,避免 GC 后定时器触发失败。
    let _ = js_sys::Reflect::set(
        request.as_ref(),
        &"__limedia_timeout__".into(),
        callback.as_ref(),
    );
    let _ = window.set_timeout_with_callback_and_timeout_and_arguments_0(
        &callback,
        DEFAULT_REQUEST_TIMEOUT_MS as i32,
    );
}

/// 请求并反序列化为 T(对齐 api.ts 的 request<T>)。
pub async fn request<T: DeserializeOwned>(path: &str, method: &str, body: Option<String>) -> Result<T, ApiError> {
    let (_, value) = raw_request(path, method, body, "application/json").await?;
    let value = value.ok_or_else(|| ApiError {
        status: 204,
        message: "响应为空".to_string(),
    })?;
    serde_wasm_bindgen::from_value(value).map_err(|e| ApiError {
        status: 0,
        message: format!("响应结构异常: {}", e),
    })
}

pub async fn get<T: DeserializeOwned>(path: &str) -> Result<T, ApiError> {
    request(path, "GET", None).await
}

pub async fn post<T: DeserializeOwned>(path: &str, body: String) -> Result<T, ApiError> {
    request(path, "POST", Some(body)).await
}

// ---- 具名 API 函数(对齐 api.ts 导出;按需扩展) ----

pub async fn get_memories(
    kind: Option<&str>,
    keyword: Option<&str>,
    sort: Option<&str>,
    seed: Option<&str>,
    page: u32,
    page_size: u32,
) -> Result<MemorySummaryListResponse, ApiError> {
    let mut path = format!("/memories?page={}&page_size={}", page, page_size);
    if let Some(kind) = kind {
        path.push_str(&format!("&kind={}", js_sys::encode_uri_component(kind)));
    }
    if let Some(keyword) = keyword {
        if !keyword.is_empty() {
            path.push_str(&format!("&keyword={}", js_sys::encode_uri_component(keyword)));
        }
    }
    if let Some(sort) = sort {
        path.push_str(&format!("&sort={}", sort));
    }
    if let Some(seed) = seed {
        path.push_str(&format!("&seed={}", seed));
    }
    get(&path).await
}

pub async fn get_public_counts() -> Result<PublicMediaCounts, ApiError> {
    get("/memories/public-counts").await
}

pub async fn get_preheat_status() -> Result<PublicPreheatStatusResponse, ApiError> {
    get("/memories/preheat-status").await
}

pub async fn get_memory_recommendations(limit: u32, kind: Option<&str>) -> Result<Vec<MemorySummary>, ApiError> {
    let mut path = format!("/memories/recommend?limit={}", limit);
    if let Some(kind) = kind {
        path.push_str(&format!("&kind={}", js_sys::encode_uri_component(kind)));
    }
    get(&path).await
}

pub async fn get_memory_by_id(id: &str) -> Result<MemorySummary, ApiError> {
    get(&format!("/memories/{}", js_sys::encode_uri_component(id))).await
}
