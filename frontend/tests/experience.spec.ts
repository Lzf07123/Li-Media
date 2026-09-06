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

    if (url.pathname === "/api/v1/memories/recommend") {
      await route.fulfill({ json: [] });
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
  await page.goto("/");
  await page.locator(".masonry .post-card").first().click();

  const viewer = page.locator(".photo-viewer");
  await expect(viewer).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`viewer=${memoryId}`));
  await expect(viewer.locator(".photo-viewer-image")).toHaveAttribute("src", /size=1280/);
  await expect
    .poll(() =>
      page.evaluate(() => document.querySelector(".photo-viewer")?.parentElement === document.body),
    )
    .toBe(true);
  const edgeHits = await page.evaluate(() =>
    [8, window.innerHeight - 8].map(
      (y) => document.elementFromPoint(window.innerWidth / 2, y)?.closest(".photo-viewer") !== null,
    ),
  );
  expect(edgeHits).toEqual([true, true]);
  await page.keyboard.press("+");
  await expect(viewer.locator(".photo-viewer-image")).toHaveAttribute(
    "style",
    /scale\(1\.2\d*\)/,
  );

  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
});

test("large viewer navigates with arrows and keyboard", async ({ page }) => {
  const items = ["第一张", "第二张", "第三张"].map((title, index) => ({
    ...memory,
    id: `0e1c6c1d-34a4-459b-8f85-e7ac76b1fbd${index}`,
    title,
  }));

  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories") {
      await route.fulfill({
        json: {
          items,
          total: items.length,
          page: 1,
          page_size: 24,
          counts: { photo: items.length, video: 0 },
        },
      });
      return;
    }

    if (url.pathname.endsWith("/thumbnail")) {
      await route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/webp",
      });
      return;
    }

    await route.fulfill({ status: 404, json: { detail: "not found" } });
  });

  await page.goto("/");
  await page.locator(".masonry .post-card").first().click();
  const viewer = page.locator(".photo-viewer");
  await expect(viewer).toBeVisible();

  await page.getByRole("button", { name: "下一张" }).click();
  await expect(viewer).toHaveAttribute("aria-label", "第二张");
  await page.keyboard.press("ArrowRight");
  await expect(viewer).toHaveAttribute("aria-label", "第三张");
  await page.getByRole("button", { name: "上一张" }).click();
  await expect(viewer).toHaveAttribute("aria-label", "第二张");
  await page.keyboard.press("ArrowLeft");
  await expect(viewer).toHaveAttribute("aria-label", "第一张");
});

test("video direct link refreshes after playback failure", async ({ page }) => {
  let directRequests = 0;
  const recoveredDirectUrl = `${directUrl}&v=2`;
  const recoveredRequest = page.waitForRequest(recoveredDirectUrl);

  await page.route("**/private-download**", async (route) => {
    if (route.request().url() === recoveredDirectUrl) {
      await route.fulfill({ body: Buffer.from("video"), contentType: "video/mp4" });
      return;
    }
    await route.abort("failed");
  });
  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());

    if (url.pathname === "/api/v1/memories") {
      await route.fulfill({
        json: {
          ...memoryList,
          items: [{
            ...memory,
            kind: "video",
            primary_file: { ...memory.primary_file, mime_type: "video/mp4" },
          }],
          counts: { photo: 0, video: 1 },
        },
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
      directRequests += 1;
      await route.fulfill({
        json: {
          direct_url: directRequests === 1 ? directUrl : recoveredDirectUrl,
          expires_at: "2027-01-01T09:35:00Z",
          mime_type: "video/mp4",
          size_bytes: 5,
        },
      });
      return;
    }

    await route.fallback();
  });

  await page.goto("/");
  await page.locator(".masonry .post-card").click();
  await page.getByRole("button", { name: "播放视频" }).click();
  await expect.poll(() => directRequests).toBeGreaterThan(1);
  await recoveredRequest;
});

test("kind and scroll restore after closing viewer", async ({ page }) => {
  const items = Array.from({ length: 18 }, (_, index) => ({
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
  await page.setViewportSize({ width: 360, height: 700 });
  await page.goto("/");

  await page.getByRole("button", { name: /^照片/ }).click();
  await expect(page).toHaveURL(/kind=photo/);

  await page.evaluate(() => window.scrollTo(0, 240));
  await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeGreaterThan(80);
  await page.locator(".masonry .post-card").first().click();
  await expect(page).toHaveURL(new RegExp(`viewer=${memoryId}`));

  await page.locator(".photo-viewer").getByRole("button", { name: "取消" }).click();
  await expect(page).toHaveURL(/kind=photo/);
  await expect(page.locator("#library-search")).toHaveCount(0);
  await expect(page.locator("select[aria-label='排序']")).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeGreaterThan(80);
});

test("kind filter is centered and visually compact", async ({ page }) => {
  await mockMemoryRoutes(page);
  await page.goto("/");

  const toolbarBox = await page.locator(".filter-toolbar").boundingBox();
  const controlBox = await page.locator(".segmented").boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(controlBox).not.toBeNull();
  if (!toolbarBox || !controlBox) {
    return;
  }

  const leftMargin = controlBox.x - toolbarBox.x;
  const rightMargin = toolbarBox.x + toolbarBox.width - controlBox.x - controlBox.width;
  expect(Math.abs(leftMargin - rightMargin)).toBeLessThanOrEqual(1);

  const height = await page
    .locator(".segmented")
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(height).toBeLessThanOrEqual(38);

  const buttonHeight = await page
    .locator(".segmented button")
    .first()
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(buttonHeight).toBeLessThanOrEqual(32);
});

test("infinite canvas appends segmented thumbnail pages while scrolling", async ({ page }) => {
  const requestedPages: string[] = [];
  let releasePageTwo: (() => void) | undefined;
  const pageTwoReady = new Promise<void>((resolve) => {
    releasePageTwo = resolve;
  });
  const items = Array.from({ length: 36 }, (_, index) => ({
    ...memory,
    id: `${memoryId.slice(0, -1)}${String(index).padStart(2, "0")}`,
    width: index % 2 === 0 ? 2400 : 1200,
    height: index % 2 === 0 ? 1200 : 1800,
  }));

  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories") {
      const pageNumber = Number(url.searchParams.get("page") ?? "1");
      requestedPages.push(String(pageNumber));
      if (pageNumber === 2) {
        await pageTwoReady;
      }
      await route.fulfill({
        json: {
          items: items.slice((pageNumber - 1) * 18, pageNumber * 18),
          total: items.length,
          page: pageNumber,
          page_size: 18,
          counts: { photo: items.length, video: 0 },
        },
      });
      return;
    }
    if (url.pathname === "/api/v1/memories/recommend") {
      await route.fulfill({ json: [] });
      return;
    }
    await route.fulfill({
      body: Buffer.from(pngBase64, "base64"),
      contentType: "image/webp",
    });
  });

  await page.goto("/");
  await expect(page.locator(".masonry .post-card")).toHaveCount(18);
  await expect.poll(() => requestedPages).toContain("1");

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect.poll(() => requestedPages).toContain("2");
  releasePageTwo?.();
  await expect(page.locator(".masonry .post-card")).toHaveCount(36);
  await expect(page.locator(".pagination")).toHaveCount(0);
});

test("thumbnail image loads are queued with bounded concurrency", async ({ page }) => {
  let activeThumbnailRequests = 0;
  let maxActiveThumbnailRequests = 0;
  const items = Array.from({ length: 24 }, (_, index) => {
    const itemId = `${memoryId.slice(0, -1)}${String(index).padStart(2, "0")}`;
    return {
      ...memory,
      id: itemId,
      thumbnail_url: `/api/v1/memories/${itemId}/thumbnail`,
      file_url: `/api/v1/memories/${itemId}/file`,
    };
  });

  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories") {
      await route.fulfill({
        json: {
          items,
          total: items.length,
          page: 1,
          page_size: 24,
          counts: { photo: items.length, video: 0 },
        },
      });
      return;
    }

    if (url.pathname === "/api/v1/memories/recommend") {
      await route.fulfill({ json: [] });
      return;
    }

    if (!url.pathname.endsWith("/thumbnail")) {
      await route.fulfill({ status: 404, json: { detail: "not found" } });
      return;
    }

    activeThumbnailRequests += 1;
    maxActiveThumbnailRequests = Math.max(
      maxActiveThumbnailRequests,
      activeThumbnailRequests,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    activeThumbnailRequests -= 1;
    await route.fulfill({
      body: Buffer.from(pngBase64, "base64"),
      contentType: "image/webp",
    });
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(page.locator(".masonry .post-card")).toHaveCount(24);
  await expect.poll(() => activeThumbnailRequests).toBe(0);
  expect(maxActiveThumbnailRequests).toBeGreaterThan(1);
  expect(maxActiveThumbnailRequests).toBeLessThanOrEqual(4);
});

test("recommendations render first inside the canvas without a separate rail", async ({ page }) => {
  const requestedRecommendations: string[] = [];
  await mockMemoryRoutes(page);
  await page.route("**/api/v1/memories/recommend**", async (route) => {
    const url = new URL(route.request().url());
    requestedRecommendations.push(url.searchParams.get("kind") ?? "");
    await route.fulfill({
      json: [
        { ...memory, id: "0e1c6c1d-34a4-459b-8f85-e7ac76b1fb99", title: "推荐一" },
        { ...memory, title: "推荐二" },
      ],
    });
  });

  await page.goto("/");
  await expect(page.locator(".recommendation-rail")).toHaveCount(0);
  await expect(page.locator(".masonry .post-card")).toHaveCount(2);
  await page.locator(".masonry .post-card").first().click();
  await expect(page.locator(".photo-viewer")).toHaveAttribute("aria-label", "推荐一");
  await expect.poll(() => requestedRecommendations).toContain("");

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^照片/ }).click();
  await expect.poll(() => requestedRecommendations).toContain("photo");
});

test("video preparation shows one playback overlay", async ({ page }) => {
  let resolveDirectLink: ((value: unknown) => void) | undefined;
  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories") {
      await route.fulfill({
        json: {
          ...memoryList,
          items: [{
            ...memory,
            kind: "video",
            primary_file: { ...memory.primary_file, mime_type: "video/mp4" },
          }],
          counts: { photo: 0, video: 1 },
        },
      });
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
      await new Promise<void>((resolve) => {
        resolveDirectLink = resolve;
      });
      await route.fulfill({
        json: {
          direct_url: directUrl,
          expires_at: "2027-01-01T09:35:00Z",
          mime_type: "video/mp4",
          size_bytes: 5,
        },
      });
      return;
    }
    await route.fallback();
  });

  await page.goto("/");
  await page.locator(".masonry .post-card").click();
  await page.getByRole("button", { name: "播放视频" }).click();
  await expect(page.locator(".video-playback-overlay")).toBeVisible();
  expect(await page.locator(".video-playback-message").count()).toBe(1);
  expect(await page.locator(".viewer-fallback").count()).toBe(0);
  resolveDirectLink?.();
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

test("photo viewer selects card and viewer sizes by viewport", async ({ page }) => {
  const thumbnailSizes: string[] = [];
  await mockMemoryRoutes(page);
  await page.route("**/api/v1/memories/**/thumbnail**", async (route) => {
    thumbnailSizes.push(new URL(route.request().url()).searchParams.get("size") ?? "");
    await route.fallback();
  });

  await page.goto("/");
  await expect(page.locator(".masonry .post-card")).toHaveCount(1);
  await expect.poll(() => thumbnailSizes).toContain("240");
  expect(thumbnailSizes).not.toContain("1280");

  await page.locator(".masonry .post-card").click();
  await expect(page.locator(".photo-viewer")).toBeVisible();
  await expect.poll(() => thumbnailSizes).toContain("1280");
});

test("mobile viewer uses 480px poster instead of desktop large image", async ({ page }) => {
  const thumbnailSizes: string[] = [];
  await mockMemoryRoutes(page);
  await page.route("**/api/v1/memories/**/thumbnail**", async (route) => {
    thumbnailSizes.push(new URL(route.request().url()).searchParams.get("size") ?? "");
    await route.fallback();
  });

  await page.setViewportSize({ width: 360, height: 700 });
  await page.goto("/");
  await page.locator(".masonry .post-card").click();
  await expect(page.locator(".photo-viewer")).toBeVisible();
  await expect.poll(() => thumbnailSizes).toContain("480");
  expect(thumbnailSizes).not.toContain("1280");
});

test("video does not request playback until play and can use server fallback", async ({ page }) => {
  let serverMediaRequests = 0;
  let directRequests = 0;
  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories") {
      await route.fulfill({
        json: {
          ...memoryList,
          items: [{
            ...memory,
            kind: "video",
            primary_file: { ...memory.primary_file, mime_type: "video/mp4" },
          }],
          counts: { photo: 0, video: 1 },
        },
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
      directRequests += 1;
      await route.fulfill({ status: 403, json: { detail: "forbidden" } });
      return;
    }
    if (url.pathname === `/api/v1/memories/${memoryId}/file`) {
      serverMediaRequests += 1;
      await route.fulfill({ body: Buffer.from("video"), contentType: "video/mp4" });
      return;
    }
    await route.fallback();
  });

  await page.goto("/");
  await page.locator(".masonry .post-card").click();
  await expect(page.locator(".photo-viewer")).toBeVisible();
  expect(directRequests).toBe(0);
  await page.getByRole("button", { name: "播放视频" }).click();
  await expect.poll(() => directRequests).toBe(1);
  await page.getByRole("button", { name: "回退服务器播放" }).click();
  await expect.poll(() => serverMediaRequests).toBe(1);
});

test("download button requests a short-lived direct link", async ({ page }) => {
  const purposes: string[] = [];
  await mockMemoryRoutes(page);
  await page.route(`**/api/v1/memories/${memoryId}/direct-url**`, async (route) => {
    purposes.push(new URL(route.request().url()).searchParams.get("purpose") ?? "");
    await route.fallback();
  });

  await page.goto("/");
  await page.locator(".masonry .post-card").click();
  await page.locator(".photo-viewer").getByRole("button", { name: "下载" }).click();
  await expect.poll(() => purposes).toContain("download");
  await expect(page.locator(".viewer-status")).toContainText("可用");
});
