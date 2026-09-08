import { expect, test } from "@playwright/test";

test("list cache does not reuse photo and video responses across filters", async ({ page }) => {
  const listRequests: string[] = [];
  const photoId = "0a2d3d6a-0e4b-4b9e-8f88-6d8a1b7f0001";
  const videoId = "0a2d3d6a-0e4b-4b9e-8f88-6d8a1b7f0002";
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  const memory = (id: string, kind: "photo" | "video") => ({
    id,
    title: kind === "photo" ? "湖边照片" : "湖边视频",
    description: "",
    kind,
    status: "published",
    media_display_state: "displayable",
    public_display_state: "displayable",
    captured_at: "2026-01-01T08:30:00Z",
    location: null,
    file_url: `/api/v1/memories/${id}/file`,
    thumbnail_url: `/api/v1/memories/${id}/thumbnail`,
    duration_seconds: kind === "video" ? 12 : null,
    width: 2400,
    height: 1200,
    primary_file: {
      id: `${id}-file`,
      source: "baidupan",
      remote_path: `${kind}.png`,
      remote_id: id,
      parent_path: "/cloud",
      filename: `${kind}.png`,
      extension: "png",
      remote_md5: null,
      mime_type: "image/png",
      size_bytes: 1024,
      modified_at: null,
      status: "matched",
      remote_state: "ready",
      thumbnail_state: "ready",
      thumbnail_failure_kind: null,
      stream_state: "ready",
      browser_compatibility: "supported",
      browser_format_summary: {},
      browser_compatibility_error: null,
      browser_compatibility_checked_at: null,
      last_synced_at: null,
      sync_error: null,
    },
    created_at: "2026-01-01T08:35:00Z",
    updated_at: "2026-01-01T08:35:00Z",
  });

  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories") {
      const kind = url.searchParams.get("kind");
      listRequests.push(kind ?? "all");
      const items = kind === "video" ? [memory(videoId, "video")] : [memory(photoId, "photo")];
      await route.fulfill({
        json: {
          items,
          total: items.length,
          page: 1,
          page_size: 18,
          counts: kind === "video" ? { photo: 0, video: 1 } : { photo: 1, video: 0 },
          public_counts: kind === "video" ? { photo: 0, video: 1 } : { photo: 1, video: 0 },
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
  await page.route("**/api/v1/memories/preheat-status", async (route) => {
    await route.fulfill({ json: { status: "ready", processed: 1, total: 1 } });
  });

  await page.goto("/");
  await expect(page.locator(".masonry .post-card")).toHaveCount(1);
  await page.locator(".segmented button").nth(2).click();
  await page.waitForURL(/kind=video/);
  await page.waitForRequest((request) => request.url().includes("/api/v1/memories?"));
  await expect(page.locator(".masonry .post-card button")).toHaveAttribute(
    "aria-label",
    "回忆预览",
  );
  expect(listRequests).toEqual(["all", "video"]);
});
