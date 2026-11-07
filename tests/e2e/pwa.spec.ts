import { expect, test } from "@playwright/test";

test.describe("installable app", () => {
  test("the manifest is served and every icon it names exists", async ({ request }) => {
    const res = await request.get("/manifest.webmanifest");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("json");
    const m = await res.json();
    expect(m).toMatchObject({ short_name: "Stokia", display: "standalone", start_url: "/dashboard", scope: "/" });
    expect(m.icons.some((i: { purpose: string }) => i.purpose === "maskable")).toBe(true);
    for (const icon of [...m.icons, { src: "/icons/apple-touch-icon.png" }]) {
      const r = await request.get(icon.src);
      expect(r.status(), icon.src).toBe(200);
      expect(r.headers()["content-type"], icon.src).toContain("image/png");
    }
  });

  test("pages link the manifest and the iPhone home-screen icon", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", /manifest\.webmanifest/);
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", /apple-touch-icon\.png/);
    await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute("content", "Stokia");
  });

  test("the service worker file is served fresh (never cached by the browser) and the offline page exists", async ({ request }) => {
    const sw = await request.get("/sw.js");
    expect(sw.status()).toBe(200);
    expect(sw.headers()["content-type"]).toContain("javascript");
    expect(sw.headers()["cache-control"]).toContain("no-store");
    const offline = await request.get("/offline.html");
    expect(offline.status()).toBe(200);
    expect(await offline.text()).toContain("You are offline");
  });

  test("the install page explains Android and iPhone, and is reachable from the landing page", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Install Stokia" }).click();
    await expect(page).toHaveURL(/\/install$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Install Stokia on your phone");
    await expect(page.getByRole("heading", { name: "Android (Chrome)" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "iPhone (Safari)" })).toBeVisible();
    await expect(page.getByText(/Add to Home Screen/)).toBeVisible();
    await expect(page.getByText(/never stores signed-in pages for offline reading/)).toBeVisible();
  });
});

test.describe("offline behaviour @chromium-only", () => {
  test("the app registers its service worker, and with no connection shows the offline page instead of a stale or cached page", async ({ page, context }) => {
    await page.goto("/login");
    // Wait until the worker is active and controlling this page.
    const state = () => page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return { script: reg?.active?.scriptURL ?? null, controlled: !!navigator.serviceWorker.controller };
    });
    await expect.poll(state, { timeout: 20_000, intervals: [250, 500, 1000] }).toMatchObject({ script: expect.stringMatching(/\/sw\.js$/), controlled: true });

    // The offline page and icons were precached at install.
    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const urls: string[] = [];
      for (const n of names) for (const r of await (await caches.open(n)).keys()) urls.push(new URL(r.url).pathname);
      return urls;
    });
    expect(cached).toContain("/offline.html");

    await context.setOffline(true);
    // A page that WAS just visited must still not be served from a cache: pages hold private data and are never stored.
    await page.goto("/login").catch(() => undefined);
    await expect(page.getByRole("heading", { name: "You are offline" })).toBeVisible();
    await page.goto("/").catch(() => undefined);
    await expect(page.getByRole("heading", { name: "You are offline" })).toBeVisible();
    await expect(page.getByText("ඔබ නොබැඳි")).toBeVisible();

    // And nothing it stored contains a page or an API response.
    await context.setOffline(false);
    await page.goto("/login");
    const stored = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) urls.push(new URL(r.url).pathname);
      return urls;
    });
    expect(stored.filter((p) => p.startsWith("/api/") || p === "/login" || p === "/" || p === "/dashboard")).toEqual([]);
  });
});
