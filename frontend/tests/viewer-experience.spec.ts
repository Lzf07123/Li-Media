import { expect, test, type Page, type Route } from "@playwright/test";

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

type MockLibraryOptions = {
  /** 第二页响应延迟：覆盖查看器「正在加载更多回忆」提示 */
  page2DelayMs?: number;
  /** /file 响应延迟：视频播放测试中避免假缓冲先触发 error */
  fileDelayMs?: number;
  /** 按零起索引覆盖 memory 字段（地点、视频类型等） */
  overrides?: Record<number, Record<string, unknown>>;
};

/**
 * 单一 catch-all mock（Playwright 路由后注册者优先，单 handler 避免
 * glob 覆盖顺序坑）：recommend / preheat-status / 分页列表 / 详情 /
 * 缩略图 / 文件 各分支按 pathname 判定。返回已请求的列表页码记录。
 */
async function mockLibrary(page: Page, total: number, options: MockLibraryOptions = {}) {
  const pageSize = 18;
  const requestedPages: number[] = [];
  const itemAt = (zeroBased: number) => ({
    ...memory(
      `31111111-1111-4111-8111-${String(zeroBased).padStart(12, "0")}`,
      zeroBased + 1,
    ),
    ...(options.overrides?.[zeroBased] ?? {}),
  });

  const serveList = async (route: Route) => {
    const url = new URL(route.request().url());
    const page = Number(url.searchParams.get("page") ?? "1");
    requestedPages.push(page);
    const start = (page - 1) * pageSize;
    const items = Array.from(
      { length: Math.min(pageSize, total - start) },
      (_, offset) => itemAt(start + offset),
    );
    if (page === 2 && options.page2DelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.page2DelayMs));
    }
    await route.fulfill({
      json: {
        items,
        total,
        page,
        page_size: pageSize,
        counts: { photo: total, video: 0 },
        public_counts: { photo: total, video: 0 },
      },
    });
  };

  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());
    const { pathname } = url;
    if (pathname === "/api/v1/memories/recommend") {
      await route.fulfill({ json: [] });
      return;
    }
    if (pathname === "/api/v1/memories/preheat-status") {
      await route.fulfill({ json: { status: "ready", processed: 1, total: 1 } });
      return;
    }
    if (pathname === "/api/v1/memories") {
      await serveList(route);
      return;
    }
    if (pathname.endsWith("/thumbnail")) {
      await route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/webp",
      });
      return;
    }
    if (pathname.endsWith("/file")) {
      if (options.fileDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.fileDelayMs));
      }
      await route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/png",
      });
      return;
    }
    const detailMatch = pathname.match(/^\/api\/v1\/memories\/([A-Za-z0-9_-]+)$/);
    if (detailMatch) {
      const zeroBased = Number(detailMatch[1].split("-").pop()) - 1;
      await route.fulfill({ json: itemAt(zeroBased) });
      return;
    }
    await route.fallback();
  });

  return { requestedPagesRef: () => requestedPages, itemAt };
}

async function openViewerOnFirstCard(page: Page) {
  await page.goto("/");
  await expect(page.locator(".masonry .post-card").first()).toBeVisible();
  await page.locator(".masonry .post-card").first().locator("button").click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function swipe(page: Page, dx: number, dy: number) {
  const centerX = 640;
  const centerY = 360;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + dx, centerY + dy, { steps: 8 });
  await page.mouse.up();
}

test("viewer navigates with horizontal swipe at zoom 1", async ({ page }) => {
  await mockLibrary(page, 5);
  await openViewerOnFirstCard(page);

  const counter = page.locator(".viewer-counter");
  await expect(counter).toHaveText("1 / 5");

  // 左滑 → 下一张
  await swipe(page, -120, 0);
  await expect(counter).toHaveText("2 / 5");

  // 右滑 → 上一张
  await swipe(page, 120, 0);
  await expect(counter).toHaveText("1 / 5");
});

test("viewer ignores vertical and sub-threshold drags", async ({ page }) => {
  await mockLibrary(page, 5);
  await openViewerOnFirstCard(page);

  const counter = page.locator(".viewer-counter");
  await expect(counter).toHaveText("1 / 5");

  // 纵向为主的拖拽不翻页
  await swipe(page, 0, 140);
  await expect(counter).toHaveText("1 / 5");

  // 横向但低于阈值的拖拽不翻页
  await swipe(page, -24, 0);
  await expect(counter).toHaveText("1 / 5");
});

test("viewer auto-loads the next page near the loaded end and reaches library end", async ({ page }) => {
  const { requestedPagesRef } = await mockLibrary(page, 20, { page2DelayMs: 250 });
  await openViewerOnFirstCard(page);

  const counter = page.locator(".viewer-counter");
  await expect(counter).toHaveText("1 / 18");

  // 连续右方向键推进到已加载末尾前第 3 项（第 15 项，索引 14 < 18-3 仍不触发）
  for (let step = 2; step <= 15; step += 1) {
    await page.keyboard.press("ArrowRight");
    await expect(counter).toHaveText(`${step} / 18`);
  }

  // 逼近末尾（第 16 项，索引 15 ≥ 18-3）触发自动续载：
  // 加载提示浮现，随后计数换用新总量
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".viewer-load-pill")).toBeVisible();
  await expect(page.locator(".viewer-load-pill")).toHaveText("正在加载更多回忆");
  await expect(counter).toHaveText("16 / 20", { timeout: 5000 });
  await expect(page.locator(".viewer-load-pill")).toHaveCount(0);
  expect(requestedPagesRef().filter((value) => value === 2)).toHaveLength(1);

  // 续载完成后可以一路翻到库末尾，末页时下一张按钮消失
  for (let step = 17; step <= 20; step += 1) {
    await page.keyboard.press("ArrowRight");
    await expect(counter).toHaveText(`${step} / 20`);
  }
  await expect(page.locator(".photo-viewer-nav-next")).toHaveCount(0);
  expect(requestedPagesRef().filter((value) => value === 2)).toHaveLength(1);
});

test("viewer shows title, location and captured date as caption", async ({ page }) => {
  await mockLibrary(page, 5, {
    overrides: { 0: { location: "杭州西湖" } },
  });
  await openViewerOnFirstCard(page);

  await expect(page.locator(".viewer-caption")).toHaveText(
    "memory-1 · 杭州西湖 · 2026年1月1日",
  );
});

test("viewer hides caption when memory has no meta", async ({ page }) => {
  await mockLibrary(page, 5, {
    overrides: { 0: { title: "", captured_at: null } },
  });
  await openViewerOnFirstCard(page);

  await expect(page.locator(".viewer-caption")).toHaveCount(0);
});

test("viewer copies the current viewer URL to the clipboard", async ({ page }) => {
  await mockLibrary(page, 5);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openViewerOnFirstCard(page);

  await page.getByRole("button", { name: "复制链接" }).click();
  await expect(page.locator(".viewer-copy-pill")).toHaveText("链接已复制");

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain("viewer=31111111-1111-4111-8111-000000000000");
});

test("viewer shows duration and dimensions chips while playing video", async ({ page }) => {
  await mockLibrary(page, 5, {
    fileDelayMs: 1000,
    overrides: {
      0: {
        kind: "video",
        title: "视频回忆",
        duration_seconds: 195,
        width: 1920,
        height: 1080,
      },
    },
  });
  await openViewerOnFirstCard(page);

  await page.getByRole("button", { name: "播放视频" }).click();
  await expect(page.locator("video")).toBeVisible();
  // 假缓冲无法真实解码，按既有模式合成 loadeddata 驱动就绪态
  await page
    .locator("video")
    .evaluate((element) => element.dispatchEvent(new Event("loadeddata")));

  await expect(
    page.locator(".video-viewer-shell").getByText("3:15", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".video-viewer-shell").getByText("1920 × 1080", { exact: true }),
  ).toBeVisible();
});
