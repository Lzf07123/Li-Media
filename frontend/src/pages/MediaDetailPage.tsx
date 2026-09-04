import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { getMediaById, type Media } from "@/lib/api";

export default function MediaDetailPage() {
  const { mediaId } = useParams();
  const [media, setMedia] = useState<Media | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mediaId) {
      return;
    }

    let active = true;

    getMediaById(mediaId)
      .then((data) => {
        if (active) {
          setMedia(data);
        }
      })
      .catch(() => {
        if (active) {
          setError("没有找到对应媒体");
        }
      });

    return () => {
      active = false;
    };
  }, [mediaId]);

  if (error) {
    return (
      <div className="rounded-lg border border-border bg-surface p-6">
        <p className="text-sm">{error}</p>
        <Link className="mt-4 inline-flex min-h-11 items-center text-primary" to="/">
          返回首页
        </Link>
      </div>
    );
  }

  if (!media) {
    return <div className="h-72 rounded-lg bg-surface-2" />;
  }

  return (
    <article className="grid gap-8 lg:grid-cols-[280px_1fr]">
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <div className="aspect-[2/3] bg-surface-2">
          {media.poster_path ? (
            <img
              src={media.poster_path}
              alt={media.title}
              className="size-full object-cover"
            />
          ) : (
            <div className="flex size-full items-center justify-center text-sm text-muted">
              暂无海报
            </div>
          )}
        </div>
      </div>

      <div>
        <p className="text-sm text-muted">
          {media.kind}
          {media.year ? ` · ${media.year}` : ""}
        </p>
        <h1 className="mt-2 text-3xl font-semibold">{media.title}</h1>

        {media.original_title && media.original_title !== media.title ? (
          <p className="mt-1 text-sm text-muted">{media.original_title}</p>
        ) : null}

        <p className="mt-6 whitespace-pre-line text-sm leading-6">
          {media.overview || "暂无简介。"}
        </p>
      </div>
    </article>
  );
}

