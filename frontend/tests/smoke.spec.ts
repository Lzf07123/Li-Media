import { expect, test, type Page } from "@playwright/test";

const memoryId = "0e1c6c1d-34a4-459b-8f85-e7ac76b1fbd0";
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const memory = {
  id: memoryId,
  title: "湖边清晨",
  description: "安静的水面和缓慢亮起来的天。",
  kind: "photo",
  status: "published",
  captured_at: "2026-01-01T08:30:00Z",
  location: "杭州",
  file_url: `/api/v1/memories/${memoryId}/file`,
  thumbnail_url: `/api/v1/memories/${memoryId}/thumbnail`,
  duration_seconds: null,
  width: 2400,
  height: 1200,
  primary_file: {
    id: "e0c37e9a-8ec7-4b8f-8c92-2e6ee3b18cd1",
    source: "baidupan",
    remote_path: "lake.png",
    mime_type: "image/png",
    size_bytes: 1024,
    status: "matched",
    remote_state: "ready",
    thumbnail_state: "ready",
    stream_state: "ready",
    remote_id: "123456",
    remote_md5: null,
    parent_path: "/cloud",
    filename: "lake.png",
    extension: "png",
    modified_at: null,
    last_synced_at: null,
    sync_error: null,
  },
  created_at: "2026-01-01T08:35:00Z",
  updated_at: "2026-01-01T08:35:00Z",
};

const scanTask = {
  id: "7f0e1e58-47b8-42b7-8cc2-77a84006c47a",
  remote_dir: "/apps/Li&Media",
  status: "completed",
  max_depth: 8,
  max_items: 5000,
  processed_items: 1,
  scanned_files: 1,
  scanned_directories: 0,
  discovered: 1,
  refreshed: 0,
  skipped: 0,
  limit_reached: false,
  failure_reason: null,
  started_at: "2026-01-01T08:30:00Z",
  completed_at: "2026-01-01T08:31:00Z",
};

const systemStatus = {
  generated_at: "2026-09-07T08:00:00Z",
  backend: {
    app_name: "Li&Media",
    version: "0.1.0",
    python_version: "3.12.0",
    platform: "Linux",
    pid: 100,
    database: { status: "ok", detail: null, pool_status: "Pool size: 8", dialect: "postgresql", used_memory_bytes: null, max_memory_bytes: null, connected_clients: null },
    redis: { status: "ok", detail: "7.0", pool_status: null, dialect: null, used_memory_bytes: 1024, max_memory_bytes: 201326592, connected_clients: 2 },
    task_thread_pool_size: 24,
    stack_guard: "task thread pool + cgroup memory + pids limit",
  },
  remote_storage: {
    provider: "baidupan",
    configured: true,
    oauth_configured: true,
    authorized: true,
    scan_dir: "/apps/Li&Media",
    token_expires_at: null,
    direct_link_cache_entries: 1,
    counts: {
      total: 1,
      remote_ready: 1,
      remote_missing: 0,
      remote_failed: 0,
      thumbnail_ready: 1,
      thumbnail_missing: 0,
      thumbnail_failed: 0,
      stream_ready: 1,
      stream_failed: 0,
    },
    last_scan: scanTask,
  },
  tasks: {
    scan: { active: 0, queued: 0, limit: 1, queue_limit: 1 },
    direct_probe: { active: 0, queued: 0, limit: 4, queue_limit: 16 },
    derivative: { active: 0, queued: 0, limit: 2, queue_limit: 32 },
    stream: { active: 0, queued: 0, limit: 16, queue_limit: 32 },
  },
  metrics: {
    active_jobs: 0,
    queue_depth: 0,
    queue_wait_total_ms: 12,
    child_peak_kbytes: 64096,
  },
  resources: {
    process: { rss_kbytes: 59080, threads: 8, pss_kbytes: 49960 },
    cgroup: {
      memory_current_bytes: 47366144,
      memory_peak_bytes: 80941056,
      memory_max_bytes: 268435456,
      pids_current: 8,
      pids_max: 64,
      oom: 0,
      oom_kill: 0,
    },
    temporary: {
      files: 0,
      bytes: 0,
      free_bytes: 1024,
      total_bytes: 4096,
      used_bytes: 3072,
      usage_ratio: 0.75,
    },
    stack: { soft_kbytes: null, hard_kbytes: null },
    limits: {
      backend_memory_bytes: 268435456,
      temp_disk_quota_bytes: 536870912,
      temp_max_files: 8,
    },
  },
};

const memoryList = {
  items: [memory],
  total: 1,
  page: 1,
  page_size: 24,
  counts: { photo: 1, video: 0 },
};

async function mockPublicMemoryRoutes(page: Page) {
  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());

    if (url.pathname === "/api/v1/memories") {
      await route.fulfill({ json: memoryList });
      return;
    }

    if (url.pathname === `/api/v1/memories/${memoryId}`) {
      await route.fulfill({ json: memory });
      return;
    }

    if (url.pathname === `/api/v1/memories/${memoryId}/file`) {
      await route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/png",
      });
      return;
    }

    if (url.pathname === `/api/v1/memories/${memoryId}/thumbnail`) {
      await route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/webp",
      });
      return;
    }
    if (url.pathname === `/api/v1/memories/${memoryId}/direct-url`) {
      await route.fulfill({ status: 403, json: { detail: "forbidden" } });
      return;
    }

    await route.fulfill({ status: 404, json: { detail: "not found" } });
  });
}

test("home shows memory and toggles between light and dark", async ({ page }) => {
  await mockPublicMemoryRoutes(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "回忆库" })).toBeVisible();
  await expect(page.locator(".masonry .post-card")).toHaveCount(1);
  await expect(page.locator("img[alt=\"回忆预览\"]")).toBeVisible();
  await expect(page.locator("html")).not.toHaveClass(/dark/);

  await page.getByRole("button", { name: "切换到深色主题" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(
    page.getByRole("button", { name: "切换到浅色主题" }),
  ).toBeVisible();
});

test("home waterfall card opens viewer", async ({ page }) => {
  await mockPublicMemoryRoutes(page);
  await page.goto("/");

  await expect(page.locator(".masonry .post-card")).toHaveCount(1);
  await page.locator(".masonry .post-card").click();
  await expect(page).toHaveURL(new RegExp(`viewer=${memoryId}`));
  await expect(page.locator(".photo-viewer")).toBeVisible();
  await expect(page.locator("img[alt=\"回忆预览\"]")).toBeVisible();
});

test("old detail address redirects to viewer", async ({ page }) => {
  await mockPublicMemoryRoutes(page);
  await page.goto(`/memories/${memoryId}`);

  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute(
    "content",
    "no-referrer",
  );
  await expect(page).toHaveURL(new RegExp(`viewer=${memoryId}`));
  await expect(page.locator(".photo-viewer")).toBeVisible();
  await expect(page.locator("img[alt=\"回忆预览\"]")).toBeVisible();
});

test("admin table is visible in dark mode", async ({ page }) => {
  let statusRequests = 0;
  await page.route("**/api/v1/admin/memories", async (route) => {
    await route.fulfill({ json: { items: [memory], total: 1 } });
  });
  await page.route("**/api/v1/admin/remote-config", async (route) => {
    await route.fulfill({
      json: {
        configured: true,
        scan_dir: "/apps/Li&Media",
        docs_url: "https://pan.baidu.com/union/doc/",
      },
    });
  });
  await page.route("**/api/v1/admin/remote-scan/latest", async (route) => {
    await route.fulfill({ json: scanTask });
  });
  await page.route("**/api/v1/admin/system/status", async (route) => {
    statusRequests += 1;
    await route.fulfill({ json: systemStatus });
  });
  await page.goto("/admin");

  await expect(page.getByRole("heading", { name: "回忆管理" })).toBeVisible();
  await expect(page.getByText("湖边清晨")).toBeVisible();
  await expect(page.getByRole("heading", { name: "百度网盘接入步骤" })).toBeVisible();
  await expect(page.getByText("/apps/Li&Media").first()).toBeVisible();
  await expect(page.getByText("远程索引扫描")).toBeVisible();
  await expect(page.getByText("后端栈与资源状态")).toBeVisible();
  await expect(page.getByText("远端存储状态")).toBeVisible();
  await expect(page.getByText("百度网盘", { exact: true })).toBeVisible();
  await expect(page.getByText("资源与队列")).toBeVisible();
  await expect(page.getByText("预览就绪").first()).toBeVisible();
  await page.getByRole("button", { name: "刷新状态" }).click();
  await expect.poll(() => statusRequests).toBeGreaterThan(1);
  await page.getByRole("button", { name: "切换到深色主题" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(
    page.getByRole("button", { name: "切换到浅色主题" }),
  ).toBeVisible();
});

test("remote photo without preview uses placeholder", async ({ page }) => {
  const remoteMemory = {
    ...memory,
    thumbnail_url: null,
    primary_file: {
      ...memory.primary_file,
      source: "baidupan",
      thumbnail_state: "missing",
    },
  };

  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories") {
      await route.fulfill({ json: { items: [remoteMemory], total: 1, page: 1, page_size: 24 } });
      return;
    }
    if (url.pathname === "/api/v1/memories/recommend") {
      await route.fulfill({ json: [] });
      return;
    }
    await route.fulfill({ json: remoteMemory });
  });
  await page.goto("/");

  await expect(page.locator(".masonry .post-card")).toHaveCount(1);
  await expect(page.locator("img[alt=\"回忆预览\"]")).toHaveCount(0);
});

test("missing old detail link shows viewer recovery state", async ({ page }) => {
  await page.route("**/api/v1/memories/**", async (route) => {
    await route.fulfill({ status: 500, json: { detail: "服务暂时不可用" } });
  });
  await page.goto(`/memories/${memoryId}`);

  await expect(page).toHaveURL(new RegExp(`viewer=${memoryId}`));
  await expect(page.getByText("请检查地址，或回到回忆库首页。")).toBeVisible();
});

test("remote video playback failure can be retried", async ({ page }) => {
  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/v1/memories/${memoryId}/file`) {
      await route.abort();
      return;
    }
    if (url.pathname === "/api/v1/memories/recommend") {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === `/api/v1/memories/${memoryId}/thumbnail`) {
      await route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/webp",
      });
      return;
    }
    if (url.pathname === `/api/v1/memories/${memoryId}/direct-url`) {
      await route.fulfill({ status: 403, json: { detail: "forbidden" } });
      return;
    }
    if (url.pathname === `/api/v1/memories/${memoryId}`) {
      await route.fulfill({
        json: {
          ...memory,
          kind: "video",
          primary_file: {
            ...memory.primary_file,
            mime_type: "video/mp4",
            stream_state: "ready",
          },
        },
      });
      return;
    }
    await route.fulfill({ json: { items: [], total: 0, page: 1, page_size: 24 } });
  });

  await page.goto(`/memories/${memoryId}`);
  await expect(page.locator(".photo-viewer")).toBeVisible();
  await page.getByRole("button", { name: "播放视频" }).click();
  await page.getByRole("button", { name: "回退服务器播放" }).click();
  await expect(page.getByText("视频播放失败").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "重试" }).first()).toBeVisible();
});

test("admin can retry a remote entry", async ({ page }) => {
  const remoteMemory = {
    ...memory,
    primary_file: {
      ...memory.primary_file,
      source: "baidupan",
    },
  };
  await page.route("**/api/v1/admin/memories", async (route) => {
    await route.fulfill({ json: { items: [remoteMemory], total: 1 } });
  });
  await page.route("**/api/v1/admin/remote-config", async (route) => {
    await route.fulfill({
      json: {
        configured: true,
        scan_dir: "/apps/Li&Media",
        docs_url: "https://pan.baidu.com/union/doc/",
      },
    });
  });
  await page.route("**/api/v1/admin/remote-scan/latest", async (route) => {
    await route.fulfill({ json: scanTask });
  });
  let retried = false;
  await page.route("**/api/v1/admin/remote-entries/*/retry", async (route) => {
    retried = true;
    await route.fulfill({ json: memory });
  });

  await page.goto("/admin");
  await page.getByRole("button", { name: "重试远程" }).click();
  await expect.poll(() => retried).toBe(true);
});

test("admin cleanup confirms before clearing local index", async ({ page }) => {
  let memories = [memory];
  await page.route("**/api/v1/admin/memories", async (route) => {
    await route.fulfill({ json: { items: memories, total: memories.length } });
  });
  await page.route("**/api/v1/admin/remote-config", async (route) => {
    await route.fulfill({
      json: {
        configured: true,
        oauth_configured: true,
        authorized: true,
        scan_dir: "/apps/Li&Media",
        redirect_uri: "/admin/baidu/callback",
        docs_url: "https://pan.baidu.com/union/doc/",
        token_expires_at: null,
      },
    });
  });
  await page.route("**/api/v1/admin/remote-scan/latest", async (route) => {
    await route.fulfill({ json: scanTask });
  });
  await page.route("**/api/v1/admin/cleanup", async (route) => {
    const payload = route.request().postDataJSON() as { confirm: boolean };
    if (!payload.confirm) {
      await route.fulfill({
        json: {
          dry_run: true,
          stats: {
            memories: 1,
            remote_file_indexes: 1,
            scan_tasks: 1,
            thumbnail_files: 2,
            nginx_cache_files: 0,
            estimated_bytes_to_free: 18,
          },
          duration_seconds: 0,
          completed_at: null,
          file_cleanup_error: null,
        },
      });
      return;
    }

    memories = [];
    await route.fulfill({
      json: {
        dry_run: false,
        stats: {
          memories: 1,
          remote_file_indexes: 1,
          scan_tasks: 1,
          thumbnail_files: 2,
          nginx_cache_files: 0,
          estimated_bytes_to_free: 18,
        },
        duration_seconds: 0.1,
        completed_at: "2026-09-06T00:00:00Z",
        file_cleanup_error: null,
      },
    });
  });

  await page.goto("/admin");
  await page.getByRole("button", { name: "一键清理" }).click();
  await expect(page.getByText("确认清理全部本地索引？")).toBeVisible();
  await page.getByRole("button", { name: "确认清理" }).click();
  await expect(page.getByText("本地清理完成，网盘资源未变化。")).toBeVisible();
  await expect(page.getByText("网盘中还没有照片或视频；请先完成接入步骤，再点击扫描。")).toBeVisible();
});
