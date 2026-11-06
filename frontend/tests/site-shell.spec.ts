import { expect, test, type Page } from "@playwright/test";

// 沉浸式页眉（V1.7）与 mt-auto 页脚（V1.5）的壳层契约：
// 顶部透明融合 → 滚动后同源雾化，高度滚动前后不变；页脚文档流贴底。
// 参数为模板 reusable-tokens.template.css 的逐值实例化验收。

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

async function mockLibrary(page: Page, itemCount = 1) {
  const items = Array.from({ length: itemCount }, (_, index) =>
    memory(`41111111-1111-4111-8111-${String(index).padStart(12, "0")}`),
  );
  await page.route("**/api/v1/memories/recommend**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/v1/memories/preheat-status", (route) =>
    route.fulfill({ json: { status: "ready", processed: 1, total: 1 } }),
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
      await route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/webp",
      });
      return;
    }
    await route.fulfill({ json: items[0] });
  });
}

async function mockEmptyLibrary(page: Page) {
  await mockLibrary(page, 0);
}

test("immersive header stays transparent on top and fogs after scrolling", async ({
  page,
}) => {
  await mockLibrary(page, 6);
  await page.goto("/");
  await expect(page.locator(".masonry .post-card").first()).toBeVisible();

  const header = page.locator(".site-header");
  const heightBefore = (await header.boundingBox())?.height ?? 0;

  // 顶部：背景与边框全透明、无雾化、流光线隐藏
  await expect(header).toHaveCSS("background-color", "rgba(246, 251, 249, 0)");
  await expect(header).toHaveCSS("border-bottom-color", "rgba(216, 231, 226, 0)");
  await expect(header).toHaveCSS("backdrop-filter", "none");
  await expect(header).not.toHaveClass(/is-scrolled/);
  await expect(header.locator(".flow-rule")).toHaveCSS("opacity", "0");

  await page.evaluate(() => window.scrollTo(0, 200));
  await expect(header).toHaveClass(/is-scrolled/);
  // 浏览器对 alpha 计算值保留两位小数：eb/255 ≈ 0.92
  await expect(header).toHaveCSS("background-color", "rgba(246, 251, 249, 0.92)");
  expect(await header.evaluate((el) => getComputedStyle(el).backdropFilter)).toContain(
    "blur(18px)",
  );
  expect(await header.evaluate((el) => getComputedStyle(el).backdropFilter)).toContain(
    "saturate(1.45)",
  );
  expect(await header.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
  await expect(header.locator(".flow-rule")).toHaveCSS("opacity", "0.2");

  // 滚动前后高度不变（桌面内容高 72px）
  const heightAfter = (await header.boundingBox())?.height ?? 0;
  expect(Math.abs(heightAfter - heightBefore)).toBeLessThanOrEqual(0.5);
  expect(heightBefore).toBeLessThanOrEqual(74.01);
  expect(heightBefore).toBeGreaterThanOrEqual(71.99);
});

test("immersive header keeps stable height on mobile", async ({ page }) => {
  await mockLibrary(page, 6);
  await page.setViewportSize({ width: 375, height: 720 });
  await page.goto("/");
  await expect(page.locator(".masonry .post-card").first()).toBeVisible();

  const header = page.locator(".site-header");
  const heightBefore = (await header.boundingBox())?.height ?? 0;
  expect(heightBefore).toBeLessThanOrEqual(66.01);
  expect(heightBefore).toBeGreaterThanOrEqual(63.99);

  await page.evaluate(() => window.scrollTo(0, 200));
  await expect(header).toHaveClass(/is-scrolled/);
  const heightAfter = (await header.boundingBox())?.height ?? 0;
  expect(Math.abs(heightAfter - heightBefore)).toBeLessThanOrEqual(0.5);

  // 移动端壳层覆盖回归：桌面导航隐藏、外露首页 + 二级菜单、品牌文字保留
  await expect(page.locator(".site-nav")).toHaveCSS("display", "none");
  await expect(page.locator(".mobile-nav-primary")).toHaveCSS("display", "flex");
  await expect(page.locator(".brand-name-text")).toBeVisible();
});

test("brand text hides below 360px while shell stays usable", async ({ page }) => {
  await mockLibrary(page, 1);
  await page.setViewportSize({ width: 360, height: 700 });
  await page.goto("/");
  await expect(page.locator(".site-header")).toBeVisible();
  await expect(page.locator(".brand-name-text")).toHaveCSS("display", "none");
  await expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
});

test("in-flow footer sticks to viewport bottom on short pages", async ({ page }) => {
  await mockEmptyLibrary(page);
  await page.goto("/");
  await expect(page.locator(".site-footer")).toBeVisible();

  const footer = page.locator(".site-footer");
  await expect(footer).toHaveCSS("position", "relative");
  // mt-auto 贴底：页脚是文档流最后一个元素，底边与文档底边重合
  await expect
    .poll(async () => {
      const box = await footer.boundingBox();
      const docHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      return box ? box.y + box.height - docHeight : Number.NaN;
    })
    .toBeLessThanOrEqual(1);
  // 单行高 56px（min-h-14 兜底）
  const height = (await footer.boundingBox())?.height ?? 0;
  expect(height).toBeLessThanOrEqual(57.01);
  expect(height).toBeGreaterThanOrEqual(55.99);
});
