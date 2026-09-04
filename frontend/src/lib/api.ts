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

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      Accept: "application/json",
    },
    ...init,
  });

  if (!response.ok) {
    throw new ApiError(`请求失败（${response.status}）`, response.status);
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
  token: string,
): Promise<MemoryAdminListResponse> {
  return request<MemoryAdminListResponse>("/admin/memories", {
    headers: {
      Accept: "application/json",
      "X-Admin-Token": token,
    },
  });
}

export async function createMemory(
  token: string,
  payload: {
    file: File;
    title: string;
    description: string;
    location?: string;
    captured_at?: string;
  },
): Promise<Memory> {
  const form = new FormData();
  form.set("file", payload.file);
  form.set("title", payload.title);
  form.set("description", payload.description);

  if (payload.location) {
    form.set("location", payload.location);
  }

  if (payload.captured_at) {
    form.set("captured_at", payload.captured_at);
  }

  return request<Memory>("/admin/memories", {
    method: "POST",
    headers: {
      "X-Admin-Token": token,
    },
    body: form,
  });
}

export async function updateMemory(
  token: string,
  memoryId: string,
  payload: Partial<Pick<Memory, "title" | "description" | "location" | "status">>,
): Promise<Memory> {
  return request<Memory>(`/admin/memories/${memoryId}`, {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Admin-Token": token,
    },
    body: JSON.stringify(payload),
  });
}

export async function deleteMemory(token: string, memoryId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/admin/memories/${memoryId}`, {
    method: "DELETE",
    headers: {
      "X-Admin-Token": token,
    },
  });

  if (!response.ok) {
    throw new ApiError(`请求失败（${response.status}）`, response.status);
  }
}
