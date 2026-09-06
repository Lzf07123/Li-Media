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
    remote_id: string | null;
    remote_path: string;
    parent_path: string;
    filename: string;
    extension: string | null;
    remote_md5: string | null;
    mime_type: string;
    size_bytes: number | null;
    modified_at: string | null;
    status: "discovered" | "pending" | "syncing" | "matched" | "missing" | "removed" | "failed";
    remote_state: "unverified" | "ready" | "missing" | "failed";
    thumbnail_state: "missing" | "ready" | "failed";
    thumbnail_failure_kind: string | null;
    stream_state: "unavailable" | "ready" | "failed";
    last_synced_at: string | null;
    sync_error: string | null;
  } | null;
  created_at: string;
  updated_at: string;
};

type MemoryFileStatus = NonNullable<Memory["primary_file"]>["status"];
type MemoryRemoteState = NonNullable<Memory["primary_file"]>["remote_state"];
type MemoryThumbnailState = NonNullable<Memory["primary_file"]>["thumbnail_state"];
type MemoryStreamState = NonNullable<Memory["primary_file"]>["stream_state"];

export type MemoryFileSummary = {
  id: string;
  source: string;
  remote_id: string | null;
  remote_path: string;
  filename: string;
  status: MemoryFileStatus;
  remote_state: MemoryRemoteState;
  thumbnail_state: MemoryThumbnailState;
  thumbnail_failure_kind: string | null;
  stream_state: MemoryStreamState;
};

export type MemorySummary = {
  id: string;
  title: string;
  description: string;
  kind: Memory["kind"];
  status: Memory["status"];
  captured_at: string | null;
  location: string | null;
  file_url: string;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  primary_file: MemoryFileSummary | null;
  created_at: string;
  updated_at: string;
};

export type MemoryListResponse = MemorySummaryListResponse;

export type MemorySummaryListResponse = {
  items: MemorySummary[];
  total: number;
  page: number;
  page_size: number;
  counts: {
    photo: number;
    video: number;
  };
};

export type MemoryAdminListResponse = {
  items: Memory[];
  total: number;
};

export type MemorySyncResponse = {
  discovered: number;
  matched: number;
  deleted: number;
  failed: number;
  scan_task: RemoteScanTask;
};

export type RemoteScanTask = {
  id: string;
  remote_dir: string;
  status: "running" | "completed" | "failed";
  max_depth: number;
  max_items: number;
  delete_missing: boolean;
  processed_items: number;
  scanned_files: number;
  scanned_directories: number;
  discovered: number;
  refreshed: number;
  skipped: number;
  limit_reached: boolean;
  failure_reason: string | null;
  started_at: string;
  completed_at: string | null;
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

export type RemoteConfig = {
  configured: boolean;
  oauth_configured: boolean;
  authorized: boolean;
  scan_dir: string;
  redirect_uri: string;
  docs_url: string;
  token_expires_at: string | null;
};

export type CleanupStats = {
  memories: number;
  remote_file_indexes: number;
  scan_tasks: number;
  thumbnail_files: number;
  nginx_cache_files: number;
  estimated_bytes_to_free: number;
};

export type CleanupResult = {
  dry_run: boolean;
  stats: CleanupStats;
  duration_seconds: number;
  completed_at: string | null;
  file_cleanup_error: string | null;
};

export type BaiduAuthorizeResponse = {
  authorize_url: string;
  expires_at: string;
};

export type ServiceStatus = {
  status: "ok" | "unavailable";
  detail: string | null;
  pool_status: string | null;
  dialect: string | null;
  used_memory_bytes: number | null;
  max_memory_bytes: number | null;
  connected_clients: number | null;
};

export type BackendRuntimeStatus = {
  app_name: string;
  version: string;
  python_version: string;
  platform: string;
  pid: number;
  database: ServiceStatus;
  redis: ServiceStatus;
  task_thread_pool_size: number;
  stack_guard: string;
};

export type RemoteStorageCounts = {
  total: number;
  remote_ready: number;
  remote_missing: number;
  remote_failed: number;
  thumbnail_ready: number;
  thumbnail_missing: number;
  thumbnail_failed: number;
  thumbnail_failure_kinds: Record<string, number>;
  stream_ready: number;
  stream_failed: number;
};

export type RemoteStorageStatus = {
  provider: string;
  configured: boolean;
  oauth_configured: boolean;
  authorized: boolean;
  scan_dir: string;
  token_expires_at: string | null;
  direct_link_cache_entries: number;
  counts: RemoteStorageCounts;
  last_scan: RemoteScanTask | null;
};

export type TaskQueueStatus = {
  active: number;
  queued: number;
  limit: number;
  queue_limit: number;
};

export type SystemStatus = {
  generated_at: string;
  backend: BackendRuntimeStatus;
  remote_storage: RemoteStorageStatus;
  tasks: Record<keyof typeof TASK_KEYS, TaskQueueStatus>;
  metrics: Record<string, number>;
  resources: {
    process: {
      rss_kbytes: number | null;
      threads: number | null;
      pss_kbytes: number | null;
    };
    cgroup: {
      memory_current_bytes: number | null;
      memory_peak_bytes: number | null;
      memory_max_bytes: number | null;
      pids_current: number | null;
      pids_max: number | null;
      oom: number | null;
      oom_kill: number | null;
    };
    temporary: {
      files: number | null;
      bytes: number | null;
      free_bytes: number | null;
      total_bytes: number | null;
      used_bytes: number | null;
      usage_ratio: number | null;
    };
    stack: {
      soft_kbytes: number | null;
      hard_kbytes: number | null;
    };
    limits: {
      backend_memory_bytes: number | null;
      temp_disk_quota_bytes: number | null;
      temp_max_files: number | null;
    };
  };
};

export type ThumbnailPreheatJob = {
  id: string;
  max_size: number;
  kind: "photo" | "video" | null;
  limit: number;
  status: "queued" | "running" | "completed" | "failed";
  total: number;
  processed: number;
  generated: number;
  cached: number;
  failed: number;
  message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type ThumbnailPreheatPayload = {
  max_size: "240" | "480" | "768" | "1280";
  kind?: "photo" | "video";
  limit: number;
};

const TASK_KEYS = {
  scan: true,
  direct_probe: true,
  derivative: true,
  stream: true,
} as const;

export type MediaDirectLink = {
  direct_url: string;
  expires_at: string | null;
  mime_type: string;
  size_bytes: number | null;
};

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";

export function resolveMediaUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }

  if (!path.startsWith("/") || !API_BASE_URL.startsWith("http")) {
    return path;
  }

  try {
    return `${new URL(API_BASE_URL).origin}${path}`;
  } catch {
    return path;
  }
}

export function resolveThumbnailUrl(
  path: string | null | undefined,
  size: "240" | "480" | "768" | "1280",
): string | null {
  if (!path) {
    return null;
  }

  const url = resolveMediaUrl(path);
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}ratio=1&size=${size}`;
}

export function resolveThumbnailSrcSet(
  path: string | null | undefined,
): string | null {
  if (!path) {
    return null;
  }

  return (["240", "480", "768", "1280"] as const)
    .map((size) => {
      const url = resolveThumbnailUrl(path, size);
      return url ? `${url} ${size}w` : null;
    })
    .filter(Boolean)
    .join(", ");
}

export async function requestLocalMediaCleanup(
  confirm: boolean,
): Promise<CleanupResult> {
  return request<CleanupResult>("/admin/cleanup", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ confirm }),
  });
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
  sort?: string;
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

  if (params.sort) {
    search.set("sort", params.sort);
  }

  const query = search.toString();

  return request<MemoryListResponse>(`/memories${query ? `?${query}` : ""}`);
}

export async function getMemoryRecommendations(
  limit = 8,
  kind?: "photo" | "video",
): Promise<MemorySummary[]> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (kind) {
    query.set("kind", kind);
  }

  return request<MemorySummary[]>(`/memories/recommend?${query.toString()}`, {
    headers: {
      Accept: "application/json",
    },
  });
}

export function getMemoryById(memoryId: string): Promise<MemorySummary> {
  return request<MemorySummary>(`/memories/${memoryId}`);
}

export async function getMediaDirectLink(
  memoryId: string,
  purpose: "play" | "download" = "play",
): Promise<MediaDirectLink> {
  return request<MediaDirectLink>(`/memories/${memoryId}/direct-url?purpose=${purpose}`, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
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
  resumeTaskId?: string,
): Promise<MemorySyncResponse> {
  return request<MemorySyncResponse>("/admin/sync", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      max_items: 5000,
      delete_missing: true,
      resume_task_id: resumeTaskId,
    }),
  });
}

export async function getLatestRemoteScan(): Promise<RemoteScanTask | null> {
  return request<RemoteScanTask | null>("/admin/remote-scan/latest");
}

export async function retryRemoteEntry(memoryFileId: string): Promise<Memory> {
  return request<Memory>(`/admin/remote-entries/${memoryFileId}/retry`, {
    method: "POST",
  });
}

export async function getRemoteConfig(): Promise<RemoteConfig> {
  return request<RemoteConfig>("/admin/remote-config");
}

export async function getSystemStatus(): Promise<SystemStatus> {
  return request<SystemStatus>("/admin/system/status", {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export async function startThumbnailPreheat(
  payload: ThumbnailPreheatPayload,
): Promise<ThumbnailPreheatJob> {
  return request<ThumbnailPreheatJob>("/admin/thumbnails/preheat", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export async function getLatestThumbnailPreheat(): Promise<ThumbnailPreheatJob | null> {
  return request<ThumbnailPreheatJob | null>("/admin/thumbnails/preheat/latest");
}

export async function startBaiduAuthorization(): Promise<BaiduAuthorizeResponse> {
  return request<BaiduAuthorizeResponse>("/admin/baidu/authorize");
}

export async function completeBaiduAuthorization(payload: {
  code: string;
  state: string;
}): Promise<{ authorized: boolean; expires_at: string | null }> {
  return request<{ authorized: boolean; expires_at: string | null }>(
    "/admin/baidu/callback",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
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
