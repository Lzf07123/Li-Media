// lucide-react 图标的内联 SVG 版本(迁移指南:取 lucide 对应 path 数据,
// 可简写为最小 path)。class 参数对齐 React 侧 className。
use leptos::prelude::*;

/// lucide 默认 24x24 描边 SVG;调用方通过 class 控制尺寸(如 size-8)。
fn icon_svg(class: &'static str, body: impl IntoView) -> impl IntoView {
    view! {
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            width="24"
            height="24"
            aria-hidden="true"
            class=class
        >
            {body}
        </svg>
    }
}

/// lucide "image"。
pub fn icon_image(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
        },
    )
}

/// lucide "images"。
pub fn icon_images(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <path d="M18 22H4a2 2 0 0 1-2-2V6" />
            <path d="m22 13-1.3-1.3a2.4 2.4 0 0 0-3.4 0L11 18" />
            <circle cx="12" cy="8" r="2" />
            <rect x="6" y="2" width="16" height="16" rx="2" />
        },
    )
}

/// lucide "play"。
pub fn icon_play(class: &'static str) -> impl IntoView {
    icon_svg(class, view! { <polygon points="6 3 20 12 6 21 6 3" /> })
}

/// lucide "video"。
pub fn icon_video(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <path d="m22 8-6 4 6 4V8Z" />
            <rect x="2" y="6" width="14" height="12" rx="2" ry="2" />
        },
    )
}

/// lucide "rotate-ccw"。
pub fn icon_rotate_ccw(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
        },
    )
}

/// lucide "pause"。
pub fn icon_pause(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <rect x="14" y="4" width="4" height="16" rx="1" />
            <rect x="6" y="4" width="4" height="16" rx="1" />
        },
    )
}

/// lucide "x"。
pub fn icon_x(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
        },
    )
}

/// lucide "chevron-left"。
pub fn icon_chevron_left(class: &'static str) -> impl IntoView {
    icon_svg(class, view! { <path d="m15 18-6-6 6-6" /> })
}

/// lucide "chevron-right"。
pub fn icon_chevron_right(class: &'static str) -> impl IntoView {
    icon_svg(class, view! { <path d="m9 18 6-6-6-6" /> })
}

/// lucide "search"。
pub fn icon_search(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
        },
    )
}

/// lucide "refresh-cw"。
pub fn icon_refresh_cw(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M3 21v-5h5" />
        },
    )
}

/// lucide "orbit"。
pub fn icon_orbit(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <circle cx="12" cy="12" r="3" />
            <circle cx="19" cy="5" r="2" />
            <circle cx="5" cy="19" r="2" />
            <path d="M10.4 21.9a10 10 0 0 0 9.941-15.416" />
            <path d="M13.5 2.1a10 10 0 0 0-9.841 15.416" />
        },
    )
}

/// lucide "download"。
pub fn icon_download(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <path d="M12 15V3" />
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="m7 10 5 5 5-5" />
        },
    )
}

/// lucide "link-2"。
pub fn icon_link_2(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <path d="M9 17H7A5 5 0 0 1 7 7h2" />
            <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
            <line x1="8" x2="16" y1="12" y2="12" />
        },
    )
}

/// lucide "triangle-alert"。
pub fn icon_triangle_alert(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
        },
    )
}

/// lucide "clock"。
pub fn icon_clock(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <path d="M12 6v6l4 2" />
            <circle cx="12" cy="12" r="10" />
        },
    )
}

/// lucide "ratio"。
pub fn icon_ratio(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <rect x="6" y="2" width="12" height="20" rx="2" />
            <rect x="2" y="6" width="20" height="12" rx="2" />
        },
    )
}

/// lucide "chevron-down"。
pub fn icon_chevron_down(class: &'static str) -> impl IntoView {
    icon_svg(class, view! { <path d="m6 9 6 6 6-6" /> })
}

/// lucide "chevron-up"。
pub fn icon_chevron_up(class: &'static str) -> impl IntoView {
    icon_svg(class, view! { <path d="m18 15-6-6-6 6" /> })
}

/// lucide "layout-grid"。
pub fn icon_layout_grid(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
        },
    )
}

/// lucide "circle-check"。
pub fn icon_circle_check(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <circle cx="12" cy="12" r="10" />
            <path d="m9 12 2 2 4-4" />
        },
    )
}

/// lucide "circle-alert"。
pub fn icon_circle_alert(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <circle cx="12" cy="12" r="10" />
            <line x1="12" x2="12" y1="8" y2="12" />
            <line x1="12" x2="12.01" y1="16" y2="16" />
        },
    )
}

/// lucide "file-question"。
pub fn icon_file_question(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <path d="M12 17h.01" />
            <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
            <path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3" />
        },
    )
}

// ---- 仪表盘分区图标(lucide) ----

/// lucide "server"。
pub fn icon_server(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
            <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
            <line x1="6" x2="6.01" y1="6" y2="6" />
            <line x1="6" x2="6.01" y1="18" y2="18" />
        },
    )
}

/// lucide "hard-drive"。
pub fn icon_hard_drive(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <line x1="22" x2="2" y1="12" y2="12" />
            <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
            <line x1="6" x2="6.01" y1="16" y2="16" />
            <line x1="10" x2="10.01" y1="16" y2="16" />
        },
    )
}

/// lucide "activity"。
pub fn icon_activity(class: &'static str) -> impl IntoView {
    icon_svg(class, view! { <path d="M22 12h-4l-3 9L9 6l-3 9H2" /> })
}

/// lucide "gauge"。
pub fn icon_gauge(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <path d="m12 14 4-4" />
            <path d="M3.34 19a10 10 0 1 1 17.32 0" />
        },
    )
}

/// lucide "layers"。
pub fn icon_layers(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
            <path d="M22 17.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
            <path d="M22 12.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
        },
    )
}

/// lucide "sliders-horizontal"。
pub fn icon_sliders_horizontal(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <line x1="21" x2="14" y1="4" y2="4" />
            <line x1="10" x2="3" y1="4" y2="4" />
            <line x1="21" x2="12" y1="12" y2="12" />
            <line x1="8" x2="3" y1="12" y2="12" />
            <line x1="21" x2="16" y1="20" y2="20" />
            <line x1="12" x2="3" y1="20" y2="20" />
            <line x1="14" x2="14" y1="2" y2="6" />
            <line x1="8" x2="8" y1="10" y2="14" />
            <line x1="16" x2="16" y1="18" y2="22" />
        },
    )
}

/// lucide "flame"。
pub fn icon_flame(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
        },
    )
}

/// lucide "database"。
pub fn icon_database(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M3 5V19A9 3 0 0 0 21 19V5" />
            <path d="M3 12A9 3 0 0 0 21 12" />
        },
    )
}

/// lucide "eye"。
pub fn icon_eye(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
            <circle cx="12" cy="12" r="3" />
        },
    )
}

/// lucide "eye-off"。
pub fn icon_eye_off(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
            <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
            <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
            <path d="m2 2 20 20" />
        },
    )
}

/// lucide "trash-2"。
pub fn icon_trash(class: &'static str) -> impl IntoView {
    icon_svg(
        class,
        view! {
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            <line x1="10" x2="10" y1="11" y2="17" />
            <line x1="14" x2="14" y1="11" y2="17" />
        },
    )
}
