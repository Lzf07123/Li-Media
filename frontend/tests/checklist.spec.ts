import { expect, test, type Page } from "@playwright/test";

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type MockKind = "photo" | "video";

function memory(index: number, kind: MockKind = "photo") {
  const id = `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
  return {
    id,
    title: `memory-${index}`,
    description: "",
    kind,
    status: "published",
    media_display_state: "displayable",
    public_display_state: "displayable",
    captured_at: "2026-01-01T00:00:00Z",
    location: null,
    file_url: `/api/v1/memories/${id}/file`,
    thumbnail_url: `/api/v1/memories/${id}/thumbnail`,
    duration_seconds: kind === "video" ? 8 : null,
    width: 800,
    height: 1000,
    primary_file: {
      id: id,
      source: "baidupan",
      remote_id: String(index),
      remote_path: `/cloud/${kind}-${index}`,
      filename: `${kind}-${index}`,
      status: "matched",
      remote_state: "ready",
      thumbnail_state: "ready",
      thumbnail_failure_kind: null,
      stream_state: "ready",
      browser_compatibility: kind === "video" ? "supported" : "supported",
      browser_format_summary: {},
      browser_compatibility_error: null,
      browser_compatibility_checked_at: null,
    },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

test("home public count, loading feedback and persistent footer", async ({ page }) => {
  const items = Array.from({ length: 40 }, (_, index) =>
    memory(index + 1, index % 7 === 0 ? "video" : "photo"),
  );

  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories/recommend") {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/api/v1/memories") {
      const kind = url.searchParams.get("kind");
      const filtered = kind ? items.filter((item) => item.kind === kind) : items;
      await route.fulfill({
        json: {
          items: filtered.slice(0, 18),
          total: filtered.length,
          page: 1,
          page_size: 18,
          counts: {
            photo: kind === "video" ? 0 : 4,
            video: kind === "video" ? 3 : 3,
          },
        },
      });
      return;
    }
    if (url.pathname.endsWith("/thumbnail")) {
      await new Promise((resolve) => setTimeout(resolve, 220));
      await route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/png",
      });
      return;
    }
    await route.fulfill({ json: items[0] });
  });
  await page.route("**/api/v1/memories/public-counts", async (route) => {
    await route.fulfill({ json: { total: 7, photo: 4, video: 3 } });
  });

  await page.goto("/");
  await expect(page.getByTestId("public-count")).toContainText(
    "已收录媒体 7",
  );
  await expect(page.getByTestId("public-count")).toContainText(
    "公开照片 / 公开视频 4/3",
  );

  const firstCard = page.locator(".masonry .post-card").first();
  await expect(firstCard.locator(".card-shimmer")).toBeVisible();
  await expect(firstCard.locator("img")).toBeVisible();
  await expect(firstCard.locator(".card-shimmer")).toHaveCount(0);

  const footerBefore = await page.locator(".site-footer").boundingBox();
  await page.mouse.wheel(0, 900);
  await expect.poll(async () => {
    const footer = await page.locator(".site-footer").boundingBox();
    return footer?.y ?? 0;
  }).toBeCloseTo(footerBefore?.y ?? 0, 0);
  await expect(page.getByTestId("public-count")).toContainText(
    "已收录媒体 7",
  );
});

test("admin counts, compatibility and batch confirmation are explicit", async ({ page }) => {
  const item = memory(1);
  item.primary_file.browser_compatibility = "supported";
  const adminList = {
    items: [item],
    total: 3,
    display_counts: { displayable: 7, excluded: 1 },
    filtered_display_counts: { displayable: 3, excluded: 0 },
    global_counts: { photo: 4, video: 3 },
    status_counts: { published: 4, unpublished: 3 },
    filtered_status_counts: { published: 1, unpublished: 0 },
    browser_counts: { supported: 2, unsupported: 3, unknown: 2 },
    filtered_browser_counts: { supported: 1, unsupported: 0, unknown: 0 },
    page: 1,
    page_size: 50,
    counts: { photo: 2, video: 1 },
  };
  const memoryList = {
    items: [item],
    total: 1,
    page: 1,
    page_size: 18,
    counts: { photo: 1, video: 0 },
  };
  let batchRun = 0;

  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/memories/recommend") {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/api/v1/memories") {
      await route.fulfill({ json: memoryList });
      return;
    }
    if (url.pathname.endsWith("/thumbnail")) {
      await route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/png",
      });
      return;
    }
    await route.fulfill({ json: item });
  });
  await page.route("**/api/v1/memories/public-counts", async (route) => {
    await route.fulfill({ json: { total: 7, photo: 4, video: 3 } });
  });
  await page.route("**/api/v1/admin/memories/batch-status/latest", async (route) => {
    await route.fulfill({ json: null });
  });
  await page.route("**/api/v1/admin/browser-compatibility/probe/latest", async (route) => {
    await route.fulfill({ json: null });
  });
  await page.route("**/api/v1/admin/memories**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/batch-status/latest")) {
      await route.fulfill({ json: null });
      return;
    }
    if (url.pathname === "/api/v1/admin/memories") {
      await route.fulfill({ json: adminList });
      return;
    }
    await route.fulfill({ json: adminList.items[0] });
  });
  await page.route("**/api/v1/admin/remote-config", async (route) => {
    await route.fulfill({
      json: {
        configured: true,
        oauth_configured: true,
        authorized: true,
        scan_dir: "/apps/Li&Media",
        redirect_uri: "/admin/baidu/callback",
        docs_url: "https://pan.baidu.com/union/doc/",
        token_expires_at: null,
      },
    });
  });
  await page.route("**/api/v1/admin/remote-scan/latest", async (route) => {
    await route.fulfill({ json: null });
  });
  await page.route("**/api/v1/admin/system/status", async (route) => {
    await route.fulfill({ status: 500, json: { detail: "unavailable" } });
  });
  await page.route("**/api/v1/admin/thumbnails/preheat/latest", async (route) => {
    await route.fulfill({ json: null });
  });
  await page.route("**/api/v1/admin/memories/batch-preview", async (route) => {
    await route.fulfill({
      json: {
        filter_snapshot: {
          kind: "all",
          keyword: "all",
          display: "all",
          compatibility: "all",
          status: "all",
        },
        total: 7,
        counts: { photo: 4, video: 3 },
        status_counts:
          batchRun === 0
            ? { published: 4, unpublished: 3 }
            : { published: 7, unpublished: 0 },
        display_counts: { displayable: 7, excluded: 1 },
        browser_counts: { supported: 2, unsupported: 3, unknown: 2 },
        is_full_library: true,
      },
    });
  });
  await page.route("**/api/v1/admin/memories/batch-status", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({ json: null });
      return;
    }
    batchRun += 1;
    await route.fulfill({
      json: {
        id: `batch-${batchRun}`,
        action: "batch_status_published",
        status: "completed",
        filter_snapshot: {},
        total: 7,
        processed: 7,
        changed: batchRun === 1 ? 4 : 0,
        skipped: batchRun === 1 ? 3 : 7,
        failed: 0,
        error_message: null,
        created_at: "2026-09-07T00:00:00Z",
        started_at: "2026-09-07T00:00:01Z",
        completed_at: "2026-09-07T00:00:02Z",
      },
    });
  });

  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "回忆管理" })).toBeVisible();
  await expect(page.getByText("7 / 4 / 3")).toBeVisible();
  await expect(
    page.getByText("可播放 / 不可播放 / 未知").first(),
  ).toBeVisible();

  await page.getByRole("button", { name: "发布当前筛选" }).click();
  await expect(page.getByText("当前没有筛选条件，本次将影响全部媒体。")).toBeVisible();
  await expect(page.getByText("影响总数")).toBeVisible();
  await page.getByRole("button", { name: "开始执行" }).click();
  await expect(page.locator(".card").filter({ hasText: "批量状态任务" })).toContainText(
    "7 / 7",
  );
  await expect(page.locator(".card").filter({ hasText: "批量状态任务" })).toContainText(
    "4",
  );

  await page.getByRole("button", { name: "发布当前筛选" }).click();
  await page.getByRole("button", { name: "开始执行" }).click();
  await expect(
    page.locator(".card").filter({ hasText: "批量状态任务" }),
  ).toContainText("7");
  await expect.poll(() => batchRun).toBe(2);
});
