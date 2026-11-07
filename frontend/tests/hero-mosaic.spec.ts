import { expect, test, type Page } from "@playwright/test";

// 图像 hero 契约：首屏精选拼贴以真实回忆开场。
// 覆盖：瓦片数量与来源、点击进查看器、视频时长徽标、
// 捕获后稳定（换一批/筛选不改 hero）、骨架、窄屏编辑裁剪、空库退场。

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const TOTAL_ITEMS = 12;

function memory(index: number) {
  const isVideo = index === 2 || index === 4;
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
    width: 1600,
    height: 900,
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

async function mockLibrary(page: Page) {
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
      return route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/webp",
      });
    }
    return route.fulfill({ json: items[0] });
  });
}

test("hero mosaic opens with five real memory tiles", async ({ page }) => {
  await mockLibrary(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const tiles = page.getByTestId("hero-mosaic").locator(".hero-tile");
  await expect(tiles).toHaveCount(5);
  // 主瓦片加载真实缩略图（768px 派生图走共享队列）
  await expect(tiles.first().locator("img")).toHaveAttribute("src", /size=768/);
  await expect(tiles.first()).toHaveAttribute("data-preview-state", "ready");
  // 信息层是装饰性的：可读名在按钮 aria-label 上
  await expect(tiles.first().getByRole("button", { name: "记忆 1" })).toBeAttached();
});

test("clicking a hero tile opens the viewer for that memory", async ({
  page,
}) => {
  await mockLibrary(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const firstTile = page
    .getByTestId("hero-mosaic")
    .locator(".hero-tile")
    .first();
  await expect(firstTile).toHaveAttribute("data-preview-state", "ready");
  await firstTile.locator("button").click();
  await expect(page.locator(".photo-viewer")).toBeVisible();
  await expect(page).toHaveURL(new RegExp("viewer=52111111-1111-4111-8111-000000000000"));
});

test("hero video tiles surface the duration badge", async ({ page }) => {
  await mockLibrary(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const badges = page
    .getByTestId("hero-mosaic")
    .locator(".hero-kind-badge")
    .filter({ hasText: "1:15" });
  await expect(badges).toHaveCount(2);
});

test("hero stays stable while the canvas reshuffles", async ({ page }) => {
  await mockLibrary(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const firstTileName = page
    .getByTestId("hero-mosaic")
    .locator(".hero-tile")
    .first()
    .locator("button");
  await expect(firstTileName).toHaveAttribute("aria-label", "记忆 1");

  // 换一批会重取列表（mock 返回倒序批），画布变化，hero 不变
  await page.getByRole("button", { name: "换一批" }).click();
  await expect(page.locator(".masonry .post-card").first()).toBeVisible();
  await expect(firstTileName).toHaveAttribute("aria-label", "记忆 1");
});

test("hero shows skeleton tiles while the first page loads", async ({
  page,
}) => {
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
  const skeletonTiles = page
    .getByTestId("hero-mosaic")
    .locator(".hero-tile-skeleton");
  await expect(skeletonTiles).toHaveCount(5);
  await expect(skeletonTiles.first().locator(".card-shimmer")).toBeAttached();

  await expect(
    page.getByTestId("hero-mosaic").locator(".hero-tile:not(.hero-tile-skeleton)"),
  ).toHaveCount(5);
});

test("hero trims to three tiles on narrow screens", async ({ page }) => {
  await mockLibrary(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 375, height: 720 });
  await page.goto("/");

  const tiles = page.getByTestId("hero-mosaic").locator(".hero-tile");
  await expect(tiles).toHaveCount(5);
  await expect(page.locator(".hero-tile:visible")).toHaveCount(3);
});

test("hero exits quietly when the library is empty", async ({ page }) => {
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
  await expect(page.getByTestId("hero-mosaic")).toHaveCount(0);
  await expect(page.locator(".empty-state")).toBeVisible();
});
