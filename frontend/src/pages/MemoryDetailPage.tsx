import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { getMemoryById, type Memory } from "@/lib/api";

export default function MemoryDetailPage() {
  const { memoryId } = useParams();
  const [memory, setMemory] = useState<Memory | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!memoryId) {
      return;
    }

    let active = true;

    getMemoryById(memoryId)
      .then((data) => {
        if (active) {
          setMemory(data);
        }
      })
      .catch(() => {
        if (active) {
          setError("没有找到对应回忆");
        }
      });

    return () => {
      active = false;
    };
  }, [memoryId]);

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

  if (!memory) {
    return <div className="h-72 rounded-lg bg-surface-2" />;
  }

  return (
    <article className="grid gap-8 lg:grid-cols-[380px_1fr]">
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <div className="aspect-[4/3] bg-surface-2">
          {memory.thumbnail_path ? (
            <img
              src={memory.thumbnail_path}
              alt={memory.title}
              className="size-full object-cover"
            />
          ) : (
            <div className="flex size-full items-center justify-center text-sm text-muted">
              暂无缩略图
            </div>
          )}
        </div>
      </div>

      <div>
        <p className="text-sm text-muted">
          {memory.kind === "video" ? "视频" : "照片"}
          {memory.captured_at
            ? ` · ${new Date(memory.captured_at).toLocaleDateString()}`
            : ""}
        </p>
        <h1 className="mt-2 text-3xl font-semibold">{memory.title}</h1>

        {memory.location ? (
          <p className="mt-1 text-sm text-muted">{memory.location}</p>
        ) : null}

        <p className="mt-6 whitespace-pre-line text-sm leading-6">
          {memory.description || "暂无描述。"}
        </p>
      </div>
    </article>
  );
}
