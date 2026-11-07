import { Image as ImageIcon, Play, Video } from "lucide-react";
import { useEffect, useState } from "react";

import { brand } from "@/lib/brand";
import { formatDate, formatDuration } from "@/lib/format";
import { appendQueryParam, resolveThumbnailUrl, type MemorySummary } from "@/lib/api";
import { loadQueuedImage } from "@/lib/image-load-queue";

type HeroMosaicProps = {
  /** 首屏捕获的精选回忆（≤5 条，捕获后保持稳定） */
  memories: MemorySummary[];
  /** 首屏列表尚未返回时展示骨架瓦片 */
  loading: boolean;
  onOpen: (memoryId: string) => void;
};

// hero 瓦片放大展示，240px 会糊：主瓦取 768、侧瓦取 480（与查看器
// 共用 detail 派生端点，生成结果进派生缓存；画布卡片仍固定 240）。
function heroThumbnailSize(featured: boolean) {
  return featured ? "768" as const : "480" as const;
}

type TileImageState = "queued" | "ready" | "failed";

function HeroTile({
  memory,
  featured,
  onOpen,
}: {
  memory: MemorySummary;
  featured: boolean;
  onOpen: (memoryId: string) => void;
}) {
  const [loadState, setLoadState] = useState<TileImageState>("queued");
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const thumbnailUrl = resolveThumbnailUrl(memory.thumbnail_url, heroThumbnailSize(featured));
  const requestUrl = retryAttempt > 0 && thumbnailUrl
    ? appendQueryParam(thumbnailUrl, "retry", String(retryAttempt))
    : thumbnailUrl;

  useEffect(() => {
    if (!requestUrl) {
      return;
    }

    const controller = new AbortController();
    setLoadState("queued");
    // hero 位于首屏：队列高优先级，压缩与画布首行卡片抢槽的时间。
    loadQueuedImage(requestUrl, {
      priority: featured ? "high" : "normal",
      retries: 4,
      signal: controller.signal,
    })
      .then(() => {
        if (controller.signal.aborted) {
          return;
        }
        setLoadedUrl(thumbnailUrl);
        setLoadState("ready");
      })
      .catch((error) => {
        if (controller.signal.aborted || error.name === "AbortError") {
          return;
        }
        // 队列已完成 4 次退避重试；再手补 2 次长退避后进入安静降级
        //（低对比图标瓦片，与画布卡片同一失败哲学）。
        if (retryAttempt < 2) {
          window.setTimeout(() => {
            if (!controller.signal.aborted) {
              setRetryAttempt((current) => current + 1);
            }
          }, 4000);
          return;
        }
        setLoadState("failed");
      });

    return () => controller.abort();
  }, [featured, requestUrl, retryAttempt, thumbnailUrl]);

  const accessibleName = memory.title || brand.copy.detailPreviewAlt;
  const captionMeta = [memory.location, formatDate(memory.captured_at)]
    .filter(Boolean)
    .join(" · ");
  const videoDuration = formatDuration(memory.duration_seconds);
  const isVideo = memory.kind === "video";

  return (
    <li className="hero-tile" data-preview-state={loadState}>
      <button
        aria-label={accessibleName}
        className="hero-tile-button"
        onClick={() => onOpen(memory.id)}
        type="button"
      >
        <span aria-hidden="true" className="hero-media">
          {loadState !== "failed" ? (
            <img
              alt=""
              className={`hero-media-img ${loadState === "ready" ? "is-ready" : "is-loading"}`}
              decoding="async"
              fetchPriority={featured ? "high" : "low"}
              loading="eager"
              onError={() => setLoadState("failed")}
              onLoad={() => setLoadState("ready")}
              src={loadedUrl ?? undefined}
            />
          ) : null}
          {loadState !== "ready" ? (
            <span
              className={`media-placeholder media-crossfade is-visible ${
                loadState === "queued" ? "card-shimmer" : ""
              }`}
            >
              {isVideo ? <Play className="size-8 opacity-40" /> : <ImageIcon className="size-8 opacity-40" />}
            </span>
          ) : null}
        </span>
        {isVideo ? (
          <span aria-hidden="true" className="hero-kind-badge">
            <Video className="size-3.5" />
            {videoDuration ? `${brand.copy.videoKind} ${videoDuration}` : brand.copy.videoKind}
          </span>
        ) : null}
        {captionMeta || accessibleName ? (
          // 装饰化文字层：按钮 aria-label 已含完整可读名，避免双重朗读
          <span aria-hidden="true" className="card-caption">
            <span className="card-caption-title">{accessibleName}</span>
            {captionMeta ? (
              <span className="card-caption-meta">{captionMeta}</span>
            ) : null}
          </span>
        ) : null}
      </button>
    </li>
  );
}

export default function HeroMosaic({ memories, loading, onOpen }: HeroMosaicProps) {
  if (loading) {
    return (
      <section aria-label={brand.copy.heroMosaicLabel}>
        <ul className="hero-mosaic" data-testid="hero-mosaic">
          {Array.from({ length: 5 }, (_, index) => (
            <li aria-hidden="true" className="hero-tile hero-tile-skeleton" key={`skeleton-${index}`}>
              <span className="media-placeholder media-crossfade is-visible card-shimmer">
                <ImageIcon className="size-8 opacity-40" />
              </span>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  if (memories.length === 0) {
    // 空库与加载失败不伪造图像（品牌铁律）：hero 直接退场，交给下方状态层。
    return null;
  }

  return (
    <section aria-label={brand.copy.heroMosaicLabel}>
      <ul className="hero-mosaic" data-testid="hero-mosaic">
        {memories.slice(0, 5).map((memory, index) => (
          <HeroTile
            featured={index === 0}
            key={memory.id}
            memory={memory}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </section>
  );
}
