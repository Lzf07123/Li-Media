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

async function mockCanvas(page: Page, count: number, canvasDelayMs: number) {
  const items = Array.from({ length: count }, (_, index) =>
    memory(`21111111-1111-4111-8111-${String(index).padStart(12, "0")}`, index + 1),
  );
  let canvasCompleted = 0;

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
    if (!url.pathname.endsWith("/thumbnail")) {
      await route.fulfill({ json: items[0] });
      return;
    }
    const size = url.searchParams.get("size");
    if (size === "240") {
      // 画布缩略图被拖慢，模拟槽位被普通任务占满的场景。
      await new Promise((resolve) => setTimeout(resolve, canvasDelayMs));
      canvasCompleted += 1;
      await route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/webp",
      });
      return;
    }
    await route.fulfill({
      body: Buffer.from(pngBase64, "base64"),
      contentType: "image/webp",
    });
  });

  return { canvasCompletedRef: () => canvasCompleted, items };
}

test("viewer claims the image queue while canvas thumbnails are busy", async ({ page }) => {
  const { canvasCompletedRef } = await mockCanvas(page, 9, 5000);

  await page.goto("/");
  await expect(page.locator(".masonry .post-card").first()).toBeVisible();
  await page.waitForTimeout(300);

  await page.locator(".masonry .post-card").first().locator("button").click();

  // 查看器的小图与大图都是高优先级，必须不等被拖慢的画布任务。
  const viewerStatus = page.locator(".viewer-status");
  await expect(viewerStatus).toHaveAttribute("data-state", "ready", {
    timeout: 3000,
  });
  expect(canvasCompletedRef()).toBe(0);

  await page.keyboard.press("Escape");
  // 关闭后普通任务恢复，画布缩略图最终完成。
  await expect
    .poll(() => canvasCompletedRef(), { timeout: 10_000 })
    .toBeGreaterThan(0);
});
