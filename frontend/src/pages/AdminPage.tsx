import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import {
  createMemory,
  deleteMemory,
  getAdminMemories,
  updateMemory,
  type Memory,
} from "@/lib/api";

const TOKEN_STORAGE_KEY = "limedia-admin-token";

export default function AdminPage() {
  const [token, setToken] = useState(
    () => localStorage.getItem(TOKEN_STORAGE_KEY) ?? "",
  );
  const [tokenInput, setTokenInput] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [capturedAt, setCapturedAt] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const loadMemories = useCallback(
    async (currentToken: string) => {
      if (!currentToken) {
        return;
      }

      setIsLoading(true);
      try {
        const data = await getAdminMemories(currentToken);
        setMemories(data.items);
        setIsAdmin(true);
        setError(null);
      } catch {
        setIsAdmin(false);
        setError("管理令牌不正确，或服务暂时不可用");
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void loadMemories(token);
  }, [loadMemories, token]);

  const submitToken = async (event: FormEvent) => {
    event.preventDefault();
    setToken(tokenInput);
    localStorage.setItem(TOKEN_STORAGE_KEY, tokenInput);
    await loadMemories(tokenInput);
  };

  const submitMemory = async (event: FormEvent) => {
    event.preventDefault();

    if (!file || !title) {
      setError("请填写标题并选择文件");
      return;
    }

    setIsUploading(true);
    try {
      await createMemory(token, {
        file,
        title,
        description,
        location: location || undefined,
        captured_at: capturedAt || undefined,
      });
      setTitle("");
      setDescription("");
      setLocation("");
      setCapturedAt("");
      setFile(null);
      setError(null);
      await loadMemories(token);
    } catch {
      setError("上传失败，请检查文件格式后重试");
    } finally {
      setIsUploading(false);
    }
  };

  const changeStatus = async (memory: Memory, status: Memory["status"]) => {
    try {
      await updateMemory(token, memory.id, { status });
      await loadMemories(token);
    } catch {
      setError("状态更新失败");
    }
  };

  const removeMemory = async (memory: Memory) => {
    try {
      await deleteMemory(token, memory.id);
      await loadMemories(token);
    } catch {
      setError("删除失败");
    }
  };

  if (!isAdmin) {
    return (
      <section className="mx-auto max-w-md rounded-lg border border-border bg-surface p-6">
        <h1 className="text-xl font-semibold">管理登录</h1>
        <p className="mt-2 text-sm text-muted">请输入管理令牌以继续操作。</p>

        <form className="mt-6 flex flex-col gap-3" onSubmit={submitToken}>
          <label className="text-sm" htmlFor="admin-token">
            管理令牌
          </label>
          <input
            id="admin-token"
            type="password"
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
            className="min-h-11 rounded-md border border-border bg-surface px-3"
            required
          />
          <button
            type="submit"
            className="min-h-11 rounded-md border border-primary bg-primary-soft px-4 font-medium text-primary"
          >
            进入管理
          </button>
        </form>

        {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
      </section>
    );
  }

  return (
    <section aria-labelledby="admin-title">
      <h1 id="admin-title" className="text-2xl font-semibold">
        回忆管理
      </h1>
      <p className="mt-2 text-sm text-muted">
        上传照片或视频，确认后即可在公开页面展示。
      </p>

      {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}

      <form
        className="mt-6 grid gap-4 rounded-lg border border-border bg-surface p-6 lg:grid-cols-2"
        onSubmit={submitMemory}
      >
        <label className="flex flex-col gap-2 text-sm">
          标题
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="min-h-11 rounded-md border border-border bg-surface px-3"
            required
          />
        </label>

        <label className="flex flex-col gap-2 text-sm">
          拍摄时间
          <input
            type="datetime-local"
            value={capturedAt}
            onChange={(event) => setCapturedAt(event.target.value)}
            className="min-h-11 rounded-md border border-border bg-surface px-3"
          />
        </label>

        <label className="flex flex-col gap-2 text-sm">
          地点
          <input
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            className="min-h-11 rounded-md border border-border bg-surface px-3"
          />
        </label>

        <label className="flex flex-col gap-2 text-sm">
          文件
          <input
            type="file"
            accept="image/*,video/*"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="min-h-11 rounded-md border border-border bg-surface px-3 py-2"
            required
          />
        </label>

        <label className="flex flex-col gap-2 text-sm lg:col-span-2">
          描述
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className="min-h-28 rounded-md border border-border bg-surface px-3 py-2"
          />
        </label>

        <button
          className="min-h-11 rounded-md border border-primary bg-primary-soft px-4 font-medium text-primary lg:col-span-2"
          disabled={isUploading}
          type="submit"
        >
          {isUploading ? "上传中..." : "上传并发布"}
        </button>
      </form>

      <h2 className="mt-8 text-lg font-semibold">全部回忆</h2>

      {isLoading ? (
        <div className="mt-4 h-24 rounded-lg bg-surface-2" />
      ) : memories.length === 0 ? (
        <p className="mt-4 text-sm text-muted">还没有上传内容。</p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {memories.map((memory) => (
            <li
              key={memory.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-4"
            >
              <div className="flex-1">
                <p className="text-sm font-medium">{memory.title}</p>
                <p className="mt-1 text-xs text-muted">
                  {memory.kind === "video" ? "视频" : "照片"} · {memory.status}
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                {memory.status !== "published" ? (
                  <button
                    className="min-h-11 rounded-md border border-border px-3 text-sm"
                    onClick={() => changeStatus(memory, "published")}
                    type="button"
                  >
                    发布
                  </button>
                ) : (
                  <button
                    className="min-h-11 rounded-md border border-border px-3 text-sm"
                    onClick={() => changeStatus(memory, "hidden")}
                    type="button"
                  >
                    下架
                  </button>
                )}

                <button
                  className="min-h-11 rounded-md border border-border px-3 text-sm text-destructive"
                  onClick={() => removeMemory(memory)}
                  type="button"
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Link className="mt-8 inline-flex min-h-11 items-center text-primary" to="/">
        返回首页
      </Link>
    </section>
  );
}
