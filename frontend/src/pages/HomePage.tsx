import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import MemoryCard from "@/components/MemoryCard";
import { getMemories, type Memory } from "@/lib/api";
import { brand } from "@/lib/brand";

export default function HomePage() {
  const [searchParams] = useSearchParams();
  const kind = searchParams.get("kind") ?? undefined;
  const [memories, setMemories] = useState<Memory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    setIsLoading(true);
    getMemories({ kind })
      .then((data) => {
        if (active) {
          setMemories(data.items);
        }
      })
      .catch(() => {
        if (active) {
          setError("暂时无法加载回忆库");
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
  }, [kind]);

  return (
    <section aria-labelledby="library-title">
      <h1 id="library-title" className="text-2xl font-semibold">
        回忆库
      </h1>
      <p className="mt-2 text-sm text-muted">{brand.slogan}</p>

      {isLoading ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="aspect-[4/3] rounded-lg bg-surface-2" />
          ))}
        </div>
      ) : error ? (
        <div className="mt-8 rounded-lg border border-border bg-surface p-6 text-sm">
          {error}
        </div>
      ) : memories.length === 0 ? (
        <div className="mt-8 rounded-lg border border-border bg-surface p-6 text-center text-sm text-muted">
          还没有公开的回忆内容。
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {memories.map((item) => (
            <MemoryCard key={item.id} memory={item} />
          ))}
        </div>
      )}
    </section>
  );
}
