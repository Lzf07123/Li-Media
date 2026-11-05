import { expect, test, type Page } from "@playwright/test";

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function memory(id: string, index: number) {
  return {
    id,
    title: `memory-${index}`,
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
      remote_id: String(index),
      remote_path: `/cloud/photo-${index}`,
      filename: `photo-${index}`,
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

test("viewer prefetches neighbor images while idle", async ({ page }) => {
  const items = Array.from({ length: 3 }, (_, index) =>
    memory(`31111111-1111-4111-8111-${String(index).padStart(12, "0")}`, index + 1),
  );
  const requested = new Set<string>();

  await page.route("**/api/v1/memories/recommend**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories") {
      await route.fulfill({
        json: {
          items,
          total: items.length,
          page: 1,
          page_size: 18,
          counts: { photo: items.length, video: 0 },
          public_counts: { photo: items.length, video: 0 },
        },
      });
      return;
    }
    if (url.pathname.endsWith("/thumbnail")) {
      requested.add(`${url.pathname}?${url.searchParams.toString()}`);
      await route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/webp",
      });
      return;
    }
    await route.fulfill({ json: items[0] });
  });

  await page.goto("/");
  await expect(page.locator(".masonry .post-card")).toHaveCount(3);

  // 打开中间一张：前后两张相邻图的查看器尺寸（1280）应在空闲时被预取，
  // 翻页时无需再等待网络。
  await page.locator(".masonry .post-card").nth(1).locator("button").click();
  const status = page.locator(".viewer-status");
  await expect(status).toHaveAttribute("data-state", "ready", { timeout: 5000 });

  const first = items[0].id;
  const third = items[2].id;
  await expect
    .poll(() => [...requested].filter((url) => url.includes("size=1280")).length, {
      timeout: 8000,
    })
    .toBeGreaterThanOrEqual(2);
  expect([...requested].some((url) => url.includes(first) && url.includes("size=1280"))).toBe(true);
  expect([...requested].some((url) => url.includes(third) && url.includes("size=1280"))).toBe(true);

  // 翻到下一张：预取应已命中，查看器应立即就绪。
  await page.keyboard.press("ArrowRight");
  await expect(status).toHaveAttribute("data-state", "ready", { timeout: 3000 });
  expect(items[2].id).toBeTruthy();
});
