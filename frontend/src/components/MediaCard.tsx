import { Film } from "lucide-react";
import { Link } from "react-router-dom";

import type { Media } from "@/lib/api";

export default function MediaCard({ media }: { media: Media }) {
  return (
    <Link
      to={`/media/${media.id}`}
      className="group flex h-full flex-col overflow-hidden rounded-lg border border-border bg-surface transition hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <div className="relative aspect-[2/3] bg-surface-2">
        {media.poster_path ? (
          <img
            src={media.poster_path}
            alt={media.title}
            className="size-full object-cover"
            loading="lazy"
          />
        ) : (
          <Film
            aria-hidden="true"
            className="absolute left-1/2 top-1/2 size-8 -translate-x-1/2 -translate-y-1/2 text-muted"
          />
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1 p-3">
        <h3 className="line-clamp-2 text-sm font-medium">{media.title}</h3>
        <p className="mt-auto text-xs text-muted">{media.year ?? media.kind}</p>
      </div>
    </Link>
  );
}

