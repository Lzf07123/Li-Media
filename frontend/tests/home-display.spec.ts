import { expect, test, type Page, type Route } from "@playwright/test";

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type ItemSpec = {
  title: string;
  location: string | null;
  kind?: "photo" | "video";
  width: number;
  height: number;
};

const LIST: ItemSpec[] = [
  { title: "洱海日出", location: "云南大理", width: 1600, height: 900 },
  { title: "西湖晨雾", location: "浙江杭州", width: 800, height: 1000 },
  {
    title: "外滩夜色",
    location: "上海",
    kind: "video",
    width: 1600,
    height: 900,
  },
];

function buildItem(spec: ItemSpec, idSeed: number) {
  const id = `61111111-1111-4111-8111-${String(idSeed).padStart(12, "0")}`;
  return {
    id,
    title: spec.title,
    description: "",
    kind: spec.kind ?? "photo",
    status: "published",
    media_display_state: "displayable",
    public_display_state: "displayable",
    captured_at: "2026-01-01T00:00:00Z",
    location: spec.location,
    file_url: `/api/v1/memories/${id}/file`,
    thumbnail_url: `/api/v1/memories/${id}/thumbnail`,
    duration_seconds: spec.kind === "video" ? 75 : null,
    width: spec.width,
    height: spec.height,
    primary_file: {
      id,
      source: "baidupan",
      remote_id: String(idSeed),
      remote_path: `/cloud/p-${idSeed}`,
      filename: `p-${idSeed}`,
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

async function mockHome(page: Page, options: { endOnly?: boolean } = {}) {
  const items = options.endOnly
    ? LIST.slice(0, 2).map((s, i) => buildItem(s, i + 1))
    : LIST.map((s, i) => buildItem(s, i + 1));
  await page.route("**/api/v1/memories**", async (route: Route) => {
    const url = new URL(route.request().url());
    const { pathname } = url;
    if (pathname === "/api/v1/memories/recommend") {
      await route.fulfill({ json: [] });
      return;
    }
    if (pathname === "/api/v1/memories/preheat-status") {
      await route.fulfill({ json: { status: "ready", processed: 3, total: 3 } });
      return;
    }
    if (pathname === "/api/v1/memories") {
      const keyword = url.searchParams.get("keyword");
      const filtered = keyword
        ? items.filter((item) => item.title.includes(keyword))
        : items;
      await route.fulfill({
        json: {
          items: filtered,
          total: filtered.length,
          page: 1,
          page_size: 18,
          counts: { photo: 2, video: 1 },
          public_counts: { photo: 2, video: 1 },
        },
      });
      return;
    }
    if (pathname.endsWith("/thumbnail") || pathname.endsWith("/file")) {
      await route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/webp",
      });
      return;
    }
    await route.fallback();
  });
}

async function settle(page: Page) {
  await expect(page.locator(".masonry .post-card").first()).toBeVisible({
    timeout: 8000,
  });
  await page.waitForTimeout(500);
}

test("hero header nav renders light over the image in light theme", async ({ page }) => {
  await mockHome(page);
  await page.addInitScript(() => {
    window.localStorage.setItem("limedia-theme", "light");
  });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/");
  await settle(page);

  await expect(page.locator(".hero-stage-media").first()).toBeVisible();
  const navColors = await page.evaluate(() => {
    return Array.from(document.querySelectorAll(".site-nav a")).map((link) => {
      const computed = getComputedStyle(link);
      return {
        current: link.getAttribute("aria-current"),
        color: computed.color,
      };
    });
  });
  // 页眉压图覆盖必须压过 utilities 层：has-hero 下未激活项是白字（0.92），
  // 激活项纯白；否则浅色主题会退回深色令牌、在图上不可控。
  for (const nav of navColors) {
    if (nav.current === "page") {
      expect(nav.color).toBe("rgb(255, 255, 255)");
    } else {
      expect(nav.color).toBe("rgba(240, 244, 243, 0.92)");
    }
  }
});

test("search collapses the hero and restores it after clearing", async ({ page }) => {
  await mockHome(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await settle(page);
  await expect(page.locator(".hero-stage").first()).toBeVisible();

  await page.locator("#library-search").fill("西湖");
  await page.waitForTimeout(800);
  await expect(page.locator(".hero-stage")).toHaveCount(0);
  await expect(page.locator("#library-title")).toBeVisible();
  await expect(page.getByTestId("search-summary")).toBeVisible();

  await page.getByRole("button", { name: "清除搜索" }).click();
  await page.waitForTimeout(800);
  await expect(page.locator(".hero-stage").first()).toBeVisible();
});

test("video badge sits in the top band clear of the caption scrim", async ({ page }) => {
  await mockHome(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await settle(page);

  const badgeStyle = await page.evaluate(() => {
    const badge = document.querySelector(".waterfall-badge");
    if (!badge) return null;
    const computed = getComputedStyle(badge);
    // computed bottom 是使用值（像素）而非 "auto"，只断言 top/right 定位
    return { top: computed.top, right: computed.right, bottomPx: parseFloat(computed.bottom) };
  });
  expect(badgeStyle).not.toBeNull();
  expect(badgeStyle?.top).toBe("10px");
  expect(badgeStyle?.right).toBe("10px");
  // 徽章脱离底部条带：bottom 使用值明显大于触屏 scrim 高度（约 40px）
  expect(badgeStyle!.bottomPx).toBeGreaterThan(60);
});

test("canvas end state separates the two phrases", async ({ page }) => {
  await mockHome(page, { endOnly: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await settle(page);

  await expect(page.getByTestId("canvas-footer")).toHaveText(
    /已经到底了\s*·\s*当前筛选共 2 条/,
  );
});

test("mobile hero fills the viewport edge to edge", async ({ page }) => {
  await mockHome(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await settle(page);

  const box = await page.locator(".hero-stage").boundingBox();
  expect(box).not.toBeNull();
  // 贴视口顶：负边距抵消 sticky 页眉的流内高度（内高 + 上下边框）
  expect(box!.y).toBeLessThanOrEqual(1);
  // 占满首屏：100svh = 可见视口高
  expect(box!.height).toBeGreaterThanOrEqual(810);
  expect(box!.width).toBe(375);
});
