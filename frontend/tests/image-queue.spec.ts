import { expect, test, type Page } from "@playwright/test";

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const FIRST_ID = "11111111-1111-4111-8111-000000000001";
const SECOND_ID = "11111111-1111-4111-8111-000000000002";

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

test("failing thumbnail keeps its retry backoff before surfacing the retry action", async ({
  page,
}) => {
  const items = [memory(FIRST_ID, 1), memory(SECOND_ID, 2)];

  await page.route(/\/api\/v1\/memories\/recommend(\?.*)?$/, (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route(/\/api\/v1\/memories(\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        items,
        total: items.length,
        page: 1,
        page_size: 18,
        counts: { photo: 2, video: 0 },
        public_counts: { photo: 2, video: 0 },
      },
    }),
  );
  await page.route(/\/api\/v1\/memories\/[^/]+\/thumbnail(\?.*)?$/, (route) => {
    if (route.request().url().includes(FIRST_ID)) {
      void route.fulfill({ status: 404, body: "missing derivative" });
      return;
    }
    void route.fulfill({
      body: Buffer.from(pngBase64, "base64"),
      contentType: "image/png",
    });
  });

  await page.goto("/");
  await expect(page.locator(".masonry .post-card")).toHaveCount(2);

  const retryButton = page
    .locator(".masonry .post-card")
    .first()
    .getByRole("button", { name: "重试预览" });

  // The queue retries the failing thumbnail on its 500ms/1s/2s/4s backoff,
  // so the card must not surface the retry action early. A regression that
  // re-enters the failure handler after clearing src burns all retries
  // within milliseconds and shows the retry action almost immediately.
  await page.waitForTimeout(3000);
  await expect(retryButton).toHaveCount(0);

  // The failure path still completes once the backoff is exhausted.
  await expect(retryButton).toBeVisible({ timeout: 15_000 });
});
