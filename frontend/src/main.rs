// 入口:CSR 挂载(对齐原 main.tsx)。
mod api;
mod app;
mod brand;
mod components;
mod pages;

use leptos::mount::mount_to_body;

fn main() {
    console_error_panic_hook::set_once();
    mount_to_body(app::App);
}
