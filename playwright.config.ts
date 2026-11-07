import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: "list",
  use: { baseURL: "http://localhost:3100", trace: "on-first-retry" },
  webServer: { command: "npm run build && npx next start -p 3100", env: { STOKIA_PREVIEW: "1", STOKIA_PLAIN_HTTP: "1" }, url: "http://localhost:3100", reuseExistingServer: true, timeout: 240_000 },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    // Engine coverage: Firefox (Gecko) and Safari (WebKit, desktop and iPhone). Run with `npm run e2e:all`.
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, grepInvert: /@chromium-only/ },
    { name: "webkit", use: { ...devices["Desktop Safari"] }, grepInvert: /@chromium-only/ },
    { name: "iphone", use: { ...devices["iPhone 14"] }, grepInvert: /@chromium-only/ },
  ],
});
