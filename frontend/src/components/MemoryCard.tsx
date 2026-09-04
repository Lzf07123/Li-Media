import { Image as ImageIcon, Video } from "lucide-react";
import { Link } from "react-router-dom";

import type { Memory } from "@/lib/api";

export default function MemoryCard({ memory }: { memory: Memory }) {
  return (
    <Link
      to={`/memories/${memory.id}`}
      className="group flex h-full flex-col overflow-hidden rounded-lg border border-border bg-surface transition hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <div className="relative aspect-[4/3] bg-surface-2">
        {memory.thumbnail_url ? (
          <img
            src={memory.thumbnail_url}
            alt={memory.title}
            className="size-full object-cover"
            loading="lazy"
          />
        ) : memory.kind === "video" ? (
          <Video
            aria-hidden="true"
            className="absolute left-1/2 top-1/2 size-8 -translate-x-1/2 -translate-y-1/2 text-muted"
          />
        ) : (
          <ImageIcon
            aria-hidden="true"
            className="absolute left-1/2 top-1/2 size-8 -translate-x-1/2 -translate-y-1/2 text-muted"
          />
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1 p-3">
        <h3 className="line-clamp-2 text-sm font-medium">{memory.title}</h3>
        <p className="mt-auto text-xs text-muted">
          {memory.captured_at
            ? new Date(memory.captured_at).toLocaleDateString()
            : memory.kind === "video"
              ? "视频"
              : "照片"}
        </p>
      </div>
    </Link>
  );
}
