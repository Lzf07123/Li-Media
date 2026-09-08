import { Image as ImageIcon, Play, RotateCcw, Video } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { brand } from "@/lib/brand";
import {
  resolveThumbnailUrl,
  type MemorySummary,
} from "@/lib/api";
import { loadQueuedImage } from "@/lib/image-load-queue";

type MemoryCardProps = {
  memory: MemorySummary;
  priority?: boolean;
  onOpen: (memoryId: string) => void;
};

const AUTO_RETRY_LIMIT = 3;
const AUTO_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

export default function MemoryCard({ memory, onOpen, priority = false }: MemoryCardProps) {
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [queuedThumbnailUrl, setQueuedThumbnailUrl] = useState<string | null>(null);
  const [showShimmer, setShowShimmer] = useState(false);
  const [isIntersecting, setIsIntersecting] = useState(priority);
  const [isInView, setIsInView] = useState(priority);
  const imageRef = useRef<HTMLImageElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const thumbnailUrl = resolveThumbnailUrl(memory.thumbnail_url, "240");
  const thumbnailRetryUrl = retryAttempt > 0
    ? `${thumbnailUrl}&retry=${retryAttempt}`
    : null;
  const knownSize = memory.width && memory.height
    ? { width: memory.width, height: memory.height }
    : null;
  const aspectSize = knownSize ?? naturalSize;
  const mediaStyle = aspectSize
    ? { aspectRatio: `${aspectSize.width} / ${aspectSize.height}` }
    : { minHeight: 160 };

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      setIsIntersecting(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const inView = entries.some((entry) => entry.isIntersecting);
        if (inView) {
          setIsIntersecting(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px 0px", threshold: 0.01 },
    );

    if (cardRef.current) {
      observer.observe(cardRef.current);
    }

    return () => observer.disconnect();
  }, [priority]);

  useEffect(() => {
    let animationFrame = 0;
    const updateVisibility = () => {
      animationFrame = 0;
      const rect = cardRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      setIsInView(
        rect.bottom > -240 && rect.top < window.innerHeight + 240,
      );
    };
    const scheduleVisibility = () => {
      if (animationFrame) {
        return;
      }
      animationFrame = window.requestAnimationFrame(updateVisibility);
    };

    updateVisibility();
    window.addEventListener("scroll", scheduleVisibility, { passive: true });
    window.addEventListener("resize", scheduleVisibility);

    return () => {
      if (animationFrame) {
        window.cancelAnimationFrame(animationFrame);
      }
      window.removeEventListener("scroll", scheduleVisibility);
      window.removeEventListener("resize", scheduleVisibility);
    };
  }, [priority]);

  useEffect(() => {
    setRetryAttempt(0);
  }, [thumbnailUrl]);

  useEffect(() => {
    if (!thumbnailUrl || !isIntersecting) {
      setQueuedThumbnailUrl(null);
      return;
    }

    const controller = new AbortController();
    let autoRetryTimer = 0;
    setLoadState("loading");
    setThumbnailFailed(false);
    setNaturalSize(null);
    setQueuedThumbnailUrl(null);

    loadQueuedImage(thumbnailRetryUrl ?? thumbnailUrl, {
      priority: priority ? "high" : "normal",
      retries: 4,
      signal: controller.signal,
    })
      .then((image) => {
        if (controller.signal.aborted) {
          return;
        }
        setQueuedThumbnailUrl(thumbnailUrl);
        if (image.naturalWidth > 0 && image.naturalHeight > 0) {
          setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
        }
        setLoadState("ready");
      })
      .catch((error) => {
        if (controller.signal.aborted || error.name === "AbortError") {
          return;
        }
        setLoadState("error");
        setThumbnailFailed(true);

        if (retryAttempt < AUTO_RETRY_LIMIT) {
          autoRetryTimer = window.setTimeout(() => {
            if (controller.signal.aborted) {
              return;
            }
            setRetryAttempt(retryAttempt + 1);
          }, AUTO_RETRY_DELAYS_MS[retryAttempt]);
        }
      });

    return () => {
      controller.abort();
      window.clearTimeout(autoRetryTimer);
    };
  }, [isIntersecting, priority, retryAttempt, thumbnailRetryUrl, thumbnailUrl]);

  useEffect(() => {
    if (loadState !== "loading") {
      setShowShimmer(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setShowShimmer(true);
    }, 150);

    return () => window.clearTimeout(timer);
  }, [loadState]);

  const showError = thumbnailFailed || loadState === "error";

  const retryThumbnail = () => {
    if (!thumbnailUrl) {
      return;
    }

    setLoadState("loading");
    setThumbnailFailed(false);
    setNaturalSize(null);
    setQueuedThumbnailUrl(null);
    setRetryAttempt((current) => current + 1);
  };

  return (
    <div className="post-card relative block w-full overflow-hidden" ref={cardRef}>
      <button
        aria-label={brand.copy.detailPreviewAlt}
        className="block w-full cursor-pointer text-left"
        onClick={() => onOpen(memory.id)}
        type="button"
      >
      {thumbnailUrl && (!thumbnailFailed || thumbnailRetryUrl) ? (
        <span className="post-cover-link block media-frame" style={mediaStyle}>
          {thumbnailUrl ? (
            <span
              aria-hidden="true"
              className={`media-placeholder media-crossfade ${
                isInView && loadState !== "ready" ? "is-visible" : "is-hidden"
              } ${showShimmer ? "card-shimmer" : ""}`}
            >
              <ImageIcon className="size-8 opacity-40" />
            </span>
          ) : null}
          <img
            alt={brand.copy.detailPreviewAlt}
            className={`post-cover media-reveal media-crossfade ${
              loadState === "ready" && isInView ? "is-visible" : "is-hidden"
            }`}
            decoding="async"
            fetchPriority={priority ? "high" : "low"}
            height={memory.height ?? undefined}
            loading={priority ? "eager" : "lazy"}
            onError={() => {
              setLoadState("error");
              setThumbnailFailed(true);
            }}
            onLoad={(event) => {
              const image = event.currentTarget;
              if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
              }
              setLoadState("ready");
            }}
            sizes="(max-width: 767px) 46vw, (max-width: 1023px) 30vw, (max-width: 1279px) 23vw, (max-width: 1599px) 18vw, 12vw"
            src={thumbnailRetryUrl ?? queuedThumbnailUrl ?? undefined}
            ref={imageRef}
            width={memory.width ?? undefined}
          />
        </span>
      ) : (
        <span
          aria-hidden="true"
          className="media-frame flex items-center justify-center rounded-xl bg-surface-2 text-muted"
          style={mediaStyle}
        >
          {showError && memory.thumbnail_url ? (
            <ImageIcon className="size-8" />
          ) : memory.kind === "video" ? (
            <Play className="size-8" />
          ) : (
            <ImageIcon className="size-8" />
          )}
          {showError ? (
            <span className="mt-2 flex items-center gap-1 text-xs font-medium">
              <RotateCcw aria-hidden="true" className="size-3.5" />
              {brand.copy.retryPreview}
            </span>
          ) : null}
        </span>
      )}
      {memory.kind === "video" ? (
        <span className="waterfall-badge">
          <Video aria-hidden="true" className="size-3.5" />
          {brand.copy.videoKind}
        </span>
      ) : null}
      </button>
      {showError ? (
        <button
          aria-label={brand.copy.retryPreview}
          className="absolute inset-x-2 bottom-2 flex min-h-11 items-center justify-center gap-1 rounded-lg bg-surface/90 text-xs font-medium text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          onClick={retryThumbnail}
          type="button"
        >
          <RotateCcw aria-hidden="true" className="size-3.5" />
          {brand.copy.retryPreview}
        </button>
      ) : null}
    </div>
  );
}
