/**
 * DEMO data for the /preview/analytics and /preview/report routes only (enabled with STOKIA_PREVIEW=1).
 * Never touches the database and is never used by real pages. Fixed dates keep screenshots and tests deterministic.
 */
import {
  aggregateCategories, aggregateProducts, buildSeries, compareMonths, coverage, rangeTotals, slowMovers, topSellers,
  type MovementTrendRow, type VariantSalesRow,
} from "@/features/analytics/aggregate";
import { aggregateDays, buildMonthlySeries, type DaySummaryRow } from "@/features/dashboard/summary";
import { buildMonthlyReport, type ReportVariantRow } from "./report";
import type { AnalyticsData } from "@/server/repositories/analytics";

export const DEMO_TODAY = "2026-11-06";

const rv = (o: Partial<ReportVariantRow> & { variant_id: string; product_name: string }): ReportVariantRow => ({
  product_id: `p-${o.variant_id}`, product_code: o.product_name.slice(0, 4).toUpperCase(), category_id: "spices", category_name: "Spices", sku: `${o.variant_id.toUpperCase()}-1`,
  size_value: "250", size_unit: "g", base_unit: "packet", is_active: true, opening: "400", closing: "310", received: "200", returned_in: "0", damaged_out: "0", other_out: "0", adjustments: "0",
  units_sold: "290", estimated_amount: "43500.00", days_calculated: 31, days_review: 0, days_pending: 0, max_revision: 1, closing_cost: "100", closing_value: "31000.00", ...o,
});

export const demoReportRows: ReportVariantRow[] = [
  rv({ variant_id: "chl", product_name: "Chilli Powder" }),
  rv({ variant_id: "chl1", product_name: "Chilli Powder", size_value: "100", size_unit: "g", opening: "250", closing: "180", received: "120", units_sold: "190", estimated_amount: "20900.00", closing_cost: "45", closing_value: "8100.00", max_revision: 2 }),
  rv({ variant_id: "tur", product_name: "Turmeric Powder", size_value: "100", size_unit: "g", opening: "300", closing: "220", received: "0", units_sold: "80", estimated_amount: "7200.00", closing_cost: "55", closing_value: "12100.00" }),
  rv({ variant_id: "pep", product_name: "Black Pepper", size_value: "50", size_unit: "g", opening: "120", closing: "95", received: "0", units_sold: "20", estimated_amount: "2000.00", days_calculated: 30, days_review: 1, closing_cost: null, closing_value: null }),
  rv({ variant_id: "oil", product_name: "Coconut Oil", category_id: "oils", category_name: "Oils", base_unit: "bottle", size_value: "1", size_unit: "l", opening: "90", closing: "62", received: "60", damaged_out: "3", units_sold: "85", estimated_amount: "25500.00", closing_cost: "250", closing_value: "15500.00" }),
  rv({ variant_id: "ric", product_name: "Basmati Rice", category_id: "grains", category_name: "Grains", size_value: "5", size_unit: "kg", opening: "80", closing: "20", received: "0", units_sold: "60", estimated_amount: "21000.00", closing_cost: "300", closing_value: "6000.00" }),
  rv({ variant_id: "sug", product_name: "Sugar", category_id: null, category_name: null, size_value: "1", size_unit: "kg", opening: "100", closing: "0", received: "0", units_sold: "100", estimated_amount: "13000.00", closing_cost: "110", closing_value: "0.00" }),
  rv({ variant_id: "sin", product_name: "මිරිස් කුඩු", size_value: "100", size_unit: "g", opening: null, closing: "40", received: "0", units_sold: "0", estimated_amount: "0.00", days_calculated: 0, days_pending: 31, closing_cost: "40", closing_value: "1600.00" }),
];

const daily: DaySummaryRow[] = [];
for (let d = 1; d <= 31; d++) {
  const date = `2026-10-${String(d).padStart(2, "0")}`;
  const wave = 1 + 0.35 * Math.sin(d / 3) + (new Date(`${date}T00:00:00Z`).getUTCDay() === 6 ? 0.4 : 0);
  daily.push({ sales_date: date, base_unit: "packet", units_sold: String(Math.round(18 * wave)), estimated_amount: (Math.round(18 * wave) * 1250).toFixed(2), calculated_count: 7, needs_review_count: d === 12 ? 1 : 0, pending_count: 0 });
  daily.push({ sales_date: date, base_unit: "bottle", units_sold: String(Math.round(3 * wave)), estimated_amount: (Math.round(3 * wave) * 300).toFixed(2), calculated_count: 1, needs_review_count: 0, pending_count: 0 });
}
for (let d = 1; d <= 5; d++) {
  const date = `2026-11-${String(d).padStart(2, "0")}`;
  if (d === 5) daily.push({ sales_date: date, base_unit: "packet", units_sold: "0", estimated_amount: "0", calculated_count: 0, needs_review_count: 0, pending_count: 8 });
  else daily.push({ sales_date: date, base_unit: "packet", units_sold: String(16 + d), estimated_amount: ((16 + d) * 1250).toFixed(2), calculated_count: 7, needs_review_count: 0, pending_count: 0 });
}
// earlier months for the trend
for (const [m, amt] of [["2025-12", 395000], ["2026-01", 352000], ["2026-02", 340000], ["2026-03", 371000], ["2026-04", 388000], ["2026-05", 402000], ["2026-06", 431000], ["2026-07", 455000], ["2026-08", 498000], ["2026-09", 531000]] as const) {
  daily.push({ sales_date: `${m}-15`, base_unit: "packet", units_sold: String(Math.round(amt / 125)), estimated_amount: amt.toFixed(2), calculated_count: 7, needs_review_count: 0, pending_count: 0 });
}

export function demoReport(over: { closed?: boolean } = {}) {
  const closed = over.closed ?? true;
  return buildMonthlyReport({
    month: "2026-10", today: DEMO_TODAY, shopName: "Perera Stores (demo data)", timezone: "Asia/Colombo", generatedAt: "2026-11-06T08:30:00.000Z",
    rows: demoReportRows, daily: daily.filter((d) => d.sales_date.startsWith("2026-10")), hasClosingCount: closed, fingerprint: "demo-now",
    exports: [{ format: "pdf", exported_at: "2026-11-03T04:00:00.000Z", fingerprint: "demo-old" }],
    lowStock: [{ name: "Sugar", size: "1 kg", sku: "SUG-1", unit: "packet", quantity: "0", threshold: "20" }, { name: "Basmati Rice", size: "5 kg", sku: "RIC-5", unit: "packet", quantity: "20", threshold: "30" }],
  });
}

const vs = (id: string, name: string, cat: string | null, unit: string, units: string, amount: string, dc = 22, dr = 0, size: [string, string] | null = null): VariantSalesRow => ({
  variant_id: id, product_id: `p-${id}`, product_name: name, category_id: cat, category_name: cat, sku: id, size_value: size?.[0] ?? null, size_unit: size?.[1] ?? null,
  base_unit: unit, units_sold: units, estimated_amount: amount, days_calculated: dc, days_review: dr, days_pending: 0,
});

export function demoAnalytics(): AnalyticsData {
  const byDate = aggregateDays(daily);
  const variants = [
    vs("chl250", "Chilli Powder", "Spices", "packet", "312", "46800.00", 22, 1, ["250", "g"]), vs("oil1", "Coconut Oil", "Oils", "bottle", "85", "25500.00", 22, 0, ["1", "l"]),
    vs("ric5", "Basmati Rice", "Grains", "packet", "60", "21000.00", 22, 0, ["5", "kg"]), vs("chl100", "Chilli Powder", "Spices", "packet", "190", "20900.00", 22, 0, ["100", "g"]),
    vs("tur", "Turmeric Powder", "Spices", "packet", "80", "7200.00", 22, 0, ["100", "g"]), vs("sug", "Sugar", null, "packet", "100", "13000.00", 22, 0, ["1", "kg"]),
    vs("pep", "Black Pepper", "Spices", "packet", "20", "2000.00", 22, 1, ["50", "g"]), vs("tea", "Ceylon Tea", "Beverages", "packet", "0", "0.00", 22, 0, ["200", "g"]),
  ];
  const from = "2026-10-06", to = "2026-11-05";
  const mov: MovementTrendRow[] = [];
  for (let i = 0; i < 31; i++) {
    const d = new Date(Date.UTC(2026, 9, 6 + i)).toISOString().slice(0, 10);
    if (i % 7 === 2) mov.push({ day: d, base_unit: "packet", received: String(120 + (i % 3) * 40), returned_in: "0", damaged_out: "0", other_out: "0", adjustments: "0", movement_count: 1 });
    if (i % 9 === 4) mov.push({ day: d, base_unit: "packet", received: "0", returned_in: "2", damaged_out: String(3 + (i % 4)), other_out: "0", adjustments: i % 2 ? "-2" : "3", movement_count: 2 });
    if (i % 10 === 5) mov.push({ day: d, base_unit: "bottle", received: "24", returned_in: "0", damaged_out: "2", other_out: "0", adjustments: "0", movement_count: 2 });
  }
  const confirmed = new Set(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]);
  return {
    today: DEMO_TODAY, range: { from, to, days: 31, clamped: false }, filters: { category: null, product: null, variant: null }, granularity: "day",
    totals: rangeTotals(byDate, from, to), coverage: coverage(byDate, from, to),
    series: buildSeries(byDate, from, to, "day"), trend: buildMonthlySeries(byDate, "2026-11", 12, DEMO_TODAY, confirmed),
    compare: compareMonths(byDate, "2026-11", DEMO_TODAY),
    products: aggregateProducts(variants), categories: aggregateCategories(variants), variants,
    top: topSellers(variants, 10), slow: slowMovers(variants, 10),
    movement: { units: ["packet", "bottle"], unit: "packet", rows: mov },
    sessionByDate: new Map(), error: false,
  };
}
