import { describe, expect, it } from "vitest";
import {
  aggregateCategories, aggregateProducts, buildSeries, compareMonths, coverage, pickMovementUnit, rangeTotals, slowMovers, topSellers, weekStart,
  type VariantSalesRow,
} from "@/features/analytics/aggregate";
import { aggregateDays, type DaySummaryRow } from "@/features/dashboard/summary";

const v = (id: string, product: string, cat: string | null, unit: string, units: string, amount: string, dc = 5, dr = 0, dp = 0, size: [string, string] | null = null): VariantSalesRow => ({
  variant_id: id, product_id: product, product_name: product.toUpperCase(), category_id: cat, category_name: cat, sku: id, size_value: size?.[0] ?? null, size_unit: size?.[1] ?? null,
  base_unit: unit, units_sold: units, estimated_amount: amount, days_calculated: dc, days_review: dr, days_pending: dp,
});

const rows: VariantSalesRow[] = [
  v("a1", "chilli", "spices", "packet", "100", "15000.00", 5, 0, 0, ["100", "g"]),
  v("a2", "chilli", "spices", "packet", "40", "14000.00", 5, 1, 0, ["250", "g"]),
  v("b1", "oil", "oils", "bottle", "30", "9000.00"),
  v("c1", "salt", null, "packet", "200", "4000.00"),
  v("d1", "pepper", "spices", "packet", "0", "0.00", 5),
  v("e1", "tea", "spices", "packet", "3", "300.00", 2), // too few days to judge as slow
];

describe("aggregateProducts", () => {
  it("combines sizes of one product, adding money and keeping units per unit", () => {
    const p = aggregateProducts(rows);
    expect(p[0]).toMatchObject({ name: "CHILLI", variants: 2, amount: "29000.00", units: { packet: "140" }, daysReview: 1 });
    expect(p.map((x) => x.name)).toEqual(["CHILLI", "OIL", "SALT", "TEA", "PEPPER"]);
  });
  it("never adds packets to bottles", () => {
    const merged = aggregateProducts([v("x1", "mix", null, "packet", "10", "100.00"), v("x2", "mix", null, "bottle", "7", "70.00")])[0];
    expect(merged.units).toEqual({ packet: "10", bottle: "7" });
    expect(merged.amount).toBe("170.00");
  });
});

describe("aggregateCategories", () => {
  const c = aggregateCategories(rows);
  it("ranks by money with each category's share, and groups uncategorised products together", () => {
    expect(c.map((x) => [x.name, x.amount, x.sharePct])).toEqual([["spices", "29300.00", 69.3], ["oils", "9000.00", 21.3], [null, "4000.00", 9.5]]);
    expect(c[0]).toMatchObject({ products: 3, variants: 4, units: { packet: "143" } });
  });
  it("shares add up to ~100 and an empty set has no NaN", () => {
    expect(c.reduce((n, x) => n + x.sharePct, 0)).toBeGreaterThan(99.9);
    expect(aggregateCategories([])).toEqual([]);
    expect(aggregateCategories([v("z", "zero", "c", "packet", "0", "0.00")])[0].sharePct).toBe(0);
  });
});

describe("topSellers / slowMovers", () => {
  it("best sellers are ranked by Estimated Sales and exclude products that sold nothing", () => {
    expect(topSellers(rows, 3).map((r) => r.variant_id)).toEqual(["a1", "a2", "b1"]);
    expect(topSellers(rows, 10).some((r) => r.variant_id === "d1")).toBe(false);
  });
  it("slow movers: lowest first (zero sales included), and products with too few calculated days are not judged", () => {
    expect(slowMovers(rows, 3).map((r) => r.variant_id)).toEqual(["d1", "c1", "b1"]);
    expect(slowMovers(rows, 10).some((r) => r.variant_id === "e1")).toBe(false);
    expect(slowMovers(rows, 10, 1).some((r) => r.variant_id === "e1")).toBe(true);
  });
});

const dr = (date: string, units: string, amount: string, c = 1, r = 0, p = 0, unit = "packet"): DaySummaryRow => ({ sales_date: date, base_unit: unit, units_sold: units, estimated_amount: amount, calculated_count: c, needs_review_count: r, pending_count: p });

describe("buildSeries (daily / weekly / monthly)", () => {
  // 2026-11-02 is a Monday
  const byDate = aggregateDays([dr("2026-10-30", "5", "50.00"), dr("2026-11-01", "10", "100.00"), dr("2026-11-02", "20", "200.00"), dr("2026-11-03", "30", "300.00", 2, 1, 0), dr("2026-11-05", "0", "0", 0, 0, 4), dr("2026-11-09", "7", "70.00")]);
  it("weeks start on Monday", () => {
    expect(weekStart("2026-11-02")).toBe("2026-11-02");
    expect(weekStart("2026-11-08")).toBe("2026-11-02");
    expect(weekStart("2026-11-01")).toBe("2026-10-26");
  });
  it("daily: one bucket per day; days with no data have no amount", () => {
    const s = buildSeries(byDate, "2026-11-01", "2026-11-05", "day");
    expect(s.map((p) => [p.key, p.amount, p.status])).toEqual([["2026-11-01", 100, "calculated"], ["2026-11-02", 200, "calculated"], ["2026-11-03", 300, "partial"], ["2026-11-04", null, "none"], ["2026-11-05", null, "pending"]]);
  });
  it("weekly: sums the days of each Monday-Sunday week inside the range, partial weeks included", () => {
    const s = buildSeries(byDate, "2026-10-26", "2026-11-09", "week");
    expect(s.map((p) => [p.key, p.amount])).toEqual([["2026-10-26", 150], ["2026-11-02", 500], ["2026-11-09", 70]]);
    expect(s[1]).toMatchObject({ status: "partial", needsReview: 1, pending: 4, units: { packet: "50" } });
  });
  it("monthly: buckets by calendar month", () => {
    expect(buildSeries(byDate, "2026-10-01", "2026-11-30", "month").map((p) => [p.key, p.amount])).toEqual([["2026-10-01", 50], ["2026-11-01", 670]]);
  });
  it("a bucket with nothing calculated is null, not zero", () => {
    expect(buildSeries(byDate, "2026-11-15", "2026-11-17", "week")[0]).toMatchObject({ amount: null, status: "none" });
  });
  it("coverage reports how much of the range has figures", () => {
    expect(coverage(byDate, "2026-11-01", "2026-11-05")).toEqual({ days: 5, withFigures: 3, partial: 1, reviewOnly: 0, pendingOnly: 1, none: 1 });
  });
  it("rangeTotals: money adds, units stay per unit, the best day is found", () => {
    const t = rangeTotals(aggregateDays([dr("2026-11-01", "10", "100.00"), dr("2026-11-01", "4", "40.00", 1, 0, 0, "bottle"), dr("2026-11-02", "3", "300.00")]), "2026-11-01", "2026-11-30");
    expect(t).toEqual({ amount: "440.00", units: { packet: "13", bottle: "4" }, best: { date: "2026-11-02", amount: "300.00" } });
  });
});

describe("compareMonths", () => {
  const full = aggregateDays([dr("2026-09-10", "100", "1000.00"), dr("2026-10-10", "150", "1500.00"), dr("2026-10-20", "50", "500.00"), dr("2026-10-10", "20", "400.00", 1, 0, 0, "bottle")]);
  it("a finished month is compared in full against the month before", () => {
    const c = compareMonths(full, "2026-10", "2026-11-06");
    expect(c).toMatchObject({ month: "2026-10", previous: "2026-09", throughDay: null, amountChangePct: 140 }); // money adds across units: 1500 + 500 + 400 vs 1000
    expect(c.unitChanges).toEqual([{ unit: "bottle", current: "20", prior: "0", changePct: null }, { unit: "packet", current: "200", prior: "100", changePct: 100 }]);
  });
  it("nothing to compare with -> null, never infinity or NaN", () => {
    expect(compareMonths(full, "2026-09", "2026-11-06").amountChangePct).toBeNull();
  });
  it("the month in progress is compared like-for-like over the same days only", () => {
    const d = aggregateDays([dr("2026-10-02", "10", "100.00"), dr("2026-10-25", "99", "9900.00"), dr("2026-11-02", "20", "200.00")]);
    const c = compareMonths(d, "2026-11", "2026-11-06"); // days elapsed: 1st..5th
    expect(c.throughDay).toBe(5);
    expect(c.prior.amount).toBe("100.00");   // Oct 25 is NOT part of the comparison
    expect(c.amountChangePct).toBe(100);
  });
  it("handles a shorter previous month", () => {
    const d = aggregateDays([dr("2026-02-27", "1", "10.00"), dr("2026-03-30", "1", "10.00")]);
    expect(compareMonths(d, "2026-03", "2026-03-31").throughDay).toBe(30);
    expect(compareMonths(d, "2026-03", "2026-03-31").prior.amount).toBe("10.00"); // clamps to Feb's 28 days
  });
});

describe("pickMovementUnit", () => {
  const mv = (unit: string, n: number) => ({ day: "2026-11-01", base_unit: unit, received: "0", returned_in: "0", damaged_out: "0", other_out: "0", adjustments: "0", movement_count: n });
  it("defaults to the busiest unit, honours a valid request, ignores an unknown one", () => {
    const rows = [mv("packet", 5), mv("bottle", 9)];
    expect(pickMovementUnit(rows)).toEqual({ units: ["bottle", "packet"], unit: "bottle" });
    expect(pickMovementUnit(rows, "packet").unit).toBe("packet");
    expect(pickMovementUnit(rows, "carton").unit).toBe("bottle");
    expect(pickMovementUnit([])).toEqual({ units: [], unit: null });
  });
});

import { bucketMovements } from "@/features/analytics/aggregate";
describe("bucketMovements", () => {
  const mv = (day: string, unit: string, o: Partial<{ received: string; returned_in: string; damaged_out: string; other_out: string; adjustments: string }> = {}) =>
    ({ day, base_unit: unit, received: "0", returned_in: "0", damaged_out: "0", other_out: "0", adjustments: "0", movement_count: 1, ...o });
  const rows = [
    mv("2026-11-02", "packet", { received: "100" }),
    mv("2026-11-02", "bottle", { received: "999" }),            // a different unit: must never leak in
    mv("2026-11-03", "packet", { damaged_out: "4", adjustments: "-3" }),
    mv("2026-11-04", "packet", { returned_in: "2", adjustments: "5", other_out: "1" }),
  ];
  it("keeps one unit only; inflow and outflow are separate positive numbers; signed adjustments go to the right side", () => {
    const d = bucketMovements(rows, "packet", "2026-11-02", "2026-11-04", "day");
    expect(d.map((b) => [b.key, b.inflow, b.outflow])).toEqual([["2026-11-02", 100, 0], ["2026-11-03", 0, 7], ["2026-11-04", 7, 1]]);
    expect(d[0].received).toBe(100);
  });
  it("weekly buckets start on Monday and include empty weeks", () => {
    const w = bucketMovements(rows, "packet", "2026-10-26", "2026-11-09", "week");
    expect(w.map((b) => b.key)).toEqual(["2026-10-26", "2026-11-02", "2026-11-09"]);
    expect(w[1]).toMatchObject({ inflow: 107, outflow: 8 });
    expect(w[0]).toMatchObject({ inflow: 0, outflow: 0 });
  });
  it("ignores movements outside the range and handles no unit", () => {
    expect(bucketMovements(rows, "packet", "2026-11-03", "2026-11-03", "day")).toHaveLength(1);
    expect(bucketMovements(rows, null, "2026-11-02", "2026-11-02", "day")[0]).toMatchObject({ inflow: 0, outflow: 0 });
  });
});
