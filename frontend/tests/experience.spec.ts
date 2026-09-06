import { expect, test, type Page } from "@playwright/test";

const memoryId = "0e1c6c1d-34a4-459b-8f85-e7ac76b1fbd0";
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const directUrl = "https://baidu.invalid/private-download?access_token=test-token";

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

const memoryList = {
  items: [memory],
  total: 1,
  page: 1,
  page_size: 24,
  counts: { photo: 1, video: 0 },
};

async function mockMemoryRoutes(page: Page, listResponse = memoryList) {
  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());

    if (url.pathname === "/api/v1/memories") {
      await route.fulfill({ json: listResponse });
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
      await route.fulfill({
        json: {
          direct_url: directUrl,
          expires_at: "2026-01-01T09:35:00Z",
          mime_type: "image/png",
          size_bytes: 1024,
        },
      });
      return;
    }

    await route.fulfill({ status: 404, json: { detail: "not found" } });
  });
}

test("photo viewer supports keyboard zoom and restores scroll lock", async ({ page }) => {
  await mockMemoryRoutes(page);
  await page.goto(`/memories/${memoryId}`);
  await page.getByRole("button", { name: "打开图片查看器" }).click();

  const viewer = page.locator(".photo-viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer.locator(".photo-viewer-image")).toHaveAttribute("src", /\/api\/v1\/memories\/.*\/file/);
  await page.keyboard.press("+");
  await expect(viewer.locator(".photo-viewer-image")).toHaveAttribute(
    "style",
    /scale\(1\.2\d*\)/,
  );

  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
});

test("failed direct link refreshes and recovers through server route", async ({ page }) => {
  let directRequests = 0;

  await page.route("**/private-download**", async (route) => {
    await route.abort("failed");
  });
  await mockMemoryRoutes(page);
  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());

    if (url.pathname === `/api/v1/memories/${memoryId}/direct-url`) {
      directRequests += 1;
      if (directRequests === 1) {
        await route.fulfill({
          json: {
            direct_url: directUrl,
            expires_at: "2027-01-01T09:35:00Z",
            mime_type: "image/png",
            size_bytes: 1024,
          },
        });
      } else {
        await route.fulfill({ status: 403, json: { detail: "forbidden" } });
      }
      return;
    }

    await route.fallback();
  });

  await page.goto(`/memories/${memoryId}`);
  await page.getByRole("button", { name: "打开图片查看器" }).click();
  await expect.poll(() => directRequests).toBeGreaterThan(1);
  await expect(page.locator(".photo-viewer-image")).toHaveAttribute(
    "src",
    new RegExp(`/api/v1/memories/${memoryId}/file`),
  );
  await expect(page.locator(".photo-viewer-error")).toHaveCount(0);
});

test("kind, keyword, sort and scroll restore after opening detail", async ({ page }) => {
  const items = Array.from({ length: 24 }, (_, index) => ({
    ...memory,
    id: `${memoryId.slice(0, -1)}${String(index).padStart(2, "0")}`,
    width: index % 2 === 0 ? 2400 : 1200,
    height: index % 2 === 0 ? 1200 : 1800,
  }));
  await mockMemoryRoutes(page, {
    ...memoryList,
    items,
    total: items.length,
    counts: { photo: items.length, video: 0 },
  });
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto("/");

  await page.getByRole("button", { name: /^照片/ }).click();
  await page.locator("#library-search").fill("lake");
  await expect(page).toHaveURL(/kind=photo&keyword=lake/);

  await page.locator("select").selectOption("updated_desc");
  await expect(page).toHaveURL(/sort=updated_desc/);

  await page.mouse.wheel(0, 240);
  await page.locator(".masonry .post-card").first().click();
  await expect(page).toHaveURL(new RegExp(`/memories/${memoryId}`));

  await page.goBack();
  await expect(page).toHaveURL(/kind=photo&keyword=lake&sort=updated_desc/);
  await expect(page.locator("#library-search")).toHaveValue("lake");
  await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeGreaterThan(80);
});

test("waterfall remains stable across acceptance viewports", async ({ page }) => {
  const expectedColumns: Record<number, string> = {
    360: "2",
    768: "3",
    1280: "5",
    1600: "6",
  };
  const items = Array.from({ length: 24 }, (_, index) => ({
    ...memory,
    id: `${memoryId.slice(0, -1)}${String(index).padStart(1, "0")}`,
    width: index % 2 === 0 ? 2400 : 1200,
    height: index % 2 === 0 ? 1200 : 1800,
  }));

  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories") {
      await route.fulfill({
        json: { ...memoryList, items, total: items.length, counts: { photo: 24, video: 0 } },
      });
      return;
    }
    await route.fulfill({
      body: Buffer.from(pngBase64, "base64"),
      contentType: "image/webp",
    });
  });

  for (const [index, viewport] of [
    { width: 360, height: 740 },
    { width: 768, height: 900 },
    { width: 1280, height: 900 },
    { width: 1600, height: 1000 },
  ].entries()) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.locator(".masonry .post-card")).toHaveCount(24);
    const columnCount = await page.evaluate(
      () => getComputedStyle(document.querySelector(".masonry")!).columnCount,
    );
    expect(columnCount).toBe(expectedColumns[viewport.width]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({
      fullPage: true,
      path: `test-results/experience-${viewport.width}.png`,
    });
    expect(index).toBeLessThan(4);
  }
});

test("24 media page stays within load, transfer and layout-shift budgets", async ({ page }) => {
  const items = Array.from({ length: 24 }, (_, index) => ({
    ...memory,
    id: `${memoryId.slice(0, -1)}${String(index).padStart(2, "0")}`,
    width: index % 2 === 0 ? 2400 : 1200,
    height: index % 2 === 0 ? 1200 : 1800,
  }));

  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories") {
      await route.fulfill({
        json: { ...memoryList, items, total: items.length, counts: { photo: 24, video: 0 } },
      });
      return;
    }
    await route.fulfill({
      body: Buffer.from(pngBase64, "base64"),
      contentType: "image/webp",
    });
  });

  await page.goto("/");
  await expect(page.locator(".masonry .post-card")).toHaveCount(24);
  const metrics = await page.evaluate(() => new Promise<{
    firstPaint: number;
    transferBytes: number;
    layoutShift: number;
  }>((resolve) => {
    let layoutShift = 0;
    const observer = new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        if (entry.entryType === "layout-shift" && !entry.hadRecentInput) {
          layoutShift += entry.value;
        }
      }
    });
    observer.observe({ buffered: true, type: "layout-shift" });

    window.setTimeout(() => {
      const navigation = performance.getEntriesByType("navigation")[0];
      const transferBytes = performance
        .getEntriesByType("resource")
        .filter((entry) => entry.name.includes("/thumbnail"))
        .reduce((total, entry) => total + ("transferSize" in entry ? entry.transferSize : 0), 0);
      observer.disconnect();
      resolve({
        firstPaint: navigation?.domContentLoadedEventEnd ?? 0,
        transferBytes,
        layoutShift,
      });
    }, 500);
  }));

  expect(metrics.firstPaint).toBeLessThan(3000);
  expect(metrics.transferBytes).toBeLessThan(2 * 1024 * 1024);
  expect(metrics.layoutShift).toBeLessThan(0.1);
});
