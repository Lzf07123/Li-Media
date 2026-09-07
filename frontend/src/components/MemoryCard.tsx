import { Image as ImageIcon, Play, RotateCcw, Video } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { brand } from "@/lib/brand";
import { resolveThumbnailUrl, type MemorySummary } from "@/lib/api";
import { loadQueuedImage } from "@/lib/image-load-queue";

type MemoryCardProps = {
  memory: MemorySummary;
  priority?: boolean;
  onOpen: (memoryId: string) => void;
};

export default function MemoryCard({ memory, onOpen, priority = false }: MemoryCardProps) {
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [queuedThumbnailUrl, setQueuedThumbnailUrl] = useState<string | null>(null);
  const [isIntersecting, setIsIntersecting] = useState(priority);
  const imageRef = useRef<HTMLImageElement>(null);
  const cardRef = useRef<HTMLButtonElement>(null);
  const thumbnailUrl = resolveThumbnailUrl(memory.thumbnail_url, "240");
  const knownSize = memory.width && memory.height
    ? { width: memory.width, height: memory.height }
    : null;
  const aspectSize = knownSize ?? naturalSize;
  const mediaStyle = aspectSize
    ? { aspectRatio: `${aspectSize.width} / ${aspectSize.height}` }
    : { minHeight: 160 };

  useEffect(() => {
    if (priority || typeof IntersectionObserver === "undefined") {
      setIsIntersecting(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
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
    if (!thumbnailUrl || !isIntersecting) {
      setQueuedThumbnailUrl(null);
      return;
    }

    const controller = new AbortController();
    setLoadState("loading");
    setThumbnailFailed(false);
    setNaturalSize(null);
    setQueuedThumbnailUrl(null);

    loadQueuedImage(thumbnailUrl, {
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
      });

    return () => controller.abort();
  }, [isIntersecting, priority, retryKey, thumbnailUrl]);

  const showError = thumbnailFailed || loadState === "error";

  return (
    <button
      aria-label={brand.copy.detailPreviewAlt}
      className="post-card block w-full overflow-hidden"
      ref={cardRef}
      onClick={() => {
        if (showError) {
          setLoadState("loading");
          setThumbnailFailed(false);
          setRetryKey((current) => current + 1);
          return;
        }
        onOpen(memory.id);
      }}
      type="button"
    >
      {thumbnailUrl && !thumbnailFailed ? (
        <span className="post-cover-link block media-frame" style={mediaStyle}>
          {loadState !== "ready" ? (
            <span aria-hidden="true" className="media-placeholder">
              <ImageIcon className="size-8 opacity-40" />
            </span>
          ) : null}
          <img
            alt={brand.copy.detailPreviewAlt}
            className={`post-cover media-reveal ${loadState === "ready" ? "is-loaded" : ""}`}
            decoding="async"
            fetchPriority={priority ? "high" : "auto"}
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
            src={queuedThumbnailUrl ?? undefined}
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
  );
}
