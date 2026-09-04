import { useEffect, useState } from "react";

import MediaCard from "@/components/MediaCard";
import { getMedia, type Media } from "@/lib/api";
import { brand } from "@/lib/brand";

export default function HomePage() {
  const [media, setMedia] = useState<Media[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    setIsLoading(true);
    getMedia()
      .then((data) => {
        if (active) {
          setMedia(data.items);
        }
      })
      .catch(() => {
        if (active) {
          setError("暂时无法加载媒体库");
        }
      })
      .finally(() => {
        if (active) {
          setIsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <section aria-labelledby="library-title">
      <h1 id="library-title" className="text-2xl font-semibold">
        媒体库
      </h1>
      <p className="mt-2 text-sm text-muted">{brand.slogan}</p>

      {isLoading ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="aspect-[2/3] rounded-lg bg-surface-2" />
          ))}
        </div>
      ) : error ? (
        <div className="mt-8 rounded-lg border border-border bg-surface p-6 text-sm">
          {error}
        </div>
      ) : media.length === 0 ? (
        <div className="mt-8 rounded-lg border border-border bg-surface p-6 text-center text-sm text-muted">
          媒体库还没有公开内容。
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {media.map((item) => (
            <MediaCard key={item.id} media={item} />
          ))}
        </div>
      )}
    </section>
  );
}

