/**
 * DEMO data for the dashboard preview route only (/preview/dashboard, enabled with STOKIA_PREVIEW=1).
 * It never touches the database and is never used by real pages. Fixed dates keep screenshots and tests deterministic.
 */
import { aggregateDays, buildDailySeries, buildMonthlySeries, monthTotals, type DaySummaryRow } from "./summary";
import type { DashboardData } from "@/server/repositories/dashboard";

export const DEMO_TODAY = "2026-11-06";

const rows: DaySummaryRow[] = [];
const day = (date: string, packet: [string, string], bottle?: [string, string], c = 12, r = 0, p = 0) => {
  rows.push({ sales_date: date, base_unit: "packet", units_sold: packet[0], estimated_amount: packet[1], calculated_count: c, needs_review_count: r, pending_count: p });
  if (bottle) rows.push({ sales_date: date, base_unit: "bottle", units_sold: bottle[0], estimated_amount: bottle[1], calculated_count: 3, needs_review_count: 0, pending_count: 0 });
};
// November so far (closing count of Nov 5 not yet entered -> Nov 5 pending)
day("2026-11-01", ["186", "27900.00"], ["22", "6600.00"]);
day("2026-11-02", ["154", "23100.00"], ["18", "5400.00"]);
day("2026-11-03", ["205", "30750.00"], ["25", "7500.00"], 12, 1, 0);   // one product needs review
day("2026-11-04", ["171", "25650.00"], ["20", "6000.00"], 11, 0, 2);   // partial: two pending
rows.push({ sales_date: "2026-11-05", base_unit: "packet", units_sold: "0", estimated_amount: "0", calculated_count: 0, needs_review_count: 0, pending_count: 15 });
// earlier months (October closed by the Nov 1 count; September never closed)
for (const [d, amt, u] of [["2026-10-15", "612000.00", "4080"], ["2026-08-15", "498000.00", "3320"], ["2026-07-15", "455000.00", "3033"], ["2026-06-15", "431000.00", "2873"], ["2026-05-15", "402000.00", "2680"], ["2026-04-15", "388000.00", "2586"], ["2026-03-15", "371000.00", "2473"], ["2026-02-15", "340000.00", "2266"], ["2026-01-15", "352000.00", "2346"], ["2025-12-15", "395000.00", "2633"]] as const) {
  rows.push({ sales_date: d, base_unit: "packet", units_sold: u, estimated_amount: amt, calculated_count: 12, needs_review_count: 0, pending_count: 0 });
}

const byDate = aggregateDays(rows);
// Every month's first-day count exists (so the month before it is closed) EXCEPT 1 Oct: September stays "waiting for its closing count".
const confirmed = new Set<string>([
  "2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-11-01",
  "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05",
]);
const sessions = new Map([...confirmed].map((d, i) => [d, `demo-session-${i}`]));

export function demoDashboard(over: { todayState?: "none" | "draft" | "confirmed" } = {}): DashboardData {
  const todayState = over.todayState ?? "none";
  return {
    today: DEMO_TODAY, salesDate: "2026-11-05", month: "2026-11",
    morning: { countDate: DEMO_TODAY, salesDate: "2026-11-05", state: todayState, sessionId: todayState === "confirmed" ? "demo-session-5" : null,
      last: { date: "2026-11-05", confirmedAt: "2026-11-05T02:41:00.000Z", by: "Nimal Perera", sessionId: "demo-session-4" } },
    yesterday: { kind: "pending", reason: "awaiting_next_count" },
    monthTotals: monthTotals(byDate, "2026-11"),
    monthStatus: { status: "in_progress", waitingFor: null },
    daily: buildDailySeries("2026-11", byDate, sessions),
    trend: buildMonthlySeries(byDate, "2026-11", 12, DEMO_TODAY, confirmed),
    top: [
      { variantId: "a", name: "Chilli Powder", size: "250 g", sku: "CHL-250", baseUnit: "packet", units: "312", amount: "46800.00" },
      { variantId: "b", name: "Coconut Oil", size: "1 L", sku: "OIL-1L", baseUnit: "bottle", units: "85", amount: "25500.00" },
      { variantId: "c", name: "Basmati Rice", size: "5 kg", sku: "RIC-5KG", baseUnit: "packet", units: "60", amount: "21000.00" },
      { variantId: "d", name: "Turmeric Powder", size: "100 g", sku: "TUR-100", baseUnit: "packet", units: "140", amount: "12600.00" },
      { variantId: "e", name: "Black Pepper", size: "50 g", sku: "PEP-50", baseUnit: "packet", units: "72", amount: "7200.00" },
    ],
    valuation: { asOf: "2026-11-05", totalCost: "412350.00", valued: 38, uncosted: 3, counted: 41 },
    activeProducts: 46,
    low: { total: 7, items: [
      { variantId: "1", name: "Sugar", size: "1 kg", sku: "SUG-1", baseUnit: "packet", quantity: "0", threshold: "20" },
      { variantId: "2", name: "Chilli Powder", size: "100 g", sku: "CHL-100", baseUnit: "packet", quantity: "6", threshold: "15" },
      { variantId: "3", name: "Coconut Oil", size: "500 ml", sku: "OIL-500", baseUnit: "bottle", quantity: "4", threshold: "8" },
      { variantId: "4", name: "Salt", size: "400 g", sku: "SAL-400", baseUnit: "packet", quantity: "12", threshold: "20" },
    ] },
    pendingCounts: todayState === "confirmed" ? 0 : 1,
    alerts: [
      { id: "count_pending", severity: "warning", href: "/morning-stock", params: { date: DEMO_TODAY } },
      { id: "needs_review", severity: "warning", href: "/stock-history", params: { count: 1 } },
      { id: "low_stock", severity: "info", href: "/dashboard#low-stock", params: { count: 7 } },
    ],
    activity: [
      { kind: "movement", at: "2026-11-05T09:12:00.000Z", title: "stock_received", detail: "+120 packet · Chilli Powder 250 g", by: "Nimal Perera", href: "/movements" },
      { kind: "movement", at: "2026-11-05T07:50:00.000Z", title: "damaged", detail: "-3 bottle · Coconut Oil 1 L", by: "Kamala Silva", href: "/movements" },
      { kind: "count", at: "2026-11-05T02:41:00.000Z", title: "2026-11-05", detail: "", by: "Nimal Perera", href: "/stock-history/demo-session-4" },
      { kind: "count", at: "2026-11-04T02:38:00.000Z", title: "2026-11-04", detail: "", by: "Nimal Perera", href: "/stock-history/demo-session-3" },
    ],
  };
}
