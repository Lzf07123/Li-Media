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

test("home waterfall card opens detail", async ({ page }) => {
  await mockPublicMemoryRoutes(page);
  await page.goto("/");

  await expect(page.locator(".masonry .post-card")).toHaveCount(1);
  await page.locator(".masonry .post-card").click();
  await page.getByRole("button", { name: "状态详情" }).click();
  await expect(page.getByRole("list", { name: "状态" })).toBeVisible();
  await expect(page.locator("img[alt=\"回忆预览\"]")).toBeVisible();
});

test("detail shows status strip without resource data", async ({ page }) => {
  await mockPublicMemoryRoutes(page);
  await page.goto(`/memories/${memoryId}`);

  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute(
    "content",
    "no-referrer",
  );
  await expect(page.getByText("湖边清晨")).toHaveCount(0);
  await expect(page.getByText("2400 × 1200")).toHaveCount(0);
  await page.getByRole("button", { name: "状态详情" }).click();
  await expect(page.getByRole("list", { name: "状态" })).toBeVisible();
  await expect(page.getByText("文件状态")).toBeVisible();
  await expect(page.getByText("远程状态")).toBeVisible();
  await expect(page.getByText("预览状态")).toBeVisible();
  await expect(page.getByText("播放状态")).toBeVisible();
  await expect(page.locator("img[alt=\"回忆预览\"]")).toBeVisible();
});

test("admin table is visible in dark mode", async ({ page }) => {
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
  await page.goto("/admin");

  await expect(page.getByRole("heading", { name: "回忆管理" })).toBeVisible();
  await expect(page.getByText("湖边清晨")).toBeVisible();
  await expect(page.getByRole("heading", { name: "百度网盘接入步骤" })).toBeVisible();
  await expect(page.getByText("/apps/Li&Media").first()).toBeVisible();
  await expect(page.getByText("远程索引扫描")).toBeVisible();
  await expect(page.getByText("预览就绪").first()).toBeVisible();
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
    await route.fulfill({ json: remoteMemory });
  });
  await page.goto("/");

  await expect(page.locator(".masonry .post-card")).toHaveCount(1);
  await expect(page.locator("img[alt=\"回忆预览\"]")).toHaveCount(0);
});

test("detail load failure shows a recovery state", async ({ page }) => {
  await page.route("**/api/v1/memories/**", async (route) => {
    await route.fulfill({ status: 500, json: { detail: "服务暂时不可用" } });
  });
  await page.goto(`/memories/${memoryId}`);

  await expect(page.getByText("页面不存在")).toBeVisible();
  await expect(page.getByRole("link", { name: "返回首页" })).toBeVisible();
});

test("remote video playback failure can be retried", async ({ page }) => {
  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/v1/memories/${memoryId}/file`) {
      await route.abort();
      return;
    }
    if (url.pathname === `/api/v1/memories/${memoryId}/thumbnail`) {
      await route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/webp",
      });
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
  await expect(page.getByText("视频播放失败")).toBeVisible();
  await expect(page.getByRole("button", { name: "重试" })).toBeVisible();
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
