import { expect, test, type Page } from "@playwright/test";

const memoryId = "4b1c9f4d-8f5e-4b1a-9f0d-4a4f39c92a01";
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const memory = {
  id: memoryId,
  title: "海边的下午",
  description: "",
  kind: "photo",
  status: "published",
  media_display_state: "displayable",
  public_display_state: "displayable",
  captured_at: "2026-01-01T08:30:00Z",
  location: null,
  file_url: `/api/v1/memories/${memoryId}/file`,
  thumbnail_url: `/api/v1/memories/${memoryId}/thumbnail`,
  duration_seconds: null,
  width: 2400,
  height: 1200,
  primary_file: {
    id: "8b4d0c02-e34e-4f6f-9c1a-f6a2b2f6c001",
    source: "baidupan",
    remote_path: "afternoon.png",
    remote_id: "4",
    parent_path: "/cloud",
    filename: "afternoon.png",
    extension: "png",
    remote_md5: null,
    mime_type: "image/png",
    size_bytes: 1024,
    modified_at: null,
    status: "matched",
    remote_state: "ready",
    thumbnail_state: "ready",
    thumbnail_failure_kind: null,
    stream_state: "ready",
    browser_compatibility: "supported",
    browser_format_summary: {},
    browser_compatibility_error: null,
    browser_compatibility_checked_at: null,
    last_synced_at: null,
    sync_error: null,
  },
  created_at: "2026-01-01T08:35:00Z",
  updated_at: "2026-01-01T08:35:00Z",
};

const memoryList = {
  items: [memory],
  total: 1,
  page: 1,
  page_size: 18,
  counts: { photo: 1, video: 0 },
  public_counts: { photo: 1, video: 0 },
};

async function mockLibrary(page: Page, items: object[] = memoryList.items) {
  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories") {
      await route.fulfill({
        json: { ...memoryList, items },
      });
      return;
    }
    if (url.pathname === "/api/v1/memories/recommend") {
      await route.fulfill({ json: [] });
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
    await route.fallback();
  });
  await page.route("**/api/v1/memories/preheat-status", async (route) => {
    await route.fulfill({ json: { status: "ready", processed: 1, total: 1 } });
  });
}

test("viewer uses one high-priority playback state and reports buffering", async ({ page }) => {
  const video = {
    ...memory,
    kind: "video",
    primary_file: {
      ...memory.primary_file,
      mime_type: "video/mp4",
      browser_compatibility: "supported",
    },
  };
  await mockLibrary(page, [video]);
  await page.route(`**/api/v1/memories/${memoryId}/file`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.fulfill({
      body: "not-a-real-video",
      contentType: "video/mp4",
    });
  });
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, "error", {
      configurable: true,
      get() {
        return { code: MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED };
      },
    });
  });

  await page.goto("/");
  await expect(page.locator(".post-card[data-preview-state='ready']")).toBeVisible();
  await page.locator(".post-card button").click();
  await page.getByRole("button", { name: "播放视频" }).click();
  await expect(page.locator(".viewer-status")).toHaveAttribute("data-scope", "playback");
  await expect(page.locator(".viewer-status")).toHaveAttribute("data-state", "loading");
  await page.locator("video").evaluate((element) => {
    element.dispatchEvent(new Event("waiting"));
  });
  await expect(page.locator(".viewer-status")).toHaveAttribute("data-state", "buffering");
  await page.locator("video").evaluate((element) => {
    element.dispatchEvent(new Event("error"));
  });
  await expect(page.locator(".viewer-status")).toHaveAttribute("data-state", "unsupported");
  await expect(page.locator(".video-playback-overlay")).toContainText(
    "当前浏览器不支持该视频编码",
  );
  await page
    .locator(".video-playback-overlay")
    .getByRole("button", { name: "重试" })
    .click();
  await expect(page.locator(".viewer-status")).toHaveAttribute("data-state", "loading");
});

test("viewer photo preview fails and retries through the shared state", async ({ page }) => {
  let largePreviewBlocked = true;
  await mockLibrary(page);
  await page.route("**/api/v1/memories/**/thumbnail**", async (route) => {
    const size = new URL(route.request().url()).searchParams.get("size");
    if (size === "1280" && largePreviewBlocked) {
      await route.fulfill({ status: 404, json: { detail: "not found" } });
      return;
    }
    await route.fulfill({
      body: Buffer.from(pngBase64, "base64"),
      contentType: "image/webp",
    });
  });

  await page.goto("/");
  await page.locator(".post-card button").click();
  await expect(page.locator(".viewer-status")).toHaveAttribute("data-scope", "preview");
  await expect(page.locator(".viewer-status")).toHaveAttribute("data-state", "failed");
  largePreviewBlocked = false;
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.locator(".viewer-status")).toHaveAttribute("data-state", "ready");
});

test("download failures use the same viewer state priority", async ({ page }) => {
  await mockLibrary(page);
  await page.addInitScript(() => {
    HTMLAnchorElement.prototype.click = function click() {
      throw new Error("download blocked");
    };
  });

  await page.goto("/");
  await page.locator(".post-card button").click();
  await page.locator(".photo-viewer").getByRole("button", { name: "下载" }).click();
  await expect(page.locator(".viewer-status")).toHaveAttribute("data-scope", "download");
  await expect(page.locator(".viewer-status")).toHaveAttribute("data-state", "failed");
});
