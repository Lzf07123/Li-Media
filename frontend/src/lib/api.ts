export type Memory = {
  id: string;
  title: string;
  description: string;
  kind: "photo" | "video";
  status: "pending" | "draft" | "published" | "hidden" | "error";
  captured_at: string | null;
  location: string | null;
  file_url: string;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  primary_file: {
    id: string;
    source: string;
    remote_path: string;
    mime_type: string;
    size_bytes: number | null;
    status: "discovered" | "pending" | "syncing" | "matched" | "missing" | "removed" | "failed";
    last_synced_at: string | null;
    sync_error: string | null;
  } | null;
  created_at: string;
  updated_at: string;
};

export type MemoryListResponse = {
  items: Memory[];
  total: number;
  page: number;
  page_size: number;
};

export type MemoryAdminListResponse = {
  items: Memory[];
  total: number;
};

export type MemorySyncResponse = {
  discovered: number;
  matched: number;
  failed: number;
};

export type MemoryBatchUpdatePayload = {
  ids: string[];
  title?: string;
  description?: string;
  location?: string;
  captured_at?: string;
  status?: Memory["status"];
};

export type MemoryExportReport = {
  exported_at: string;
  items: Memory[];
  total: number;
};

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";

export function resolveMediaUrl(path: string): string {
  if (!path.startsWith("/") || !API_BASE_URL.startsWith("http")) {
    return path;
  }

  try {
    return `${new URL(API_BASE_URL).origin}${path}`;
  } catch {
    return path;
  }
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function readApiErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: unknown };

    if (typeof payload.detail === "string") {
      return payload.detail;
    }
  } catch {
    // Fall through to the generic message.
  }

  return `请求失败（${response.status}）`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      Accept: "application/json",
    },
    credentials: "include",
    ...init,
  });

  if (!response.ok) {
    throw new ApiError(await readApiErrorMessage(response), response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function getMemories(params: {
  keyword?: string;
  kind?: string;
  page?: number;
  page_size?: number;
} = {}): Promise<MemoryListResponse> {
  const search = new URLSearchParams();

  if (params.keyword) {
    search.set("keyword", params.keyword);
  }

  if (params.kind) {
    search.set("kind", params.kind);
  }

  if (params.page) {
    search.set("page", String(params.page));
  }

  if (params.page_size) {
    search.set("page_size", String(params.page_size));
  }

  const query = search.toString();

  return request<MemoryListResponse>(`/memories${query ? `?${query}` : ""}`);
}

export function getMemoryById(memoryId: string): Promise<Memory> {
  return request<Memory>(`/memories/${memoryId}`);
}

export async function getAdminMemories(
): Promise<MemoryAdminListResponse> {
  return request<MemoryAdminListResponse>("/admin/memories", {
    headers: {
      Accept: "application/json",
    },
  });
}

export async function loginAdmin(token: string): Promise<void> {
  await request<void>(
    "/admin/login",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token }),
    },
  );
}

export async function logoutAdmin(): Promise<void> {
  await request<void>("/admin/logout", { method: "POST" });
}

export async function syncMemories(
  maxFiles = 5,
): Promise<MemorySyncResponse> {
  return request<MemorySyncResponse>("/admin/sync", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ max_files: maxFiles }),
  });
}

export async function createMemory(
  payload: {
    file: File;
    title?: string;
    description: string;
    location?: string;
    captured_at?: string;
  },
): Promise<Memory> {
  const form = new FormData();
  form.set("file", payload.file);
  form.set("description", payload.description);

  if (payload.title) {
    form.set("title", payload.title);
  }

  if (payload.location) {
    form.set("location", payload.location);
  }

  if (payload.captured_at) {
    form.set("captured_at", payload.captured_at);
  }

  return request<Memory>("/admin/memories", {
    method: "POST",
    headers: {
      Accept: "application/json",
    },
    body: form,
  });
}

export async function updateMemory(
  memoryId: string,
  payload: Partial<Pick<Memory, "title" | "description" | "location" | "status">>,
): Promise<Memory> {
  return request<Memory>(`/admin/memories/${memoryId}`, {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export async function deleteMemory(memoryId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/admin/memories/${memoryId}`, {
    method: "DELETE",
    headers: {
      Accept: "application/json",
    },
    credentials: "include",
  });

  if (!response.ok) {
    throw new ApiError(await readApiErrorMessage(response), response.status);
  }
}

export async function batchUpdateMemories(
  payload: MemoryBatchUpdatePayload,
): Promise<{ updated: number }> {
  return request<{ updated: number }>("/admin/memories/batch", {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export async function exportMemories(
  ids: string[],
): Promise<MemoryExportReport> {
  return request<MemoryExportReport>("/admin/memories/export", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ids }),
  });
}
