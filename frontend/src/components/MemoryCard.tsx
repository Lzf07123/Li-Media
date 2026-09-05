import { Image as ImageIcon, Video } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { brand } from "@/lib/brand";
import { resolveMediaUrl, type Memory } from "@/lib/api";

export default function MemoryCard({ memory }: { memory: Memory }) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false);

  useEffect(() => {
    setThumbnailFailed(false);
  }, [memory.thumbnail_url]);

  return (
    <Link
      aria-label={brand.copy.detailPreviewAlt}
      className="post-card block overflow-hidden"
      to={`/memories/${memory.id}`}
    >
      {memory.thumbnail_url && !thumbnailFailed ? (
        <span className="post-cover-link block">
          <img
            alt={brand.copy.detailPreviewAlt}
            className="post-cover"
            loading="lazy"
            onError={() => setThumbnailFailed(true)}
            src={resolveMediaUrl(memory.thumbnail_url)}
          />
        </span>
      ) : (
        <span
          aria-hidden="true"
          className="flex items-center justify-center rounded-xl bg-surface-2 text-muted"
          style={{ aspectRatio: "4 / 3" }}
        >
          {memory.kind === "video" ? <Video className="size-8" /> : <ImageIcon className="size-8" />}
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
