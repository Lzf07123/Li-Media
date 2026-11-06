import { expect, test } from "@playwright/test";

// 真栈冒烟：仅当 PLAYWRIGHT_BASE_URL 指向 docker compose 栈时执行。
// 本地 preview（默认 webServer）没有 /api 代理，这些断言不适用；
// 存量 spec 全部在浏览器层 mock API，与真栈互不影响。
const dockerStackBase = process.env.PLAYWRIGHT_BASE_URL ?? "";

test.skip(
  !dockerStackBase,
  "PLAYWRIGHT_BASE_URL 未设置：真栈冒烟只在指向 docker compose 栈时运行",
);

test("docker stack serves frontend and backend health through nginx", async ({
  request,
}) => {
  const frontend = await request.get("/healthz");
  expect(frontend.status()).toBe(200);

  const backend = await request.get("/api/v1/healthz");
  expect(backend.status()).toBe(200);
});

test("docker stack exposes public preheat status without internals", async ({
  request,
}) => {
  const response = await request.get("/api/v1/memories/preheat-status");
  expect(response.status()).toBe(200);

  const payload = await response.json();
  expect([
    "running",
    "not_preheated",
    "ready",
    "degraded",
    "unavailable",
  ]).toContain(payload.status);
  expect(Object.keys(payload)).toEqual(["status", "processed", "total"]);
});
