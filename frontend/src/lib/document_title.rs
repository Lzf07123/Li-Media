// document.title 同步(逐语义对齐 lib/useDocumentTitle.ts):
// 路由与查看器内容变化时同步标题,保证分享卡片与浏览器历史条目可区分。
use leptos::prelude::*;

pub fn use_document_title(title: impl Fn() -> String + 'static) {
    Effect::new(move || {
        let title = title();
        if let Some(document) = web_sys::window().and_then(|window| window.document()) {
            document.set_title(&title);
        }
    });
}
