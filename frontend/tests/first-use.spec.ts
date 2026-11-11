import { expect, test, type Page } from "@playwright/test";

import { openViewerByCardClick } from "./helpers";

// 第一使用直觉契约：访客旅程断点修复的可执行验收。
// 覆盖：筛选回顶、返回键语义、暗区点击关闭、视频时长角标、
// 海报点播、空态内联清除、大图失败内联重试。

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const TOTAL_ITEMS = 12;

const idOf = (index: number) =>
  `51111111-1111-4111-8111-${String(index).padStart(12, "0")}`;

function memory(index: number) {
  const isVideo = index === 3 || index === 8;
  return {
    id: `51111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    title: `记忆 ${index + 1}`,
    description: "",
    kind: isVideo ? "video" : "photo",
    status: "published",
    media_display_state: "displayable",
    public_display_state: "displayable",
    captured_at: "2026-06-15T08:30:00Z",
    location: "杭州",
    file_url: `/api/v1/memories/m${index}/file`,
    thumbnail_url: `/api/v1/memories/m${index}/thumbnail`,
    duration_seconds: isVideo ? 42 : null,
    width: 1200,
    height: 800,
    primary_file: {
      id: `f${index}`,
      source: "baidupan",
      remote_id: "r",
      remote_path: "/cloud/p",
      filename: `p${index}.webp`,
      status: "matched",
      remote_state: "ready",
      thumbnail_state: "ready",
      thumbnail_failure_kind: null,
      stream_state: "ready",
      browser_compatibility: "supported",
      browser_format_summary: {},
      browser_compatibility_error: null,
      browser_compatibility_checked_at: null,
    },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

const items = Array.from({ length: TOTAL_ITEMS }, (_, i) => memory(i));

async function mockLibrary(
  page: Page,
  options?: { largeImageFailures?: { current: number } },
) {
  await page.route("**/api/v1/memories/recommend**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/v1/memories/preheat-status", (route) =>
    route.fulfill({ json: { status: "ready", processed: 4, total: 4 } }),
  );
  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories") {
      const kind = url.searchParams.get("kind");
      const keyword = url.searchParams.get("keyword");
      const filtered = items.filter((item) => {
        if (kind && item.kind !== kind) return false;
        if (keyword && !item.title.includes(keyword)) return false;
        return true;
      });
      return route.fulfill({
        json: {
          items: filtered,
          total: filtered.length,
          page: 1,
          page_size: 18,
          counts: {
            photo: filtered.filter((item) => item.kind === "photo").length,
            video: filtered.filter((item) => item.kind === "video").length,
          },
          public_counts: { photo: 10, video: 2 },
        },
      });
    }
    if (url.pathname.endsWith("/thumbnail")) {
      const failure = options?.largeImageFailures;
      if (
        failure &&
        url.searchParams.get("size") === "1280" &&
        failure.current === 0
      ) {
        failure.current += 1;
        return route.fulfill({ status: 500, json: { detail: "failed" } });
      }
      return route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/webp",
      });
    }
    return route.fulfill({ json: items[0] });
  });
}

test("filter change scrolls the canvas back to top", async ({ page }) => {
  await mockLibrary(page);
  await page.goto("/");
  await expect(page.locator(".masonry .post-card")).toHaveCount(12);

  await page.evaluate(() => window.scrollTo(0, 900));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);

  await page.getByRole("button", { name: "视频" }).first().click();
  await expect
    .poll(() => page.evaluate(() => window.scrollY), { timeout: 5_000 })
    .toBeLessThan(10);
});

test("browser back closes the viewer instead of stepping images", async ({
  page,
}) => {
  await mockLibrary(page);
  await page.goto("/");
  await page.locator(".masonry .post-card").first().click();
  await expect(page.locator(".photo-viewer")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`viewer=${idOf(0)}`));

  await page.locator(".photo-viewer-nav-next").click();
  await expect(page).toHaveURL(new RegExp(`viewer=${idOf(1)}`));

  // replace 语义：back 关闭 viewer 回画布，而不是回上一张图
  await page.goBack();
  await expect(page.locator(".photo-viewer")).toHaveCount(0);
  await expect(page.locator(".masonry .post-card").first()).toBeVisible();
});

test("clicking the dark backdrop closes the viewer without closing on image clicks", async ({
  page,
}) => {
  await mockLibrary(page);
  await page.goto("/");
  await openViewerByCardClick(page, page.locator(".masonry .post-card").first());
  await expect(page.locator(".photo-viewer")).toBeVisible();
  // 点击大图元素本体而非固定坐标：mock 图是 1×1，坐标式点击在高并发
  // 下可能早于图片挂载而落进透明滑动层（背板表面），被判定为暗区关闭
  await expect(
    page.locator(".photo-viewer .photo-viewer-image"),
  ).toBeAttached({ timeout: 15_000 });
  await page.locator(".photo-viewer .photo-viewer-image").click();
  await expect(page.locator(".photo-viewer")).toBeVisible();

  // 点击图片外的暗区关闭
  await page.mouse.click(120, 80);
  await expect(page.locator(".photo-viewer")).toHaveCount(0);
});

test("video badge surfaces the duration", async ({ page }) => {
  await mockLibrary(page);
  await page.goto("/");
  const badge = page
    .locator(".waterfall-badge")
    .filter({ hasText: "0:42" });
  await expect(badge).toHaveCount(2);
  await expect(badge.first()).toContainText("视频");
});

test("clicking the video poster starts playback", async ({ page }) => {
  await mockLibrary(page);
  await page.goto("/");
  await openViewerByCardClick(
    page,
    page.locator(".masonry .post-card").nth(8),
  );

  await page.locator(".video-viewer-shell").click();
  await expect(page.locator(".photo-viewer video")).toBeVisible();
});

test("empty search offers an inline clear action", async ({ page }) => {
  await mockLibrary(page);
  await page.goto("/");
  await expect(page.locator(".masonry .post-card")).toHaveCount(12);

  await page.getByRole("searchbox").fill("不存在的关键词");
  await expect(page.getByTestId("search-summary")).toBeVisible();
  const emptyState = page.locator(".empty-state");
  await expect(emptyState).toBeVisible();

  const clearButton = emptyState.getByRole("button", { name: "清除搜索" });
  await expect(clearButton).toBeVisible();
  await clearButton.click();
  await expect(page.locator(".masonry .post-card")).toHaveCount(12);
  await expect(emptyState).toHaveCount(0);
});

test("failed large image offers an inline retry next to the message", async ({
  page,
}, testInfo) => {
  // 队列自带 4 次退避重试（约 8s）后才进入失败态，放宽用例时限；
  // 1280 持续失败（任何队列重启都不会意外成功），直到卸载失败路由
  testInfo.setTimeout(40_000);
  await page.route("**/api/v1/memories/recommend**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/v1/memories/preheat-status", (route) =>
    route.fulfill({ json: { status: "ready", processed: 4, total: 4 } }),
  );
  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories") {
      return route.fulfill({
        json: {
          items,
          total: items.length,
          page: 1,
          page_size: 18,
          counts: { photo: 10, video: 2 },
          public_counts: { photo: 10, video: 2 },
        },
      });
    }
    if (
      url.pathname.endsWith("/thumbnail") &&
      url.searchParams.get("size") === "1280"
    ) {
      return route.fulfill({ status: 500, json: { detail: "failed" } });
    }
    if (url.pathname.endsWith("/thumbnail")) {
      return route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/webp",
      });
    }
    return route.fulfill({ json: items[0] });
  });

  await page.goto("/");
  await page.locator(".masonry .post-card").first().click();
  await expect(page.locator(".photo-viewer")).toBeVisible();

  const overlay = page.locator(".video-playback-overlay");
  await expect(overlay).toContainText("图片加载失败", { timeout: 20_000 });
  const retryButton = overlay.getByRole("button", { name: "重试" });
  await expect(retryButton).toBeVisible();

  // 放开失败：卸载失败路由、重挂全成功路由，点击内联重试后加载成功
  await page.unroute("**/api/v1/memories**");
  await page.route("**/api/v1/memories/recommend**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/thumbnail")) {
      return route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/webp",
      });
    }
    return route.fulfill({ json: items[0] });
  });
  await retryButton.click();
  await expect(overlay).toHaveCount(0, { timeout: 20_000 });
});
