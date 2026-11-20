// 画布构图缓存(逐语义对齐 lib/canvas-composition.ts):把最近一次真实
// 列表的图像宽高序列持久化到 localStorage,供下次加载/刷新时骨架屏按
// 真实宽高实时计算占位形状——骨架与真实布局同构、零位移。
use serde::{Deserialize, Serialize};

use crate::api::types::MemorySummary;

const STORAGE_KEY: &str = "limedia-canvas-composition";
const MAX_ITEMS: usize = 36;

/// 未知宽高时的瀑布屏比例兜底:接近真实照片库分布(4:5 竖幅)。
pub const FALLBACK_MASONRY_RATIO: f64 = 4.0 / 5.0;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct CompositionSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CanvasComposition {
    /// 首屏精选(画布第一条)的宽高,供 hero 骨架内嵌同比例占位框。
    #[serde(default)]
    pub hero: Option<CompositionSize>,
    #[serde(default)]
    pub items: Vec<CompositionSize>,
}

/// 瀑布屏最短列优先放置:按宽高比估算每列累计高度,每条内容放进当前
/// 最矮的列;同高并列取最左列。骨架屏与画布共用本函数保证占位同构。
pub fn distribute_masonry_columns<T: Clone>(
    items: &[T],
    column_count: usize,
    get_ratio: impl Fn(&T) -> f64,
) -> Vec<Vec<T>> {
    if column_count == 0 {
        return Vec::new();
    }
    let mut columns: Vec<Vec<T>> = (0..column_count).map(|_| Vec::new()).collect();
    let mut heights: Vec<f64> = vec![0.0; column_count];
    for item in items {
        let mut target = 0usize;
        for column in 1..column_count {
            if heights[column] < heights[target] {
                target = column;
            }
        }
        columns[target].push(item.clone());
        heights[target] += get_ratio(item);
    }
    columns
}

fn is_valid_size(size: &CompositionSize) -> bool {
    size.width.is_finite()
        && size.height.is_finite()
        && size.width > 0.0
        && size.height > 0.0
}

fn to_size(memory: &MemorySummary) -> Option<CompositionSize> {
    match (memory.width, memory.height) {
        (Some(width), Some(height)) if width > 0 && height > 0 => Some(CompositionSize {
            width: width as f64,
            height: height as f64,
        }),
        _ => None,
    }
}

fn local_storage() -> Option<web_sys::Storage> {
    web_sys::window()
        .and_then(|window| window.local_storage().ok().flatten())
}

/// 读取构图缓存;隐私模式 / 存储被禁用 / 数据损坏时回退空值。
pub fn read_canvas_composition() -> CanvasComposition {
    let Some(storage) = local_storage() else {
        return CanvasComposition::default();
    };
    let Ok(Some(raw)) = storage.get_item(STORAGE_KEY) else {
        return CanvasComposition::default();
    };
    let Ok(parsed) = serde_json::from_str::<CanvasComposition>(&raw) else {
        return CanvasComposition::default();
    };
    let hero = parsed.hero.filter(is_valid_size);
    let items: Vec<CompositionSize> = parsed
        .items
        .into_iter()
        .filter(is_valid_size)
        .take(MAX_ITEMS)
        .collect();
    CanvasComposition { hero, items }
}

/// 列表数据到达后写入构图缓存(hero 取第一条,与首屏捕获同源)。
pub fn write_canvas_composition(memories: &[MemorySummary]) {
    let sizes: Vec<CompositionSize> = memories
        .iter()
        .take(MAX_ITEMS)
        .filter_map(to_size)
        .collect();
    if sizes.is_empty() {
        return;
    }

    let hero = sizes[0];
    let composition = CanvasComposition {
        hero: Some(hero),
        items: sizes,
    };
    if let Ok(payload) = serde_json::to_string(&composition) {
        if let Some(storage) = local_storage() {
            // 存储不可用时静默放弃,不影响正常渲染。
            let _ = storage.set_item(STORAGE_KEY, &payload);
        }
    }
}
