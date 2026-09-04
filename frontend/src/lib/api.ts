export type Media = {
  id: string;
  title: string;
  original_title: string | null;
  kind: "movie" | "tv" | "anime" | "documentary" | "mv";
  status: "pending" | "draft" | "published" | "hidden" | "error";
  year: number | null;
  overview: string;
  rating: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  created_at: string;
  updated_at: string;
};

export type MediaListResponse = {
  items: Media[];
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

export async function getMedia(params: {
  keyword?: string;
  kind?: string;
  page?: number;
  page_size?: number;
} = {}): Promise<MediaListResponse> {
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

  return request<MediaListResponse>(`/media${query ? `?${query}` : ""}`);
}

export function getMediaById(mediaId: string): Promise<Media> {
  return request<Media>(`/media/${mediaId}`);
}

