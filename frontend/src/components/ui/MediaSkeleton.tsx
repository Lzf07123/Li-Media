import { Image as ImageIcon } from "lucide-react";

import {
  distributeMasonryColumns,
  readCanvasComposition,
  type CompositionSize,
} from "@/lib/canvas-composition";

// 首次访问（内存与构图缓存都无尺寸）的兜底比例：接近真实照片库分布
const fallbackRatios = [
  [4, 5],
  [3, 4],
  [1, 1],
  [4, 3],
  [3, 4],
  [5, 4],
] as const;

type MediaSkeletonProps = {
  columnCount?: number;
  count?: number;
  /** 已知真实尺寸（当前内存 items）：优先于构图缓存，筛选/换批零位移 */
  sizes?: CompositionSize[];
};

export default function MediaSkeleton({
  columnCount = 2,
  count = 18,
  sizes,
}: MediaSkeletonProps = {}) {
  // 尺寸解析链：内存真实 items → 构图缓存 → 多样比例兜底。
  // 每个骨架瓦都按真实宽高实时计算 aspect-ratio，禁止一整块均色。
  const knownSizes = sizes && sizes.length > 0
    ? sizes
    : readCanvasComposition().items;

  const ratioFor = (index: number): string => {
    const known = knownSizes[index];
    if (known) {
      return `${known.width} / ${known.height}`;
    }
    const [width, height] = fallbackRatios[index % fallbackRatios.length];
    return `${width} / ${height}`;
  };

  // 列分配与真实画布同一最短列算法（distributeMasonryColumns），
  // 骨架→卡片零位移
  const columns = distributeMasonryColumns(
    Array.from({ length: count }, (_, index) => index),
    columnCount,
    (index) => {
      const known = knownSizes[index];
      if (known) {
        return known.height / known.width;
      }
      const [width, height] = fallbackRatios[index % fallbackRatios.length];
      return height / width;
    },
  );

  return (
    <div aria-label="loading" aria-live="polite" className="masonry" data-testid="media-skeleton">
      {columns.map((column, columnIndex) => (
        <div className="canvas-column" key={columnIndex}>
          {column.map((index) => (
            <div className="post-card overflow-hidden" key={index}>
              <div
                className="media-frame card-shimmer"
                data-skeleton-ratio={ratioFor(index)}
                style={{ aspectRatio: ratioFor(index) }}
              >
                <div className="media-placeholder">
                  <ImageIcon aria-hidden="true" className="size-8 opacity-40" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
