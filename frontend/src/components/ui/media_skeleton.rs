// MediaSkeleton(对齐 components/ui/MediaSkeleton.tsx):尺寸解析链
// 内存真实 items → 构图缓存 → 多样比例兜底;列分配与真实画布同一
// 最短列算法,骨架→卡片零位移。
use leptos::prelude::*;

use crate::lib::canvas_composition::{
    distribute_masonry_columns, read_canvas_composition, CompositionSize,
};
use super::icons::icon_image;

/// 首次访问(内存与构图缓存都无尺寸)的兜底比例:接近真实照片库分布。
const FALLBACK_RATIOS: [(u32, u32); 6] = [(4, 5), (3, 4), (1, 1), (4, 3), (3, 4), (5, 4)];

fn ratio_for(known_sizes: &[CompositionSize], index: usize) -> String {
    if let Some(known) = known_sizes.get(index) {
        return format!("{} / {}", known.width, known.height);
    }
    let (width, height) = FALLBACK_RATIOS[index % FALLBACK_RATIOS.len()];
    format!("{} / {}", width, height)
}

fn ratio_value(known_sizes: &[CompositionSize], index: usize) -> f64 {
    if let Some(known) = known_sizes.get(index) {
        return known.height / known.width;
    }
    let (width, height) = FALLBACK_RATIOS[index % FALLBACK_RATIOS.len()];
    height as f64 / width as f64
}

#[component]
pub fn MediaSkeleton(
    #[prop(into)] column_count: Signal<usize>,
    #[prop(default = 18)] count: usize,
    /// 已知真实尺寸(当前内存 items):优先于构图缓存,筛选/换批零位移。
    /// 响应式传入:骨架在画布闭包内同步渲染,信号化避免画布闭包因
    /// 尺寸更新而整段重建(卡片队列任务被 abort 再重发)。
    #[prop(optional, into)] sizes: Signal<Vec<CompositionSize>>,
) -> impl IntoView {
    let known_sizes = Memo::new(move |_| {
        let sizes = sizes.get();
        if !sizes.is_empty() {
            sizes
        } else {
            read_canvas_composition().items
        }
    });

    view! {
        <div aria-label="loading" aria-live="polite" class="masonry" data-testid="media-skeleton">
            {move || {
                let known_sizes = known_sizes.get();
                let indices: Vec<usize> = (0..count).collect();
                let columns = distribute_masonry_columns(&indices, column_count.get(), |index| {
                    ratio_value(&known_sizes, *index)
                });
                columns
                .into_iter()
                .map(|column| {
                    let tiles = column
                        .into_iter()
                        .map(|index| {
                            let ratio = ratio_for(&known_sizes, index);
                            view! {
                                <div class="post-card overflow-hidden">
                                    <div
                                        class="media-frame card-shimmer"
                                        data-skeleton-ratio={ratio.clone()}
                                        style={format!("aspect-ratio: {}", ratio)}
                                    >
                                        <div class="media-placeholder">
                                            {icon_image("size-8 opacity-40")}
                                        </div>
                                    </div>
                                </div>
                            }
                            .into_view()
                        })
                        .collect_view();
                    view! { <div class="canvas-column">{tiles}</div> }
                })
                .collect_view()
            }}
        </div>
    }
}

