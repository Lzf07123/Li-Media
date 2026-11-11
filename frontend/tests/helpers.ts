import { expect, type Locator, type Page } from "@playwright/test";

/**
 * 并发负载下画布卡片的单次点击可能被 React 重渲染吞掉（查看器未挂载）。
 * 点击后短暂等待查看器出现，未出现则重试；稳态下首次点击必然成功，
 * 重试窗口只覆盖负载毛刺——最终仍以 toBeVisible 断言，真实回归不放过。
 */
export async function openViewerByCardClick(page: Page, card: Locator) {
  const viewer = page.locator(".photo-viewer");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await card.click();
    const opened = await viewer
      .waitFor({ state: "visible", timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (opened) {
      return;
    }
  }
  await expect(viewer).toBeVisible();
}
