import { expect, test, type Page } from "@playwright/test";

const memoryId = "0e1c6c1d-34a4-459b-8f85-e7ac76b1fbd0";
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const memory = {
  id: memoryId,
  title: "湖边清晨",
  description: "安静的水面和缓慢亮起来的天。",
  kind: "photo",
  status: "published",
  captured_at: "2026-01-01T08:30:00Z",
  location: "杭州",
  file_url: `/api/v1/memories/${memoryId}/file`,
  thumbnail_url: `/api/v1/memories/${memoryId}/thumbnail`,
  duration_seconds: null,
  width: 2400,
  height: 1200,
  primary_file: {
    id: "e0c37e9a-8ec7-4b8f-8c92-2e6ee3b18cd1",
    source: "upload",
    remote_path: "lake.png",
    mime_type: "image/png",
    size_bytes: 1024,
    status: "matched",
    last_synced_at: null,
    sync_error: null,
  },
  created_at: "2026-01-01T08:35:00Z",
  updated_at: "2026-01-01T08:35:00Z",
};

const memoryList = {
  items: [memory],
  total: 1,
  page: 1,
  page_size: 24,
};

async function mockPublicMemoryRoutes(page: Page) {
  await page.route("**/api/v1/memories**", async (route) => {
    const url = new URL(route.request().url());

    if (url.pathname === "/api/v1/memories") {
      await route.fulfill({ json: memoryList });
      return;
    }

    if (url.pathname === `/api/v1/memories/${memoryId}`) {
      await route.fulfill({ json: memory });
      return;
    }

    if (url.pathname === `/api/v1/memories/${memoryId}/file`) {
      await route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/png",
      });
      return;
    }

    if (url.pathname === `/api/v1/memories/${memoryId}/thumbnail`) {
      await route.fulfill({
        body: Buffer.from(pngBase64, "base64"),
        contentType: "image/webp",
      });
      return;
    }

    await route.fulfill({ status: 404, json: { detail: "not found" } });
  });
}

test("home shows memory and toggles between light and dark", async ({ page }) => {
  await mockPublicMemoryRoutes(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "回忆库" })).toBeVisible();
  await expect(page.getByText("湖边清晨")).toBeVisible();
  await expect(page.locator("html")).not.toHaveClass(/dark/);

  await page.getByRole("button", { name: "切换到深色主题" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(
    page.getByRole("button", { name: "切换到浅色主题" }),
  ).toBeVisible();
});

test("detail shows media metadata", async ({ page }) => {
  await mockPublicMemoryRoutes(page);
  await page.goto(`/memories/${memoryId}`);

  await expect(page.getByRole("heading", { name: "湖边清晨" })).toBeVisible();
  await expect(page.getByText("2400 × 1200")).toBeVisible();
  await expect(page.getByRole("button", { name: "打开图片查看器" })).toBeVisible();
  await expect(page.locator("img[alt=\"湖边清晨\"]")).toBeVisible();
});

test("admin table is visible in dark mode", async ({ page }) => {
  await page.route("**/api/v1/admin/memories", async (route) => {
    await route.fulfill({ json: { items: [memory], total: 1 } });
  });
  await page.goto("/admin");

  await expect(page.getByRole("heading", { name: "回忆管理" })).toBeVisible();
  await expect(page.getByText("湖边清晨")).toBeVisible();
  await page.getByRole("button", { name: "切换到深色主题" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(
    page.getByRole("button", { name: "切换到浅色主题" }),
  ).toBeVisible();
});
