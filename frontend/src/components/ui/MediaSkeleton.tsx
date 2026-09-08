import { Image as ImageIcon } from "lucide-react";

const skeletonRatios = [
  "4 / 5",
  "3 / 4",
  "1 / 1",
  "4 / 3",
  "3 / 4",
  "5 / 4",
] as const;

type MediaSkeletonProps = {
  columnCount?: number;
  count?: number;
};

export default function MediaSkeleton({
  columnCount = 2,
  count = 18,
}: MediaSkeletonProps = {}) {
  const columns = Array.from(
    { length: columnCount },
    () => [] as number[],
  );
  Array.from({ length: count }).forEach((_, index) => {
    columns[index % columnCount]?.push(index);
  });

  return (
    <div aria-label="loading" aria-live="polite" className="masonry">
      {columns.map((column, columnIndex) => (
        <div className="canvas-column" key={columnIndex}>
          {column.map((index) => (
            <div className="post-card overflow-hidden" key={index}>
              <div
                className="media-frame card-shimmer"
                style={{ aspectRatio: skeletonRatios[index % skeletonRatios.length] }}
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
