export type Memory = {
  id: string;
  title: string;
  description: string;
  kind: "photo" | "video";
  status: "pending" | "draft" | "published" | "hidden" | "error";
  captured_at: string | null;
  location: string | null;
  thumbnail_path: string | null;
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
