import { Image as ImageIcon, Video } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { brand } from "@/lib/brand";
import { resolveMediaUrl, type Memory } from "@/lib/api";

export default function MemoryCard({ memory }: { memory: Memory }) {
  const ratio = memory.width && memory.height ? `${memory.width} / ${memory.height}` : "4 / 3";
  const [thumbnailFailed, setThumbnailFailed] = useState(false);

  useEffect(() => {
    setThumbnailFailed(false);
  }, [memory.thumbnail_url]);

  return (
    <Link className="post-card block overflow-hidden" to={`/memories/${memory.id}`}>
      {memory.thumbnail_url && !thumbnailFailed ? (
        <span className="post-cover-link block">
          <img
            alt={memory.title}
            className="post-cover"
            loading="lazy"
            style={{ aspectRatio: ratio }}
            onError={() => setThumbnailFailed(true)}
            src={resolveMediaUrl(memory.thumbnail_url)}
          />
        </span>
      ) : (
        <span
          aria-hidden="true"
          className="flex items-center justify-center rounded-xl bg-surface-2 text-muted"
          style={{ aspectRatio: ratio }}
        >
          {memory.kind === "video" ? <Video className="size-8" /> : <ImageIcon className="size-8" />}
        </span>
      )}

      <span className="block">
        <h3 className="line-clamp-2 text-sm font-semibold">{memory.title}</h3>
        <p className="mt-1 text-xs text-muted">
          {memory.captured_at
            ? new Date(memory.captured_at).toLocaleDateString()
            : memory.kind === "video"
              ? brand.copy.videoKind
              : brand.copy.photoKind}
        </p>
      </span>
    </Link>
  );
}
