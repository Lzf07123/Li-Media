import { Image as ImageIcon, Pause, Play, Video } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
// 精选自动轮播节奏：与 Ken Burns 同一「以动衬静」口径——极慢、可暂停、
// reduced-motion 下完全不启动。切换间隔与 .hero-upnext-progress 时长一致。
const HERO_ADVANCE_MS = 9000;

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

/** 全出血主图：LQIP 模糊先行淡入，1280 就绪后原地淡入覆盖（极慢 Ken Burns） */
function FeaturedMedia({
  memory,
  onOpen,
  crossfading = false,
}: {
  memory: MemorySummary;
  onOpen: (memoryId: string) => void;
  /** 上一主图残影垫底期间不显示占位闪光，避免盖住残影层 */
  crossfading?: boolean;
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

  return (
    <button
      aria-label={accessibleName}
      className="hero-stage-media"
      data-preview-state={overallState}
      onClick={() => onOpen(memory.id)}
      type="button"
    >
      {/* LQIP 层：模糊先行淡入；高清就绪后垫底（is-covered，不参与缩放）。
          两层各自 key 随记忆重挂载：淡入与 Ken Burns 从新主图重新起拍 */}
      {lqipUrl ? (
        <img
          alt=""
          aria-hidden="true"
          className={`hero-feature-img is-lqip ${hqReady ? "is-covered" : "is-primary"} ${
            lqipReady ? "is-ready" : "is-loading"
          }`}
          decoding="async"
          fetchPriority="high"
          key={`${memory.id}-lqip`}
          loading="eager"
          src={lqipUrl}
        />
      ) : null}
      {/* 高清层：就绪后 700ms 电影感淡入覆盖模糊层，消除瞬时换源的「变清晰跳变」 */}
      {hqUrl ? (
        <img
          alt=""
          aria-hidden="true"
          className={`hero-feature-img ${hqReady ? "is-ready is-primary" : "is-loading"}`}
          decoding="async"
          fetchPriority="high"
          key={`${memory.id}-hq`}
          loading="eager"
          src={hqUrl}
        />
      ) : null}
      {overallState === "queued" && !crossfading ? (
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
  showProgress = false,
}: {
  memory: MemorySummary;
  active: boolean;
  onSelect: () => void;
  /** 自动轮播进行中且本瓦是当前主图：底部进度发丝线（transform 动画） */
  showProgress?: boolean;
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
      {showProgress ? (
        <span aria-hidden="true" className="hero-upnext-progress" />
      ) : null}
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
  // 自动轮播的四路暂停：用户开关、悬停、键盘聚焦、标签页隐藏；
  // reduced-motion 下整个机制不启动（档案室允许的环境动效上限）。
  const [userPaused, setUserPaused] = useState(false);
  const [hoverPaused, setHoverPaused] = useState(false);
  const [focusPaused, setFocusPaused] = useState(false);
  const [hiddenPaused, setHiddenPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      setHiddenPaused(document.visibilityState !== "visible");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const autoAdvanceSupported = memories.length > 1 && !reducedMotion;
  const pausedNow = userPaused || hoverPaused || focusPaused || hiddenPaused;
  const advanceActive = autoAdvanceSupported && !pausedNow;

  // 定时器与进度线同生命周期：featuredIndex / advanceActive 任一变化都重开
  // 一个完整周期，保证发丝线从 0 重新铺满时与真实切换时刻对齐。
  useEffect(() => {
    if (!advanceActive) {
      return;
    }

    const timer = window.setTimeout(() => {
      setFeaturedIndex((current) => (current + 1) % memories.length);
    }, HERO_ADVANCE_MS);
    return () => window.clearTimeout(timer);
  }, [advanceActive, featuredIndex, memories.length]);

  // 精选切换交叉淡出：旧主图的高清档作为残影层垫底，新图 700ms 淡入覆盖，
  // 消除「先抽空舞台再从背景淡入」的生硬切换；残影 900ms 后移除（>淡入时长）。
  // 钩子必须在提前 return 之前声明；旧图 src 在渲染期捕获（避免多提交一帧空档）。
  const [previousFeatured, setPreviousFeatured] = useState<{
    key: string;
    src: string;
  } | null>(null);
  const lastFeaturedRef = useRef<{ id: string; src: string | null } | null>(null);

  useEffect(() => {
    if (!previousFeatured) {
      return;
    }
    const timer = window.setTimeout(() => setPreviousFeatured(null), 900);
    return () => window.clearTimeout(timer);
  }, [previousFeatured]);

  if (loading) {
    return <HeroFeatureSkeleton />;
  }

  if (memories.length === 0) {
    // 空库与加载失败不伪造图像（品牌铁律）：hero 直接退场，交给下方状态层。
    return null;
  }

  const featured = memories[Math.min(featuredIndex, memories.length - 1)];
  const stripItems = memories.slice(1, 1 + UP_NEXT_COUNT);
  if (featured.id !== lastFeaturedRef.current?.id) {
    const outgoing = lastFeaturedRef.current;
    if (outgoing?.src) {
      setPreviousFeatured({ key: outgoing.id, src: outgoing.src });
    }
    lastFeaturedRef.current = {
      id: featured.id,
      src: resolveThumbnailUrl(featured.thumbnail_url, FEATURED_THUMBNAIL_SIZE),
    };
  }

  const featuredMeta = [
    featured.location,
    formatDate(featured.captured_at),
  ]
    .filter(Boolean)
    .join(" · ");
  const videoDuration = formatDuration(featured.duration_seconds);

  return (
    <div className="hero-feature" data-testid="hero-feature">
      <div
        className="hero-stage"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setFocusPaused(false);
          }
        }}
        onFocus={() => setFocusPaused(true)}
        onMouseEnter={() => setHoverPaused(true)}
        onMouseLeave={() => setHoverPaused(false)}
      >
        {/* key 随精选切换重挂载：LQIP→高清交叉淡入与 Ken Burns 从新主图
            重新起拍；避免旧 hook 状态残留导致新 src 以 ready 态直接闪现 */}
        {previousFeatured ? (
          <img
            alt=""
            aria-hidden="true"
            className="hero-feature-img is-previous is-ready"
            key={previousFeatured.key}
            src={previousFeatured.src}
          />
        ) : null}
        <FeaturedMedia
          crossfading={previousFeatured !== null}
          key={featured.id}
          memory={featured}
          onOpen={onOpen}
        />
        <span aria-hidden="true" className="hero-stage-scrim" />

        <div className="hero-overlay">
          {/* 自动轮播不进 aria-live：每 9s 朗读元数据是噪声；
              手动切换的状态变化由瓦片 aria-pressed 表达 */}
          <p className="hero-meta tnum">
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
            <div className="hero-upnext-head">
              <span aria-hidden="true" className="hero-upnext-label">
                {brand.copy.heroUpNextLabel}
              </span>
              {autoAdvanceSupported ? (
                <button
                  aria-label={brand.copy.heroAutoToggle}
                  aria-pressed={!userPaused}
                  className="hero-auto-toggle"
                  onClick={() => setUserPaused((current) => !current)}
                  title={userPaused ? brand.copy.heroAutoResume : brand.copy.heroAutoPause}
                  type="button"
                >
                  {userPaused ? (
                    <Play aria-hidden="true" className="size-3.5" />
                  ) : (
                    <Pause aria-hidden="true" className="size-3.5" />
                  )}
                </button>
              ) : null}
            </div>
            <ul className="hero-upnext-list">
              {stripItems.map((memory, index) => (
                <li key={memory.id}>
                  <StripTile
                    active={featuredIndex === index + 1}
                    memory={memory}
                    onSelect={() => setFeaturedIndex(index + 1)}
                    showProgress={advanceActive && featuredIndex === index + 1}
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <span aria-hidden="true" className="hero-scroll-cue">
          <span className="hero-scroll-cue-track">
            <span className="hero-scroll-cue-dot" />
          </span>
        </span>
      </div>
    </div>
  );
}
