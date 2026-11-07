import { expect, test } from "@playwright/test";

test("landing page renders brand, hero and works at this viewport without horizontal overflow", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Count Today. Know Yesterday.");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});

test("landing calculator computes yesterday's sales", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Rs. 4,200.00")).toBeVisible();
  await page.getByLabel("Today morning count").fill("");
  await expect(page.getByText(/Enter today's count/)).toBeVisible();
});

test("protected routes redirect anonymous users to login", async ({ page }) => {
  await page.goto("/morning-stock");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
});

test("login validates input", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
});

test("theme toggle switches to dark", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Theme/ }).first().click();
  await expect(page.locator("html")).toHaveClass(/dark/); // Playwright defaults to a light colour scheme
});

for (const path of ["/products", "/products/new", "/products/import", "/products/categories", "/packaging", "/packaging/00000000-0000-4000-8000-000000000000", "/morning-stock", "/stock-history", "/stock-history/00000000-0000-4000-8000-000000000000", "/movements", "/movements/new", "/movements/repack", "/analytics", "/reports", "/reports/2026-10", "/settings", "/settings/profile", "/settings/shop", "/settings/team", "/settings/corrections", "/settings/audit", "/settings/data"]) {
  test(`anonymous access to ${path} redirects to login`, async ({ page }) => {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login\?next=/);
  });
}

test("catalog export API rejects anonymous requests", async ({ request }) => {
  const res = await request.get("/api/exports/products", { maxRedirects: 0 });
  expect(res.status()).toBe(401);
});

test("stock history export API rejects anonymous requests", async ({ request }) => {
  const res = await request.get("/api/exports/stock-history", { maxRedirects: 0 });
  expect(res.status()).toBe(401);
});

test("variant search API rejects anonymous requests", async ({ request }) => {
  const res = await request.get("/api/variants/search?q=chilli", { maxRedirects: 0 });
  expect(res.status()).toBe(401);
});

test.describe("dashboard (demo-data preview)", () => {
  test("renders every required section with no horizontal overflow", async ({ page }) => {
    await page.goto("/preview/dashboard");
    await expect(page.getByRole("link", { name: "Enter Morning Stock" })).toBeVisible();
    for (const k of ["Yesterday's Estimated Sales", "Monthly Estimated Sales", "Current Stock Value", "Pending Stock Counts"]) await expect(page.getByText(k).first()).toBeVisible();
    for (const h of ["Daily Estimated Sales", "Top-selling products", "Low-stock alerts", "Recent stock activity", "Quick actions"]) await expect(page.getByRole("heading", { name: h })).toBeVisible();
    // charts actually drew (an <svg> with bars/lines), not just empty frames
    await expect(page.locator("svg.recharts-surface").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  });

  test("yesterday is PENDING while this morning's count is missing, never an old figure", async ({ page }) => {
    await page.goto("/preview/dashboard");
    await expect(page.getByText("Pending", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Waiting for the next morning's count.").first()).toBeVisible();
  });

  test("a confirmed count replaces the entry button", async ({ page }) => {
    await page.goto("/preview/dashboard?state=confirmed");
    await expect(page.getByText("Today's count is confirmed").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Enter Morning Stock" })).toHaveCount(0);
  });

  test("every chart has a table alternative", async ({ page }) => {
    await page.goto("/preview/dashboard");
    const toggles = page.getByText("Show as a table");
    await expect(toggles).toHaveCount(3);
    await toggles.first().click();
    await expect(page.getByRole("table").first()).toBeVisible();
  });

  test("hovering a bar shows a tooltip with the value", async ({ page }) => {
    await page.goto("/preview/dashboard");
    const bar = page.locator(".recharts-bar-rectangle").first();
    await bar.hover();
    await expect(page.getByText(/Rs\. \d/).first()).toBeVisible();
  });
});

test("report export, product search and notification APIs reject anonymous requests", async ({ request }) => {
  for (const url of ["/api/reports/2026-10/pdf", "/api/reports/2026-10/xlsx", "/api/reports/2026-10/csv", "/api/products/search?q=a", "/api/notifications"]) {
    expect((await request.get(url, { maxRedirects: 0 })).status(), url).toBe(401);
  }
});

test.describe("analytics and reports (demo-data preview)", () => {
  test("analytics shows filters, headline figures, charts with table alternatives and no overflow", async ({ page }) => {
    await page.goto("/preview/analytics");
    await expect(page.getByRole("heading", { level: 1, name: "Sales Analytics" })).toBeVisible();
    await expect(page.getByLabel("From")).toBeVisible();
    for (const h of ["Estimated Sales by day", "Month over month", "Monthly Estimated Sales", "Sales by category", "Best sellers", "Product-wise sales", "Size-wise sales", "Slow movers"]) await expect(page.getByRole("heading", { name: h })).toBeVisible();
    await expect.poll(() => page.locator("svg.recharts-surface").count()).toBeGreaterThanOrEqual(4); // charts measure their container after first paint
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  });

  test("report page: status, export links and the 'not cash' statement", async ({ page }) => {
    await page.goto("/preview/report");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("October 2026");
    await expect(page.getByRole("link", { name: "PDF" })).toHaveAttribute("href", "/api/reports/2026-10/pdf");
    await expect(page.getByText(/not confirmed cash receipts/)).toBeVisible();
    await expect(page.getByText("Complete", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  });

  test("an unclosed month says it is waiting for the closing count", async ({ page }) => {
    await page.goto("/preview/report?state=pending");
    await expect(page.getByText("Waiting for the 1 November 2026 count").first()).toBeVisible();
  });

  test("printing: export controls disappear, and the browser can render a real PDF of the report", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "page.pdf() is Chromium-only");
    await page.goto("/preview/report");
    await page.emulateMedia({ media: "print" });
    await expect(page.getByRole("link", { name: "PDF" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Print" })).toBeHidden();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const pdf = await page.pdf({ landscape: true, format: "A4", printBackground: true });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(20_000);
  });
});

test.describe("report exporters in the production build", () => {
  test("PDF, Excel and CSV are generated by the bundled server code", async ({ request }) => {
    const pdf = await request.get("/preview/export/pdf");
    expect(pdf.status()).toBe(200);
    const pdfBody = await pdf.body();
    expect(pdfBody.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdfBody.toString("latin1")).toContain("Stokia Monthly Report: October 2026");

    const xlsx = await request.get("/preview/export/xlsx");
    expect(xlsx.status()).toBe(200);
    expect((await xlsx.body()).subarray(0, 2).toString()).toBe("PK"); // a zip container, i.e. a real .xlsx

    const csv = await request.get("/preview/export/csv");
    expect(csv.status()).toBe(200);
    const text = await csv.text();
    expect(text).toContain("Stokia Monthly Report");
    expect(text).toContain("ESTIMATED SALES");
    expect(text).toContain("units_sold_inferred");
  });
});

test("the backup download requires sign-in", async ({ request }) => {
  expect((await request.get("/api/exports/backup")).status()).toBe(401);
});

test("the audit export requires sign-in", async ({ request }) => {
  const res = await request.get("/api/exports/audit");
  expect(res.status()).toBe(401);
});
