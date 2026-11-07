import { Image as ImageIcon, Play, Video } from "lucide-react";
import { useEffect, useState } from "react";

import BlurText from "@/components/ui/BlurText";
import { brand } from "@/lib/brand";
import { readCanvasComposition } from "@/lib/canvas-composition";
import { formatDate, formatDuration } from "@/lib/format";
import {
  appendQueryParam,
  resolveThumbnailUrl,
  type MemorySummary,
} from "@/lib/api";
import { loadQueuedImage } from "@/lib/image-load-queue";

type HeroFeatureProps = {
  /** 首屏捕获的精选回忆（≤5 条，捕获后保持稳定） */
  memories: MemorySummary[];
  /** 首屏列表尚未返回时展示结构镜像骨架 */
  loading: boolean;
  /** CTA「进入回忆库」：滚动画布区 */
  onEnter: () => void;
  onOpen: (memoryId: string) => void;
};

// 全出血主图渐进加载（LQIP）：先显示 240 预热档（服务端预热即所得，
// ~80ms），1280 高清档就绪后原地升级——大档位在公开预热范围外，按需
// 派生需数秒，绝不能挡住首屏。「接下来」条显示宽 ≤96px，240 足够清晰
// 且全部预热即得；与查看器共用 detail 派生端点，生成结果进派生缓存。
const FEATURED_THUMBNAIL_SIZE = "1280" as const;
const LQIP_THUMBNAIL_SIZE = "240" as const;
const STRIP_THUMBNAIL_SIZE = "240" as const;
const UP_NEXT_COUNT = 4;

type TileImageState = "queued" | "ready" | "failed";

/** 队列加载 + 退避重试的共享逻辑：hero 各槽位与画布同一失败哲学 */
function useQueuedThumbnail(
  thumbnailUrl: string | null,
  priority: "high" | "normal",
) {
  const [loadState, setLoadState] = useState<TileImageState>("queued");
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const requestUrl =
    retryAttempt > 0 && thumbnailUrl
      ? appendQueryParam(thumbnailUrl, "retry", String(retryAttempt))
      : thumbnailUrl;

  useEffect(() => {
    if (!requestUrl) {
      return;
    }

    const controller = new AbortController();
    setLoadState("queued");
    loadQueuedImage(requestUrl, {
      priority,
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
        //（低对比图标占位，与画布卡片同一失败哲学）。
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
  }, [priority, requestUrl, retryAttempt, thumbnailUrl]);

  // img onLoad/onError 与队列 promise 双通道确认（幂等），与旧 HeroTile 一致
  const markReady = () => setLoadState("ready");
  const markFailed = () => setLoadState("failed");

  return { loadState, loadedUrl, markReady, markFailed };
}

/** 全出血主图：240 LQIP 即刻显影 → 1280 就绪后原地升级（极慢 Ken Burns） */
function FeaturedMedia({
  memory,
  onOpen,
}: {
  memory: MemorySummary;
  onOpen: (memoryId: string) => void;
}) {
  const lqipUrl = resolveThumbnailUrl(memory.thumbnail_url, LQIP_THUMBNAIL_SIZE);
  const hqUrl = resolveThumbnailUrl(
    memory.thumbnail_url,
    FEATURED_THUMBNAIL_SIZE,
  );
  // 同为高优先级：hook 顺序保证 240 先入队，1280 随后并行派生
  const lqip = useQueuedThumbnail(lqipUrl, "high");
  const hq = useQueuedThumbnail(hqUrl, "high");
  const accessibleName = memory.title || brand.copy.detailPreviewAlt;

  const lqipReady = lqip.loadState === "ready";
  const hqReady = hq.loadState === "ready";
  const allFailed = lqip.loadState === "failed" && hq.loadState === "failed";
  const overallState = allFailed
    ? "failed"
    : lqipReady || hqReady
      ? "ready"
      : "queued";
  // 显示档位：240 先行（模糊放大），1280 就绪后原地换源变清晰
  const displayUrl = hqReady ? hqUrl : lqipReady ? lqipUrl : undefined;

  return (
    <button
      aria-label={accessibleName}
      className="hero-stage-media"
      data-preview-state={overallState}
      onClick={() => onOpen(memory.id)}
      type="button"
    >
      {overallState !== "failed" && displayUrl ? (
        // key 随记忆切换重挂载：交叉淡入与 Ken Burns 从新主图重新起拍
        <img
          alt=""
          className={`hero-feature-img ${overallState === "ready" ? "is-ready" : "is-loading"} ${
            lqipReady && !hqReady ? "is-lqip" : ""
          }`}
          decoding="async"
          fetchPriority="high"
          key={memory.id}
          loading="eager"
          src={displayUrl}
        />
      ) : null}
      {overallState === "queued" ? (
        <span
          aria-hidden="true"
          className="hero-stage-placeholder media-placeholder media-crossfade is-visible card-shimmer"
        />
      ) : null}
      {overallState === "failed" ? (
        <span aria-hidden="true" className="hero-stage-fallback">
          {memory.kind === "video" ? (
            <Play className="size-10 opacity-40" />
          ) : (
            <ImageIcon className="size-10 opacity-40" />
          )}
        </span>
      ) : null}
    </button>
  );
}

/** 「接下来」条小瓦：240 预热档（预热即所得），点击切换主图 */
function StripTile({
  memory,
  active,
  onSelect,
}: {
  memory: MemorySummary;
  active: boolean;
  onSelect: () => void;
}) {
  const thumbnailUrl = resolveThumbnailUrl(
    memory.thumbnail_url,
    STRIP_THUMBNAIL_SIZE,
  );
  const { loadState, loadedUrl, markReady, markFailed } = useQueuedThumbnail(
    thumbnailUrl,
    "normal",
  );
  const accessibleName = memory.title || brand.copy.detailPreviewAlt;

  return (
    <button
      aria-label={accessibleName}
      aria-pressed={active}
      className="hero-upnext-tile"
      data-preview-state={loadState}
      onClick={onSelect}
      type="button"
    >
      {loadState !== "failed" ? (
        <img
          alt=""
          className={`hero-upnext-img ${loadState === "ready" ? "is-ready" : "is-loading"}`}
          decoding="async"
          loading="lazy"
          onError={markFailed}
          onLoad={markReady}
          src={loadedUrl ?? undefined}
        />
      ) : (
        <span aria-hidden="true" className="hero-upnext-fallback">
          {memory.kind === "video" ? (
            <Play className="size-4 opacity-60" />
          ) : (
            <ImageIcon className="size-4 opacity-60" />
          )}
        </span>
      )}
    </button>
  );
}

/** 结构镜像骨架：比例框 + 文本条 + 接下来条，禁止一整块均色 */
function HeroFeatureSkeleton() {
  // 上次精选的真实宽高来自构图缓存；首次访问回退居中 3:2 比例框
  const heroSize = readCanvasComposition().hero;
  return (
    <div className="hero-feature is-skeleton" data-testid="hero-feature-skeleton">
      <div className="hero-stage hero-stage-skeleton">
        <span
          aria-hidden="true"
          className="hero-stage-frame card-shimmer"
          style={
            heroSize
              ? { aspectRatio: `${heroSize.width} / ${heroSize.height}` }
              : undefined
          }
        />
        <div aria-hidden="true" className="hero-overlay hero-overlay-skeleton">
          <span className="hero-skel-line hero-skel-meta card-shimmer" />
          <span className="hero-skel-line hero-skel-title card-shimmer" />
          <span className="hero-skel-line hero-skel-desc card-shimmer" />
          <span className="hero-skel-chip card-shimmer" />
        </div>
        <div aria-hidden="true" className="hero-upnext hero-upnext-skeleton">
          <span className="hero-skel-label card-shimmer" />
          <div className="hero-upnext-list">
            {Array.from({ length: UP_NEXT_COUNT }, (_, index) => (
              <span className="hero-upnext-tile card-shimmer" key={index} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function HeroFeature({
  memories,
  loading,
  onEnter,
  onOpen,
}: HeroFeatureProps) {
  const [featuredIndex, setFeaturedIndex] = useState(0);

  if (loading) {
    return <HeroFeatureSkeleton />;
  }

  if (memories.length === 0) {
    // 空库与加载失败不伪造图像（品牌铁律）：hero 直接退场，交给下方状态层。
    return null;
  }

  const featured = memories[Math.min(featuredIndex, memories.length - 1)];
  const stripItems = memories.slice(1, 1 + UP_NEXT_COUNT);
  const featuredMeta = [
    featured.location,
    formatDate(featured.captured_at),
  ]
    .filter(Boolean)
    .join(" · ");
  const videoDuration = formatDuration(featured.duration_seconds);

  return (
    <div className="hero-feature" data-testid="hero-feature">
      <div className="hero-stage">
        <FeaturedMedia memory={featured} onOpen={onOpen} />
        <span aria-hidden="true" className="hero-stage-scrim" />

        <div className="hero-overlay">
          <p aria-live="polite" className="hero-meta tnum">
            <span className="hero-meta-index">
              {String(featuredIndex + 1).padStart(2, "0")}
            </span>
            <span aria-hidden="true">
              {`/ ${brand.copy.heroFeaturedLabel}${featuredMeta ? ` · ${featuredMeta}` : ""}`}
            </span>
            {featured.kind === "video" && videoDuration ? (
              <span className="hero-meta-kind">
                <Video aria-hidden="true" className="size-3.5" />
                {`${brand.copy.videoKind} ${videoDuration}`}
              </span>
            ) : null}
          </p>
          <BlurText
            as="h1"
            className="hero-title"
            id="library-title"
            text={brand.copy.libraryTitle}
          />
          <p className="hero-description">{brand.copy.libraryDescription}</p>
          <button className="hero-cta" onClick={onEnter} type="button">
            {brand.copy.heroEnterLabel}
          </button>
        </div>

        {stripItems.length > 0 ? (
          <div className="hero-upnext">
            <span aria-hidden="true" className="hero-upnext-label">
              {brand.copy.heroUpNextLabel}
            </span>
            <ul className="hero-upnext-list">
              {stripItems.map((memory, index) => (
                <li key={memory.id}>
                  <StripTile
                    active={featuredIndex === index + 1}
                    memory={memory}
                    onSelect={() => setFeaturedIndex(index + 1)}
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
