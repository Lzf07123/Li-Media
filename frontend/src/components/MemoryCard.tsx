import { Image as ImageIcon, Play, Video } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { brand } from "@/lib/brand";
import { resolveThumbnailUrl, type Memory } from "@/lib/api";

type MemoryCardProps = {
  memory: Memory;
  priority?: boolean;
};

export default function MemoryCard({ memory, priority = false }: MemoryCardProps) {
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const thumbnailUrl = resolveThumbnailUrl(memory.thumbnail_url, priority ? "medium" : "small");
  const srcSet = memory.thumbnail_url
    ? [
      `${resolveThumbnailUrl(memory.thumbnail_url, "small")} 320w`,
      `${resolveThumbnailUrl(memory.thumbnail_url, "medium")} 640w`,
      `${resolveThumbnailUrl(memory.thumbnail_url, "large")} 1280w`,
    ].join(", ")
    : undefined;
  const aspectRatio = memory.width && memory.height
    ? `${memory.width} / ${memory.height}`
    : "4 / 3";

  useEffect(() => {
    setLoadState("loading");
    setThumbnailFailed(false);
  }, [memory.thumbnail_url]);

  const showError = thumbnailFailed || loadState === "error";

  return (
    <Link
      aria-label={brand.copy.detailPreviewAlt}
      className="post-card block overflow-hidden"
      to={`/memories/${memory.id}`}
    >
      {thumbnailUrl && !thumbnailFailed ? (
        <span className="post-cover-link block media-frame" style={{ aspectRatio }}>
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
            onLoad={() => setLoadState("ready")}
            sizes="(max-width: 767px) 46vw, (max-width: 1023px) 30vw, (max-width: 1279px) 23vw, (max-width: 1599px) 18vw, 12vw"
            src={thumbnailUrl}
            srcSet={srcSet}
            width={memory.width ?? undefined}
          />
        </span>
      ) : (
        <span
          aria-hidden="true"
          className="media-frame flex items-center justify-center rounded-xl bg-surface-2 text-muted"
          style={{ aspectRatio }}
        >
          {showError && memory.thumbnail_url ? (
            <ImageIcon className="size-8" />
          ) : memory.kind === "video" ? (
            <Play className="size-8" />
          ) : (
            <ImageIcon className="size-8" />
          )}
        </span>
      )}
      {memory.kind === "video" ? (
        <span className="waterfall-badge">
          <Video aria-hidden="true" className="size-3.5" />
          {brand.copy.videoKind}
        </span>
      ) : null}
    </Link>
  );
}
