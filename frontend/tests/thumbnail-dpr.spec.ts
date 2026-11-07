import { expect, test, type Page } from "@playwright/test";

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const memoryId = "41111111-1111-4111-8111-000000000001";

function memory(id: string) {
  return {
    id,
    title: "memory-1",
    description: "",
    kind: "photo",
    status: "published",
    media_display_state: "displayable",
    public_display_state: "displayable",
    captured_at: "2026-01-01T00:00:00Z",
    location: null,
    file_url: `/api/v1/memories/${id}/file`,
    thumbnail_url: `/api/v1/memories/${id}/thumbnail`,
    duration_seconds: null,
    width: 800,
    height: 1000,
    primary_file: {
      id,
      source: "baidupan",
      remote_id: "1",
      remote_path: "/cloud/photo-1",
      filename: "photo-1",
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

async function mockLibrary(page: Page) {
  const items = [memory(memoryId)];
  const sizes = new Set<string>();
  await page.route("**/api/v1/memories/recommend**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories") {
      await route.fulfill({
        json: {
          items,
          total: 1,
          page: 1,
          page_size: 18,
          counts: { photo: 1, video: 0 },
          public_counts: { photo: 1, video: 0 },
        },
      });
      return;
    }
    if (url.pathname.endsWith("/thumbnail")) {
      sizes.add(url.searchParams.get("size") ?? "");
      await route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/webp",
      });
      return;
    }
    await route.fulfill({ json: items[0] });
  });
  return sizes;
}

test.describe("1x screens", () => {
  test.use({ deviceScaleFactor: 1 });

  test("card thumbnails stay on the 240px derivative", async ({ page }) => {
    const sizes = await mockLibrary(page);
    await page.goto("/");
    await expect(page.locator(".masonry .post-card")).toHaveCount(1);
    await expect
      .poll(() => sizes.has("240"), { timeout: 5000 })
      .toBe(true);
    // 卡片固定 240；480 属 hero 侧瓦与查看器海报；1280 仅 hero 主图一次
    //（V1.5 首屏精选招待，与 DPR 无关）
    expect(sizes.has("480")).toBe(false);
    expect([...sizes].filter((size) => size === "1280")).toHaveLength(1);
  });
});

test.describe("2x screens", () => {
  test.use({ deviceScaleFactor: 2 });

  // 画布可见性以 240px 预热就绪为门槛，卡片固定取 240px：预热即所得，
  // 高分屏不抬升卡片档位（hero 固定 1280/480，与 DPR 无关）。
  test("card thumbnails stay on the 240px derivative", async ({ page }) => {
    const sizes = await mockLibrary(page);
    await page.goto("/");
    await expect(page.locator(".masonry .post-card")).toHaveCount(1);
    await expect
      .poll(() => sizes.has("240"), { timeout: 5000 })
      .toBe(true);
    expect(sizes.has("480")).toBe(false);
    expect([...sizes].filter((size) => size === "1280")).toHaveLength(1);
  });
});
