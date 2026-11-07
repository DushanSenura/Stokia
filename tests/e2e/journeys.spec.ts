import { expect, test, type Page } from "@playwright/test";

/** Pages reachable without an account (the public site, the auth screens and the demo-data previews). */
const PUBLIC = ["/", "/login", "/reset-password", "/install", "/preview/dashboard", "/preview/analytics", "/preview/report", "/preview/settings"];

/** Starts listening BEFORE navigation so nothing is missed. */
function watch(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`exception: ${e.message}`));
  page.on("requestfailed", (r) => { if (!/favicon|_vercel|analytics/.test(r.url())) problems.push(`request failed: ${r.url()}`); });
  return problems;
}

test.describe("security headers", () => {
  test("every response carries the hardening headers and does not advertise the framework", async ({ request }) => {
    for (const path of ["/", "/login", "/api/health"]) {
      const res = await request.get(path);
      const h = res.headers();
      expect(h["x-content-type-options"], path).toBe("nosniff");
      expect(h["x-frame-options"], path).toBe("DENY");
      expect(h["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
      expect(h["strict-transport-security"], path).toContain("max-age=");
      expect(h["permissions-policy"], path).toContain("camera=()");
      expect(h["x-powered-by"], path).toBeUndefined();
      const csp = h["content-security-policy"];
      expect(csp, path).toContain("default-src 'self'");
      expect(csp, path).toContain("frame-ancestors 'none'");
      expect(csp, path).toContain("object-src 'none'");
      expect(csp, path).toContain("base-uri 'self'");
      expect(csp, path).not.toMatch(/\*(?!\.)/); // no wildcard sources
    }
  });

  test("the health endpoint reports readiness and never leaks a key or URL", async ({ request }) => {
    const res = await request.get("/api/health");
    expect([200, 503]).toContain(res.status());
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ checks: { supabase: expect.any(Boolean), siteUrl: expect.any(Boolean), invitations: expect.any(Boolean) } });
    expect(text).not.toMatch(/https?:\/\/|eyJ|sb_|service_role/i);
    expect(res.headers()["cache-control"]).toBe("no-store");
  });
});

test.describe("the production build runs clean", () => {
  for (const path of PUBLIC) {
    test(`${path}: no console errors, uncaught exceptions, failed requests or CSP violations`, async ({ page }) => {
      const problems = watch(page);
      await page.addInitScript(() => {
        (window as unknown as { __csp: string[] }).__csp = [];
        document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
      });
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const csp = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
      expect(csp).toEqual([]);
      expect(problems).toEqual([]);
    });
  }
});

test.describe("responsive layout", () => {
  for (const width of [320, 390, 768, 1024, 1440]) {
    test(`no horizontal scrolling at ${width}px on any public page`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const path of PUBLIC) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(over, `${path} at ${width}px overflows by ${over}px`).toBeLessThanOrEqual(0);
      }
    });
  }
});

test.describe("language and theme", () => {
  test("switching to Sinhala translates the page, survives a reload, and switches back", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Count Today. Know Yesterday.");
    await page.getByRole("button", { name: /Language/ }).first().click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("අද ගණන් කරන්න. ඊයේ දැනගන්න.");
    await expect(page.locator("html")).toHaveAttribute("lang", "si");
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("අද ගණන් කරන්න. ඊයේ දැනගන්න.");
    await page.getByRole("button", { name: /භාෂාව|Language/ }).first().click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Count Today. Know Yesterday.");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });

  test("the dark theme choice survives navigation", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Theme/ }).first().click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.goto("/login");
    await expect(page.locator("html")).toHaveClass(/dark/);
  });
});

test.describe("keyboard use", () => {
  test("Tab reaches the main actions on the landing page, in a sensible order, with a visible focus ring", async ({ page, isMobile, browserName }) => {
    test.skip(!!isMobile, "keyboard order is a desktop concern");
    test.skip(browserName === "webkit", "Safari does not Tab to links unless the user enables it in Safari settings, so this cannot be asserted there");
    await page.goto("/");
    const seen: string[] = [];
    for (let i = 0; i < 70; i++) {
      await page.keyboard.press("Tab");
      const label = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return "";
        const cs = getComputedStyle(el);
        const ringed = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0 || cs.boxShadow !== "none";
        return `${(el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 40)}|${ringed ? "ring" : "noring"}`;
      });
      seen.push(label);
    }
    expect(seen.some((s) => /Sign in/.test(s))).toBe(true);
    expect(seen.some((s) => /Get started/i.test(s))).toBe(true);
    expect(seen.filter((s) => s.endsWith("|noring"))).toEqual([]);
  });

  test("the sign-in form works from the keyboard alone and shows errors without a mouse", async ({ page, isMobile }) => {
    test.skip(!!isMobile, "keyboard flow is a desktop concern");
    await page.goto("/login");
    await page.getByLabel("Email").focus();
    await page.keyboard.press("Enter"); // submit empty
    await expect(page.getByRole("alert").first()).toBeVisible();
    await page.getByLabel("Email").fill("someone@example.com");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Password")).toBeFocused();
  });
});

test.describe("unhappy paths", () => {
  test("an unknown page shows the friendly 404 with a way home", async ({ page }) => {
    const res = await page.goto("/this-page-does-not-exist");
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Stokia home/ })).toBeVisible();
  });

  test("every data API refuses anonymous callers with 401 (never 200, never a stack trace)", async ({ request }) => {
    const paths = [
      "/api/notifications", "/api/products/search?q=a", "/api/variants/search?q=a", "/api/exports/products", "/api/exports/stock-history",
      "/api/exports/audit", "/api/exports/backup", "/api/reports/2026-10/pdf", "/api/reports/2026-10/xlsx", "/api/reports/2026-10/csv",
      // the phone app's API
      "/api/v1/me", "/api/v1/home?shop=x", "/api/v1/morning-stock?shop=x", "/api/v1/products?shop=x", "/api/v1/reports?shop=x",
      "/api/v1/reports/2026-10?shop=x", "/api/v1/reports/2026-10/file?shop=x&format=pdf",
      "/api/v1/movements?shop=x",
      "/api/v1/sales-breakdown?shop=x&date=2026-11-06", "/api/v1/sales-breakdown/history?shop=x&variant=y&date=2026-11-06",
    ];
    for (const p of paths) {
      const res = await request.get(p);
      expect(res.status(), p).toBe(401);
      const body = await res.text();
      expect(body, p).not.toMatch(/at .*\.(ts|js):\d+|supabase\.co|stack/i);
    }
    for (const p of ["/api/v1/counts", "/api/v1/variant-labels", "/api/v1/movements", "/api/v1/movements/reverse", "/api/v1/sales-breakdown", "/api/v1/sales-breakdown/clear"]) {
      const res = await request.post(p, { data: { shopId: "x" } });
      expect(res.status(), p).toBe(401);
    }
  });

  test("the phone API sends no cross-origin permission unless an origin is explicitly allowed, and is never cached", async ({ request }) => {
    const res = await request.get("/api/v1/me", { headers: { Origin: "https://evil.example" } });
    expect(res.headers()["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers()["cache-control"]).toBe("no-store");
    const pre = await request.fetch("/api/v1/counts", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
    expect(pre.headers()["access-control-allow-origin"]).toBeUndefined();
  });

  test("the preview routes exist only because this test server sets STOKIA_PREVIEW=1", async ({ request }) => {
    expect((await request.get("/preview/dashboard")).status()).toBe(200);
  });
});
