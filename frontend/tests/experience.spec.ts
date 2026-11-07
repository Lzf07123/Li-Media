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
  public_counts: { photo: 1, video: 0 },
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
  await page.route("**/api/v1/memories/preheat-status", async (route) => {
    await route.fulfill({ json: { status: "ready", processed: 1, total: 1 } });
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

test("viewer chunk is prefetched after the home list renders", async ({ page }) => {
  await mockMemoryRoutes(page);
  const chunkRequest = page.waitForRequest(/assets\/MediaViewer-.*\.js/);
  const adminChunkRequest = page.waitForRequest(/assets\/AdminPage-.*\.js/, {
    timeout: 1000,
  }).catch(() => null);

  await page.goto("/");
  await expect(page.locator(".masonry .post-card")).toHaveCount(1);
  await chunkRequest;
  const adminChunk = await adminChunkRequest;
  expect(adminChunk).toBeNull();
});

test("home preheat state is explicit and cards use responsive priority", async ({ page }) => {
  await mockMemoryRoutes(page);
  await page.route("**/api/v1/memories/preheat-status", async (route) => {
    await route.fulfill({ json: { status: "running", processed: 2, total: 5 } });
  });
  await page.route("**/thumbnail*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({
      body: Buffer.from(pngBase64, "base64"),
      contentType: "image/webp",
    });
  });

  await page.goto("/");
  await expect(
    page.locator(".masonry .post-card").first().locator(".card-shimmer"),
  ).toBeVisible();
  await expect(page.getByTestId("preheat-status")).toContainText(
    "正在优化预览",
  );
  await expect(page.getByTestId("preheat-status")).toContainText("2/5");
  await expect(page.getByRole("progressbar")).toBeVisible();

  const firstImage = page.locator(".masonry .post-card").first().locator("img");
  await expect
    .poll(async () => await firstImage.getAttribute("src"))
    .toContain("size=240");
  await expect(firstImage).toHaveAttribute("fetchpriority", "high");
  await expect(firstImage).toBeVisible();
  await expect(
    page.locator(".masonry .post-card").first().locator(".card-shimmer"),
  ).toHaveCount(0);
});

test("preheat completion refreshes the canvas when the user is near the top", async ({
  page,
}) => {
  let listRequests = 0;
  let preheatPolls = 0;
  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories") {
      listRequests += 1;
      await route.fulfill({ json: memoryList });
      return;
    }
    if (url.pathname === "/api/v1/memories/recommend") {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/api/v1/memories/preheat-status") {
      preheatPolls += 1;
      await route.fulfill({
        json:
          preheatPolls === 1
            ? { status: "running", processed: 1, total: 2 }
            : { status: "ready", processed: 2, total: 2 },
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
    await route.fulfill({ json: memory });
  });

  await page.goto("/");
  await expect(page.locator(".masonry .post-card")).toHaveCount(1);
  await expect(page.getByTestId("preheat-status")).toContainText(
    "正在优化预览",
  );
  expect(listRequests).toBe(1);

  // 非终态时切回前台会立即重查预热状态，模拟「预热中 → 完成」过渡
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect.poll(() => listRequests, { timeout: 5_000 }).toBe(2);
  await expect(page.getByTestId("preheat-status")).toHaveCount(0);
});

test("preheat completion does not disturb a scrolled reader", async ({
  page,
}) => {
  let listRequests = 0;
  let preheatPolls = 0;
  const tallList = {
    ...memoryList,
    items: Array.from({ length: 30 }, (_, index) => ({
      ...memory,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      title: `湖边清晨 ${index + 1}`,
      thumbnail_url: `/api/v1/memories/batch-${index}/thumbnail`,
    })),
  };
  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories") {
      listRequests += 1;
      await route.fulfill({ json: tallList });
      return;
    }
    if (url.pathname === "/api/v1/memories/recommend") {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/api/v1/memories/preheat-status") {
      preheatPolls += 1;
      await route.fulfill({
        json:
          preheatPolls === 1
            ? { status: "running", processed: 1, total: 2 }
            : { status: "ready", processed: 2, total: 2 },
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
    await route.fulfill({ json: memory });
  });

  await page.goto("/");
  await expect(page.locator(".masonry .post-card").first()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 1200));
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(500);

  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  // 终态已到达（横幅退场），但滚动深处的用户不被自动刷新打断
  await expect.poll(() => preheatPolls).toBe(2);
  await expect(page.getByTestId("preheat-status")).toHaveCount(0);
  expect(listRequests).toBe(1);
});

test("home preheat notice converges and stays clear at 375px", async ({ page }) => {
  await mockMemoryRoutes(page);
  await page.route("**/api/v1/memories/preheat-status", async (route) => {
    await route.fulfill({ json: { status: "not_preheated", processed: 0, total: 1 } });
  });

  await page.setViewportSize({ width: 375, height: 720 });
  await page.goto("/");
  const notice = page.getByTestId("preheat-status");
  await expect(notice).toHaveText("正在优化预览，首次加载可能稍慢");
  await expect(notice).toHaveAttribute("aria-live", "polite");

  const boxes = [
    notice,
    page.locator(".filter-toolbar"),
    page.locator("h1"),
    page.locator(".site-footer"),
    page.locator(".masonry .post-card").first(),
  ];
  for (const box of boxes) {
    await expect(box).toBeVisible();
  }
  expect(
    (await page.locator(".site-header").boundingBox())?.height ?? Number.POSITIVE_INFINITY,
  ).toBeLessThanOrEqual(66.01);
  expect(
    (await page.locator(".site-footer").boundingBox())?.height ?? Number.POSITIVE_INFINITY,
  ).toBeLessThanOrEqual(57.01);
  const rects = await Promise.all(
    boxes.map((locator) => locator.boundingBox()),
  );
  for (let left = 0; left < rects.length; left += 1) {
    for (let right = left + 1; right < rects.length; right += 1) {
      const a = rects[left]!;
      const b = rects[right]!;
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      expect(overlapX * overlapY).toBeLessThanOrEqual(1);
    }
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);

  await page.route("**/api/v1/memories/preheat-status", async (route) => {
    await route.fulfill({ json: { status: "ready", processed: 1, total: 1 } });
  });
  await page.reload();
  // ready 是终态：状态行整体移除，不再保留空元素占位。
  await expect(page.getByTestId("preheat-status")).toHaveCount(0);
});

test("home shows an independent preheat unavailable state", async ({ page }) => {
  await mockMemoryRoutes(page);
  await page.route("**/api/v1/memories/preheat-status", async (route) => {
    await route.fulfill({ status: 503, json: { detail: "unavailable" } });
  });

  await page.goto("/");
  await expect(page.getByTestId("preheat-status")).toHaveText(
    "预览状态暂不可用",
  );
  await expect(page.locator(".masonry .post-card")).toHaveCount(1);
});

test("preheat polling stops at terminal states and refreshes on visibility while active", async ({ page }) => {
  let statusRequests = 0;
  let status: "ready" | "not_preheated" = "ready";
  await mockMemoryRoutes(page);
  await page.route("**/api/v1/memories/preheat-status", async (route) => {
    statusRequests += 1;
    await route.fulfill({
      json: { status, processed: 1, total: 1 },
    });
  });
  const fireVisibility = async () => {
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
    });
    await page.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  };

  await page.goto("/");
  await expect.poll(() => statusRequests).toBe(1);
  await page.waitForTimeout(1100);
  expect(statusRequests).toBe(1);

  await fireVisibility();
  await page.waitForTimeout(200);
  // ready 是终态：切回标签页不再重新请求。
  expect(statusRequests).toBe(1);

  status = "not_preheated";
  await page.reload();
  await expect.poll(() => statusRequests).toBe(2);
  await fireVisibility();
  // 非终态仍需跟随后台预热进度，切回标签页立即刷新一次。
  await expect.poll(() => statusRequests).toBe(3);
  await page.waitForTimeout(100);
  expect(statusRequests).toBe(3);
});

test("preheat status retries failures with finite backoff", async ({ page }) => {
  let statusRequests = 0;
  await mockMemoryRoutes(page);
  await page.route("**/api/v1/memories/preheat-status", async (route) => {
    statusRequests += 1;
    if (statusRequests <= 3) {
      await route.fulfill({ status: 503, json: { detail: "unavailable" } });
      return;
    }
    await route.fulfill({
      json: { status: "running", processed: 1, total: 2 },
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("preheat-status")).toHaveText("预览状态暂不可用");
  await page.waitForTimeout(2300);
  expect(statusRequests).toBeGreaterThanOrEqual(3);
  const failedRequests = statusRequests;
  await page.waitForTimeout(300);
  expect(statusRequests).toBe(failedRequests);
});

test("home card shimmer is disabled under reduced motion", async ({ page }) => {
  await mockMemoryRoutes(page);
  await page.route("**/thumbnail*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      body: Buffer.from(pngBase64, "base64"),
      contentType: "image/webp",
    });
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const shimmer = page.locator(".masonry .post-card").first().locator(".card-shimmer");
  await expect(shimmer).toBeVisible();
  await expect
    .poll(async () =>
      shimmer.evaluate((element) => getComputedStyle(element, "::after").animationName),
    )
    .toBe("none");
  await expect(shimmer.evaluate((element) => getComputedStyle(element, "::after").transform)).resolves.toBe(
    "none",
  );
});

test("home skeleton matches masonry columns and media frames", async ({ page }) => {
  await mockMemoryRoutes(page);
  await page.route("**/thumbnail*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.fulfill({
      body: Buffer.from(pngBase64, "base64"),
      contentType: "image/webp",
    });
  });

  await page.setViewportSize({ width: 375, height: 720 });
  await page.goto("/");
  await expect(page.locator(".masonry > .canvas-column")).toHaveCount(2);
  await expect(
    page.locator(".masonry > .canvas-column").first().locator(".media-frame"),
  ).toBeVisible();

  await page.setViewportSize({ width: 1024, height: 720 });
  await expect(page.locator(".masonry > .canvas-column")).toHaveCount(4);
  await expect(
    page.locator(".masonry > .canvas-column").first().locator(".post-card").first(),
  ).toBeVisible();
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
          public_counts: { photo: items.length, video: 0 },
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

test("video playback uses server stream and avoids direct links", async ({ page }) => {
  let directRequests = 0;
  let serverRequests = 0;

  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());

    if (url.pathname === "/api/v1/memories/recommend") {
      await route.fulfill({ json: [] });
      return;
    }
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

    if (url.pathname === `/api/v1/memories/${memoryId}/file`) {
      serverRequests += 1;
      await route.fulfill({ body: Buffer.from("video"), contentType: "video/mp4" });
      return;
    }

    await route.fallback();
  });

  await page.goto("/");
  await expect(page.locator(".masonry .post-card")).toHaveCount(1);
  await page.getByRole("button", { name: "湖边清晨" }).click();
  await page.getByRole("button", { name: "播放视频" }).click();
  await expect.poll(() => serverRequests).toBe(1);
  expect(directRequests).toBe(0);
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

  await page.locator(".photo-viewer").getByRole("button", { name: "关闭" }).click();
  await expect(page).toHaveURL(/kind=photo/);
  // 关闭查看器后保持筛选与搜索状态，仅恢复滚动位置。
  await expect(page.locator("#library-search")).toHaveValue("");
  await expect(page.locator("select[aria-label='排序']")).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeGreaterThan(80);
});

test("search, kind filter and refresh share one toolbar row", async ({ page }) => {
  await mockMemoryRoutes(page);
  await page.goto("/");

  const toolbarBox = await page.locator(".filter-toolbar").boundingBox();
  const searchBox = await page.locator(".library-search").boundingBox();
  const controlBox = await page.locator(".segmented").boundingBox();
  const refreshBox = await page
    .locator(".filter-toolbar .icon-btn")
    .boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(searchBox).not.toBeNull();
  expect(controlBox).not.toBeNull();
  expect(refreshBox).not.toBeNull();
  if (!toolbarBox || !searchBox || !controlBox || !refreshBox) {
    return;
  }

  // 搜索、筛选、换一批在同一行内（桌面），垂直中心对齐
  expect(searchBox.y + searchBox.height / 2).toBeCloseTo(
    controlBox.y + controlBox.height / 2,
    0,
  );
  expect(refreshBox.y + refreshBox.height / 2).toBeCloseTo(
    controlBox.y + controlBox.height / 2,
    0,
  );
  // 筛选组紧随搜索框之后（间距 ≤ 16px）
  expect(controlBox.x - (searchBox.x + searchBox.width)).toBeLessThanOrEqual(16);

  const height = await page
    .locator(".segmented")
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(height).toBeLessThanOrEqual(38.01);

  const buttonHeight = await page
    .locator(".segmented button")
    .first()
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(buttonHeight).toBeLessThanOrEqual(32.01);
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
          public_counts: { photo: items.length, video: 0 },
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
  await expect(page.getByTestId("canvas-footer")).toHaveAttribute("data-state", "loading");
  await expect(page.getByTestId("canvas-footer")).toContainText("正在加载更多回忆");
  releasePageTwo?.();
  await expect(page.locator(".masonry .post-card")).toHaveCount(36);
  await expect(page.locator(".pagination")).toHaveCount(0);
  await expect(page.getByTestId("canvas-footer")).toHaveAttribute("data-state", "end");
  await expect(page.getByTestId("canvas-footer")).toContainText("已经到底了");
  await expect(page.getByTestId("canvas-footer")).toContainText("当前筛选共 36 条");
});

test("infinite canvas advances pages when appended items overlap", async ({ page }) => {
  const requestedPages: string[] = [];
  const firstPage = Array.from({ length: 18 }, (_, index) => ({
    ...memory,
    id: `${memoryId.slice(0, -1)}${String(index).padStart(2, "0")}`,
  }));
  const duplicatePage = [...firstPage];
  const thirdPage = Array.from({ length: 18 }, (_, index) => ({
    ...memory,
    id: `${memoryId.slice(0, -1)}${String(index + 18).padStart(2, "0")}`,
  }));

  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories") {
      const pageNumber = Number(url.searchParams.get("page") ?? "1");
      requestedPages.push(String(pageNumber));
      const items = pageNumber === 1 ? firstPage : pageNumber === 2 ? duplicatePage : thirdPage;
      await route.fulfill({
        json: {
          items,
          total: 54,
          page: pageNumber,
          page_size: 18,
          counts: { photo: 54, video: 0 },
          public_counts: { photo: 54, video: 0 },
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
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect.poll(() => requestedPages).toContain("3");
  await expect(page.locator(".masonry .post-card")).toHaveCount(36);
});

test("infinite canvas keeps content when appending fails", async ({ page }) => {
  const requestedPages: number[] = [];
  let pageThreeFailed = false;
  const items = Array.from({ length: 54 }, (_, index) => ({
    ...memory,
    id: `${memoryId.slice(0, -1)}${String(index).padStart(2, "0")}`,
    width: 1200,
    height: 1600,
  }));

  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories") {
      const pageNumber = Number(url.searchParams.get("page") ?? "1");
      if (url.searchParams.get("page")) {
        requestedPages.push(pageNumber);
      }
      if (pageNumber >= 3 && !pageThreeFailed) {
        pageThreeFailed = true;
        await route.fulfill({ status: 429, json: { detail: "rate limited" } });
        return;
      }
      await route.fulfill({
        json: {
          items: items.slice((pageNumber - 1) * 18, pageNumber * 18),
          total: items.length,
          page: pageNumber,
          page_size: 18,
          counts: { photo: items.length, video: 0 },
          public_counts: { photo: items.length, video: 0 },
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
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator(".masonry .post-card")).toHaveCount(36);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.getByText("更多回忆加载失败")).toBeVisible();
  await expect
    .poll(() => requestedPages.filter((pageNumber) => pageNumber === 3).length)
    .toBe(1);
  await expect(page.getByRole("button", { name: "重试加载" })).toBeVisible();
  await expect(page.getByTestId("canvas-footer")).toHaveAttribute("data-state", "retry");
  await expect(page.getByTestId("canvas-footer")).toHaveAttribute("aria-live", "polite");
  const loadingStyle = await page.evaluate(() => {
    const canvas = document.querySelector(".infinite-canvas")!.getBoundingClientRect();
    const row = document.querySelector(".canvas-loading") as HTMLElement;
    const style = getComputedStyle(row);
    return {
      widthRatio: row.getBoundingClientRect().width / canvas.width,
      display: style.display,
      justifyContent: style.justifyContent,
    };
  });
  expect(loadingStyle.display).toBe("flex");
  expect(loadingStyle.justifyContent).toBe("center");
  expect(loadingStyle.widthRatio).toBeCloseTo(1, 2);
  await page.getByRole("button", { name: "重试加载" }).click();
  await expect(page.locator(".masonry .post-card")).toHaveCount(54);
  await expect(page.getByTestId("canvas-footer")).toHaveAttribute("data-state", "end");
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
          public_counts: { photo: items.length, video: 0 },
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
  expect(maxActiveThumbnailRequests).toBeLessThanOrEqual(2);
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

test("home refresh button requests a new random canvas", async ({ page }) => {
  const randomListRequests: URL[] = [];
  const recommendationRequests: URL[] = [];

  await mockMemoryRoutes(page);
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/memories") {
      randomListRequests.push(url);
    }
    if (url.pathname === "/api/v1/memories/recommend") {
      recommendationRequests.push(url);
    }
  });

  await page.goto("/");
  await expect(page.locator(".masonry .post-card")).toHaveCount(1);
  const refreshButton = page.getByRole("button", { name: "换一批" });
  await expect(refreshButton).toBeEnabled();

  await refreshButton.click();
  await expect.poll(() => randomListRequests.length).toBe(2);
  await expect.poll(() => recommendationRequests.length).toBe(2);
  expect(randomListRequests.every((url) => url.searchParams.get("sort") === "random")).toBe(true);
  expect(new Set(randomListRequests.map((url) => url.searchParams.get("seed"))).size).toBe(2);
});

test("video preparation shows one playback overlay", async ({ page }) => {
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
    if (url.pathname === `/api/v1/memories/${memoryId}/file`) {
      // 准备窗口 800ms：确保"准备中"状态在断言期间稳定，不受调度抖动影响。
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.fulfill({ body: Buffer.from("video"), contentType: "video/mp4" });
      return;
    }
    await route.fallback();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "湖边清晨" }).click();
  await page.getByRole("button", { name: "播放视频" }).click();
  await expect(page.locator(".video-playback-overlay")).toBeVisible();
  expect(await page.locator(".video-playback-message").count()).toBe(1);
  expect(await page.locator(".viewer-fallback").count()).toBe(0);
});

test("waterfall remains stable across acceptance viewports", async ({ page }) => {
  const expectedColumns: Record<number, number> = {
    375: 2,
    768: 3,
    1280: 5,
    1600: 6,
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
    { width: 375, height: 740 },
    { width: 768, height: 900 },
    { width: 1280, height: 900 },
    { width: 1600, height: 1000 },
  ].entries()) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.locator(".masonry .post-card")).toHaveCount(24);
    const columnCount = await page.evaluate(
      () => getComputedStyle(document.querySelector(".masonry")!)
        .gridTemplateColumns
        .split(" ")
        .length,
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
  expect(metrics.layoutShift).toBeLessThan(0.05);
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

  await page.getByRole("button", { name: "湖边清晨" }).click();
  await expect(page.locator(".photo-viewer")).toBeVisible();
  await expect.poll(() => thumbnailSizes).toContain("1280");
  // 查看器小图先行与画布同源 240：桌面全链路不再出现 480 请求
  expect(thumbnailSizes).not.toContain("480");
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
  await page.getByRole("button", { name: "湖边清晨" }).click();
  await expect(page.locator(".photo-viewer")).toBeVisible();
  // 小图先行 240 + 移动大图 480，桌面 1280 不出现
  await expect.poll(() => thumbnailSizes).toContain("240");
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
    if (url.pathname === `/api/v1/memories/${memoryId}/file`) {
      serverMediaRequests += 1;
      await route.fulfill({ body: Buffer.from("video"), contentType: "video/mp4" });
      return;
    }
    await route.fallback();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "湖边清晨" }).click();
  await expect(page.locator(".photo-viewer")).toBeVisible();
  expect(directRequests).toBe(0);
  await page.getByRole("button", { name: "播放视频" }).click();
  await expect.poll(() => directRequests).toBe(0);
  await expect.poll(() => serverMediaRequests).toBe(1);
});

test("download button uses the server media stream", async ({ page }) => {
  await mockMemoryRoutes(page);
  await page.addInitScript(() => {
    const clickedHrefs: string[] = [];
    (window as any).__clickedHrefs = clickedHrefs;
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      if (this.href) {
        clickedHrefs.push(this.href);
      }
      return originalClick.call(this);
    };
  });

  await page.goto("/");
  await page.getByRole("button", { name: "湖边清晨" }).click();
  await page.locator(".photo-viewer").getByRole("button", { name: "下载" }).click();
  const clickedHrefs = await page.evaluate(
    () => (window as any).__clickedHrefs as string[],
  );
  expect(clickedHrefs.some((href) => href.includes(`/memories/${memoryId}/file`))).toBe(true);
  // 下载成功后一切就绪：状态徽章隐藏，不再常驻“可用”。
  await expect(page.locator(".viewer-status")).toHaveAttribute("data-state", "ready");
  await expect(page.locator(".viewer-status")).not.toBeVisible();
});

test("card caption reveals on hover and stays decorative for screen readers", async ({
  page,
}) => {
  await mockMemoryRoutes(page);
  await page.goto("/");
  await expect(page.locator(".masonry .post-card")).toHaveCount(1);

  const card = page.locator(".masonry .post-card").first();
  const caption = card.locator(".card-caption");
  // 装饰层：按钮 aria-label 已含可读名
  await expect(caption).toHaveAttribute("aria-hidden", "true");
  await expect(caption).toContainText("湖边清晨");
  await expect(caption).toContainText("杭州");

  await expect
    .poll(() => caption.evaluate((el) => getComputedStyle(el).opacity))
    .toBe("0");
  await card.hover();
  await expect
    .poll(() => caption.evaluate((el) => getComputedStyle(el).opacity))
    .toBe("1");
  await page.mouse.move(0, 0);
  await expect
    .poll(() => caption.evaluate((el) => getComputedStyle(el).opacity))
    .toBe("0");
});
