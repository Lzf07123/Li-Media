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
      await new Promise((resolve) => setTimeout(resolve, 800));
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
  await expect(firstCard.locator("img")).toHaveCSS("opacity", "1");

  await page.evaluate(() => window.scrollTo(0, 1800));
  await expect
    .poll(() =>
      firstCard
        .locator("img")
        .evaluate((element) => getComputedStyle(element).opacity),
    )
    .toBe("0");
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect
    .poll(() =>
      firstCard
        .locator("img")
        .evaluate((element) => getComputedStyle(element).opacity),
    )
    .toBe("1");

  await expect(page.locator(".site-footer")).toHaveCSS("position", "fixed");
  const footerHeight = (await page.locator(".site-footer").boundingBox())?.height ?? 0;
  const expectedFooterY = 720 - footerHeight;
  for (const scrollY of [0, 900, 100000]) {
    await page.evaluate((top) => window.scrollTo(0, top), scrollY);
    await expect.poll(async () => {
      const footer = await page.locator(".site-footer").boundingBox();
      return footer?.y ?? 0;
    }).toBeCloseTo(expectedFooterY, 0);
  }
  await expect(page.getByTestId("public-count")).toContainText(
    "已收录媒体 7",
  );
});

test("admin counts, compatibility and batch confirmation are explicit", async ({ page }) => {
  const consoleErrors: string[] = [];
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
  const adminSystemStatus = {
    generated_at: "2026-09-08T00:00:00Z",
    backend: {
      app_name: "Li&Media",
      version: "0.1.0",
      python_version: "3.12.0",
      platform: "Linux",
      pid: 100,
      database: { status: "ok", detail: null, pool_status: null, dialect: null, used_memory_bytes: null, max_memory_bytes: null, connected_clients: null },
      redis: { status: "ok", detail: null, pool_status: null, dialect: null, used_memory_bytes: null, max_memory_bytes: null, connected_clients: null },
      task_thread_pool_size: 24,
      stack_guard: "bounded",
      configuration: {
        preheat_concurrency_limit: 2,
        preheat_queue_limit: 64,
        preheat_wait_timeout_seconds: 2,
        derivative_concurrency_limit: 1,
        derivative_queue_limit: 32,
        derivative_wait_timeout_seconds: 15,
        direct_probe_concurrency_limit: 4,
        direct_probe_queue_limit: 16,
        scan_concurrency_limit: 1,
        stream_global_concurrency_limit: 16,
        stream_user_concurrency_limit: 3,
        temp_max_files: 2,
        temp_disk_quota_bytes: 4294967296,
      },
    },
    remote_storage: {
      provider: "baidupan",
      configured: true,
      oauth_configured: true,
      authorized: true,
      scan_dir: "/apps/Li&Media",
      token_expires_at: null,
      direct_link_cache_entries: 0,
      counts: {
        total: 3,
        remote_ready: 3,
        remote_missing: 0,
        remote_failed: 0,
        thumbnail_ready: 1,
        thumbnail_missing: 2,
        thumbnail_failed: 0,
        thumbnail_failure_kinds: {},
        stream_ready: 1,
        stream_failed: 0,
      },
      last_scan: null,
    },
    source_zero: {
      compliant: true,
      source_path_count: 0,
      source_path_schema_exposed: false,
      database_blob_count: 0,
      source_media_file_count: 0,
      source_media_extensions: {},
      media_photos_file_count: 0,
      media_videos_file_count: 0,
      unexpected_media_file_count: 0,
      temporary_file_count: 0,
      filesystem_scan_failed: false,
    },
    tasks: {
      scan: { active: 0, queued: 0, limit: 1, queue_limit: 1, wait_timeout_seconds: 0 },
      direct_probe: { active: 0, queued: 0, limit: 4, queue_limit: 16, wait_timeout_seconds: 3 },
      derivative: { active: 0, queued: 0, limit: 1, queue_limit: 32, wait_timeout_seconds: 15 },
      preheat: { active: 0, queued: 0, limit: 2, queue_limit: 64, wait_timeout_seconds: 2 },
      stream: { active: 0, queued: 0, limit: 16, queue_limit: 32, wait_timeout_seconds: 1 },
    },
    metrics: { active_jobs: 0, queue_depth: 0 },
    resources: {
      process: { rss_kbytes: 59080, threads: 8, pss_kbytes: 49960 },
      cgroup: {
        memory_current_bytes: 47366144,
        memory_peak_bytes: 80941056,
        memory_max_bytes: 268435456,
        pids_current: 8,
        pids_max: 64,
        oom: 0,
        oom_kill: 0,
      },
      temporary: {
        files: 0,
        bytes: 0,
        free_bytes: 4294967296,
        total_bytes: 5368709120,
        used_bytes: 1073741824,
        usage_ratio: 0.2,
      },
      filesystem: {
        total_bytes: 5368709120,
        used_bytes: 1073741824,
        free_bytes: 4294967296,
        usage_ratio: 0.2,
      },
      caches: {
        derived_thumbnails: { files: 3, bytes: 245760, status: "ok" },
        temporary: { files: 0, bytes: 0, status: "ok" },
        nginx: { files: 5, bytes: 163840, status: "ok" },
      },
      stack: { soft_kbytes: 8192, hard_kbytes: null },
      limits: {
        backend_memory_bytes: 268435456,
        temp_disk_quota_bytes: 4294967296,
        temp_max_files: 2,
      },
    },
  };

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
    await route.fulfill({ json: adminSystemStatus });
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

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "回忆管理" })).toBeVisible();
  await expect(page.getByText("7 / 4 / 3")).toBeVisible();
  await expect(
    page.getByText("可播放 / 不可播放 / 未知").first(),
  ).toBeVisible();
  await expect(
    page.getByRole("progressbar", { name: "文件系统占用" }),
  ).toBeVisible();
  await expect(page.getByText("缓存占用")).toBeVisible();
  await expect(page.getByText("3 文件 · 240 KB")).toBeVisible();
  await expect(page.getByText("5 文件 · 160 KB")).toBeVisible();
  await expect(page.getByText("生效资源限制")).toBeVisible();
  await expect(page.getByText("2 / 64")).toBeVisible();
  await expect(page.getByText("16 / 3")).toBeVisible();

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

  await page.setViewportSize({ width: 375, height: 800 });
  const filterGrid = page.locator(".admin-filter-grid");
  await expect(filterGrid).toBeVisible();
  const controlBoxes = await filterGrid.locator("> *").evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }),
  );
  expect(controlBoxes.length).toBeGreaterThan(2);
  for (const box of controlBoxes) {
    expect(box.width).toBeLessThanOrEqual(375.5);
  }
  for (let left = 0; left < controlBoxes.length; left += 1) {
    for (let right = left + 1; right < controlBoxes.length; right += 1) {
      const a = controlBoxes[left];
      const b = controlBoxes[right];
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
  expect(consoleErrors.join("\n")).not.toContain("Content Security Policy");
});
