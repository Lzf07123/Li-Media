// 数值与时间格式化(对齐 lib/format.ts)。日期沿用 Intl.DateTimeFormat
// 的 zh-CN 输出,保证与 React 版逐字符一致。
use wasm_bindgen::{JsCast, JsValue};

/// 字节数格式化:1024 以下原样带单位,其余按 KB/MB/GB/TB 逐级换算
/// (对齐 formatBytes)。
pub fn format_bytes(bytes: Option<u64>) -> Option<String> {
    let bytes = bytes?;
    if bytes < 1024 {
        return Some(format!("{} {}", bytes, crate::brand::copy::BYTES));
    }

    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    let mut value = bytes as f64 / 1024.0;
    let mut unit_index = 0usize;

    while value >= 1024.0 && unit_index < UNITS.len() - 1 {
        value /= 1024.0;
        unit_index += 1;
    }

    let decimals = if value >= 10.0 { 0 } else { 1 };
    Some(format!("{:.*} {}", decimals, value, UNITS[unit_index]))
}

/// 时长格式化:h:mm:ss 或 m:ss(对齐 formatDuration)。
pub fn format_duration(seconds: Option<u32>) -> Option<String> {
    let seconds = seconds?;
    let hours = seconds / 3600;
    let minutes = (seconds % 3600) / 60;
    let remaining_seconds = seconds % 60;

    if hours > 0 {
        Some(format!("{}:{}:{}", hours, pad2(minutes), pad2(remaining_seconds)))
    } else {
        Some(format!("{}:{}", minutes, pad2(remaining_seconds)))
    }
}

fn pad2(value: u32) -> String {
    format!("{:02}", value)
}

/// 经 globalThis.Intl.DateTimeFormat("zh-CN", options) 格式化,
/// 与 React toLocaleString("zh-CN", ...) 完全同源。
fn format_with_date_time_format(value: &str, options: &[(&str, &str)]) -> Option<String> {
    let window = web_sys::window()?;
    let global: JsValue = window.into();
    let intl = js_sys::Reflect::get(&global, &JsValue::from_str("Intl")).ok()?;
    let ctor = js_sys::Reflect::get(&intl, &JsValue::from_str("DateTimeFormat")).ok()?;
    let ctor: js_sys::Function = ctor.dyn_into().ok()?;

    let opts = js_sys::Object::new();
    for (key, val) in options {
        let _ = js_sys::Reflect::set(&opts, &JsValue::from_str(key), &JsValue::from_str(val));
    }
    let args = js_sys::Array::from_iter([
        JsValue::from_str("zh-CN"),
        JsValue::from(opts),
    ]);
    let formatter = js_sys::Reflect::construct(ctor.as_ref(), &args).ok()?;
    let format_fn = js_sys::Reflect::get(&formatter, &JsValue::from_str("format")).ok()?;
    let format_fn: js_sys::Function = format_fn.dyn_into().ok()?;

    let date = js_sys::Date::new(&JsValue::from_str(value));
    if date.get_time().is_nan() {
        return None;
    }
    format_fn.call1(&formatter, &date).ok()?.as_string()
}

/// 日期时间(对齐 formatDateTime:年/月/日 时:分,两位数字)。
pub fn format_date_time(value: Option<&str>) -> Option<String> {
    let value = value?;
    format_with_date_time_format(
        value,
        &[
            ("year", "numeric"),
            ("month", "2-digit"),
            ("day", "2-digit"),
            ("hour", "2-digit"),
            ("minute", "2-digit"),
        ],
    )
}

/// 日期(对齐 formatDate:y年M月d日,月份取 Intl long 文案)。
pub fn format_date(value: Option<&str>) -> Option<String> {
    let value = value?;
    format_with_date_time_format(
        value,
        &[("year", "numeric"), ("month", "long"), ("day", "numeric")],
    )
}
