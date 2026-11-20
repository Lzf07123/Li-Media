import { defineConfig } from "@playwright/test";

// Leptos(trunk)版:webServer 起 trunk serve(4173),/api 由 Trunk.toml
// 代理转发 Go 后端。PLAYWRIGHT_BASE_URL 指向已运行实例时跳过自启。
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  reporter: [["line"]],
  use: {
    baseURL,
    channel: "chrome",
    colorScheme: "light",
    trace: "retain-on-failure",
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "trunk serve --port 4173",
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
