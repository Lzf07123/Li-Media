import { expect, test, type Page } from "@playwright/test";

// 电影感 hero 契约：首屏以单幅精选真实回忆开场。
// 覆盖：主图派生档与元数据行、点图进查看器、接下来条切换主图、
// CTA 滚动画布、捕获后稳定（换一批/筛选不改 hero）、结构镜像骨架
//（构图缓存按真实宽高实时计算）、reduced-motion 关闭 Ken Burns、
// 窄屏编辑裁剪至 3 枚、空库退场并渲染兜底 h1。

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const TOTAL_ITEMS = 12;

function memory(index: number) {
  const isVideo = index === 2 || index === 4;
  // 每条记忆给不同的真实宽高：骨架屏据此实时计算占位形状
  const dimensions = [
    { width: 1600, height: 900 },
    { width: 800, height: 1200 },
    { width: 1920, height: 1080 },
    { width: 1000, height: 1000 },
    { width: 1200, height: 1600 },
  ];
  return {
    id: `52111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
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
    duration_seconds: isVideo ? 75 : null,
    ...dimensions[index % dimensions.length],
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
  options: { onThumbnailSize?: (size: string) => void } = {},
) {
  let listCallCount = 0;
  await page.route("**/api/v1/memories/recommend**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/v1/memories/preheat-status", (route) =>
    route.fulfill({ json: { status: "ready", processed: 4, total: 4 } }),
  );
  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories") {
      listCallCount += 1;
      // 「换一批」后的第二次列表返回不同标题，用于验证 hero 不随动。
      const batch = listCallCount === 1 ? items : items.toReversed();
      return route.fulfill({
        json: {
          items: batch,
          total: batch.length,
          page: 1,
          page_size: 18,
          counts: {
            photo: batch.filter((item) => item.kind === "photo").length,
            video: batch.filter((item) => item.kind === "video").length,
          },
          public_counts: { photo: 10, video: 2 },
        },
      });
    }
    if (url.pathname.endsWith("/thumbnail")) {
      options.onThumbnailSize?.(url.searchParams.get("size") ?? "");
      return route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/webp",
      });
    }
    return route.fulfill({ json: items[0] });
  });
}

test("hero opens with a featured real memory and editorial metadata", async ({
  page,
}) => {
  await mockLibrary(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const hero = page.getByTestId("hero-feature");
  // 主图加载 1280px 高清派生图（走共享队列）
  const featuredImg = hero.locator(".hero-feature-img");
  await expect(featuredImg).toHaveAttribute("src", /size=1280/);
  await expect(featuredImg).toHaveClass(/is-ready/);
  // 元数据行：编号 01 + 精选 + 地点 · 日期；可读名在主图按钮 aria-label 上
  await expect(hero.locator(".hero-meta-index")).toHaveText("01");
  await expect(hero.locator(".hero-meta")).toContainText("精选");
  await expect(hero.locator(".hero-meta")).toContainText("杭州");
  await expect(
    hero.locator(".hero-stage-media", { hasText: "" }).first(),
  ).toBeAttached();
  await expect(
    page.getByRole("button", { name: "记忆 1" }).first(),
  ).toBeAttached();
  // 衬线巨字标题在 hero 内
  await expect(hero.getByRole("heading", { name: "回忆库" })).toBeVisible();
});

test("hero loads the 240 LQIP first and upgrades to 1280", async ({ page }) => {
  // 公开预热只覆盖 240px：大档位按需派生需数秒，hero 必须以 240 预热档
  // 先行显影（模糊放大），1280 就绪后原地升级——首屏不等大图派生。
  const sizes: string[] = [];
  await mockLibrary(page, { onThumbnailSize: (size) => sizes.push(size) });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const featuredImg = page
    .getByTestId("hero-feature")
    .locator(".hero-feature-img");
  await expect(featuredImg).toHaveAttribute("src", /size=1280/);
  expect(sizes).toContain("240");
  expect(sizes).toContain("1280");
  // 「接下来」条固定 240 预热档（零按需派生）
  await expect(page.getByTestId("hero-feature").locator(".hero-upnext-img").first())
    .toHaveAttribute("src", /size=240/);
});

test("featured video surfaces kind and duration in the metadata row", async ({
  page,
}) => {
  const videoFirst = [items[2], ...items.filter((item) => item.id !== items[2].id)];
  await page.route("**/api/v1/memories/recommend**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/v1/memories/preheat-status", (route) =>
    route.fulfill({ json: { status: "ready", processed: 4, total: 4 } }),
  );
  await page.route("**/api/v1/memories**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories") {
      return route.fulfill({
        json: {
          items: videoFirst,
          total: videoFirst.length,
          page: 1,
          page_size: 18,
          counts: { photo: 10, video: 2 },
          public_counts: { photo: 10, video: 2 },
        },
      });
    }
    if (url.pathname.endsWith("/thumbnail")) {
      return route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/webp",
      });
    }
    return route.fulfill({ json: videoFirst[0] });
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByTestId("hero-feature").locator(".hero-meta-kind"))
    .toContainText("视频 1:15");
});

test("clicking the featured image opens the viewer for that memory", async ({
  page,
}) => {
  await mockLibrary(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  await expect(page.getByTestId("hero-feature").locator(".hero-feature-img"))
    .toHaveClass(/is-ready/);
  await page.getByRole("button", { name: "记忆 1" }).first().click();
  await expect(page.locator(".photo-viewer")).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp("viewer=52111111-1111-4111-8111-000000000000"),
  );
});

test("up-next strip swaps the featured image without touching the viewer", async ({
  page,
}) => {
  await mockLibrary(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const hero = page.getByTestId("hero-feature");
  const tiles = hero.locator(".hero-upnext-tile");
  await expect(tiles).toHaveCount(4);

  // 点击「记忆 2」小瓦：主图切换为该记忆的 1280 派生图，编号推进为 02
  await tiles.filter({ hasText: "" }).nth(0).click();
  await expect(tiles.nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(hero.locator(".hero-meta-index")).toHaveText("02");
  await expect(hero.locator(".hero-feature-img")).toHaveAttribute(
    "src",
    /m1\/thumbnail.*size=1280/,
  );
  await expect(page).not.toHaveURL(/viewer=/);
});

test("hero CTA scrolls down to the library canvas", async ({ page }) => {
  await mockLibrary(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  await expect(page.getByTestId("hero-feature").locator(".hero-feature-img"))
    .toHaveClass(/is-ready/);
  await page.getByRole("button", { name: "进入回忆库" }).click();
  await expect
    .poll(() => page.evaluate(() => window.scrollY), { timeout: 5_000 })
    .toBeGreaterThan(300);
});

test("hero stays stable while the canvas reshuffles", async ({ page }) => {
  await mockLibrary(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const featuredButton = page
    .getByTestId("hero-feature")
    .locator(".hero-stage-media");
  await expect(featuredButton).toHaveAttribute("aria-label", "记忆 1");

  // 换一批会重取列表（mock 返回倒序批），画布变化，hero 不变
  await page.getByRole("button", { name: "换一批" }).click();
  await expect(page.locator(".masonry .post-card").first()).toBeVisible();
  await expect(featuredButton).toHaveAttribute("aria-label", "记忆 1");
});

test("hero skeleton mirrors structure and computes ratios from cached sizes", async ({
  page,
}) => {
  // 种下构图缓存：hero 比例框与画布骨架瓦都按真实宽高实时计算
  await page.addInitScript(() => {
    localStorage.setItem(
      "limedia-canvas-composition",
      JSON.stringify({
        hero: { width: 1600, height: 900 },
        items: [
          { width: 1600, height: 900 },
          { width: 800, height: 1200 },
        ],
      }),
    );
  });
  await page.route("**/api/v1/memories/recommend**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/v1/memories/preheat-status", (route) =>
    route.fulfill({ json: { status: "ready", processed: 1, total: 1 } }),
  );
  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories") {
      await new Promise((resolve) => setTimeout(resolve, 600));
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
    if (url.pathname.endsWith("/thumbnail")) {
      return route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/webp",
      });
    }
    return route.fulfill({ json: items[0] });
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const skeleton = page.getByTestId("hero-feature-skeleton");
  await expect(skeleton).toBeVisible();
  // 结构镜像：比例框（来自缓存的真实宽高）+ 文本条 + 接下来条，非一整块
  await expect(skeleton.locator(".hero-stage-frame")).toHaveAttribute(
    "style",
    /aspect-ratio: 1600 \/ 900/,
  );
  await expect(skeleton.locator(".hero-skel-title")).toBeVisible();
  await expect(skeleton.locator(".hero-upnext-tile")).toHaveCount(4);
  // 画布骨架瓦：按缓存真实宽高逐条计算 aspect-ratio
  await expect(
    page.getByTestId("media-skeleton").locator('[data-skeleton-ratio="1600 / 900"]').first(),
  ).toBeAttached();
  await expect(
    page.getByTestId("media-skeleton").locator('[data-skeleton-ratio="800 / 1200"]').first(),
  ).toBeAttached();

  // 数据到达后骨架退场，真实 hero 出现
  await expect(page.getByTestId("hero-feature")).toBeVisible();
  await expect(page.getByTestId("hero-feature-skeleton")).toHaveCount(0);
});

test("ken burns is disabled under reduced motion", async ({ page }) => {
  await mockLibrary(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  await expect(page.getByTestId("hero-feature").locator(".hero-feature-img"))
    .toHaveClass(/is-ready/);
  const animationName = await page
    .getByTestId("hero-feature")
    .locator(".hero-feature-img")
    .evaluate((node) => getComputedStyle(node).animationName);
  expect(animationName).toBe("none");
});

test("hero trims the up-next strip to three tiles on narrow screens", async ({
  page,
}) => {
  await mockLibrary(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 375, height: 720 });
  await page.goto("/");

  const tiles = page.getByTestId("hero-feature").locator(".hero-upnext-tile");
  await expect(tiles).toHaveCount(4);
  await expect(page.locator(".hero-upnext-tile:visible")).toHaveCount(3);
});

test("hero exits quietly when the library is empty and falls back to h1", async ({
  page,
}) => {
  await page.route("**/api/v1/memories/recommend**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/v1/memories/preheat-status", (route) =>
    route.fulfill({ json: { status: "ready", processed: 0, total: 0 } }),
  );
  await page.route("**/api/v1/memories**", (route) =>
    route.fulfill({
      json: {
        items: [],
        total: 0,
        page: 1,
        page_size: 18,
        counts: { photo: 0, video: 0 },
        public_counts: { photo: 0, video: 0 },
      },
    }),
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByTestId("hero-feature")).toHaveCount(0);
  await expect(page.locator(".empty-state")).toBeVisible();
  // 兜底标题：页面始终恰有一个 h1
  await expect(page.getByRole("heading", { name: "回忆库" })).toBeVisible();
  await expect(page.locator("h1")).toHaveCount(1);
});
