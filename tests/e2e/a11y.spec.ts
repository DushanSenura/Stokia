import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const PAGES = ["/", "/login", "/reset-password", "/install", "/preview/dashboard", "/preview/analytics", "/preview/report", "/preview/settings"];

for (const path of PAGES) {
  for (const scheme of ["light", "dark"] as const) {
    test(`no serious accessibility violations on ${path} (${scheme})`, async ({ page }) => {
      test.setTimeout(60_000); // room for the longer scan allowance below on a loaded machine
      await page.emulateMedia({ colorScheme: scheme });
      await page.addInitScript((s) => localStorage.setItem("theme", s), scheme);
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(900); // entrance animations: contrast must be measured on the settled page, not mid-fade
      // Entrance animations make colours transient: poll until the settled page is clean (a genuine violation never goes away).
      const scan = async () => {
        const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        return results.violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
      };
      // A genuine violation never goes away, so a longer allowance makes this no weaker. It only matters on a fully loaded machine:
      // the scan of the chart-heavy pages (Firefox in particular) can take several seconds per pass when 16 workers compete.
      await expect.poll(scan, { timeout: 25_000, intervals: [300, 700, 1200] }).toEqual([]);
    });
  }
}
