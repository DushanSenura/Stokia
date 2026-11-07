import { describe, expect, it } from "vitest";
import {
  aggregateDays, buildAlerts, buildDailySeries, buildMonthlySeries, dayStatus, monthStatus, monthTotals, pendingCountDays, unitList, yesterdayKpi,
  type AlertInput, type DaySummaryRow,
} from "@/features/dashboard/summary";
import { addMonths, daysInMonth, formatMonth, isMonth, lastOfMonth } from "@/lib/dates/business";

const row = (date: string, unit: string, units: string, amount: string, c = 1, r = 0, p = 0): DaySummaryRow =>
  ({ sales_date: date, base_unit: unit, units_sold: units, estimated_amount: amount, calculated_count: c, needs_review_count: r, pending_count: p });

describe("month helpers", () => {
  it("handles year boundaries, leap years and validation", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2027-01", -1)).toBe("2026-12");
    expect(addMonths("2026-11", -11)).toBe("2025-12");
    expect(lastOfMonth("2028-02")).toBe("2028-02-29");
    expect(daysInMonth("2026-11")).toBe(30);
    expect([isMonth("2026-11"), isMonth("2026-13"), isMonth("2026-1"), isMonth(5)]).toEqual([true, false, false, false]);
    expect(formatMonth("2026-11")).toBe("November 2026");
  });
});

describe("aggregateDays: money adds up, quantities do not mix", () => {
  const days = aggregateDays([row("2026-11-01", "packet", "28", "4200.00"), row("2026-11-01", "bottle", "6", "1800.00"), row("2026-11-01", "packet", "10", "2000.00", 2, 1, 3)]);
  it("sums amount across units but keeps units separate", () => {
    expect(days.get("2026-11-01")).toMatchObject({ amount: "8000.00", units: { packet: "38", bottle: "6" }, calculated: 4, needsReview: 1, pending: 3 });
  });
  it("is decimal-exact", () => {
    expect(aggregateDays([row("2026-11-01", "kg", "0.1", "0.10"), row("2026-11-01", "kg", "0.2", "0.20")]).get("2026-11-01")).toMatchObject({ amount: "0.30", units: { kg: "0.3" } });
  });
});

describe("dayStatus", () => {
  const s = (c: number, r: number, p: number) => aggregateDays([row("2026-11-01", "packet", c ? "5" : "0", c ? "50.00" : "0", c, r, p)]).get("2026-11-01");
  it("classifies days", () => {
    expect([dayStatus(undefined), dayStatus(s(3, 0, 0)), dayStatus(s(3, 1, 0)), dayStatus(s(3, 0, 2)), dayStatus(s(0, 2, 0)), dayStatus(s(0, 0, 4))]).toEqual(["none", "calculated", "partial", "partial", "review", "pending"]);
  });
});

describe("buildDailySeries", () => {
  const byDate = aggregateDays([row("2026-11-01", "packet", "28", "4200.00"), row("2026-11-02", "packet", "0", "0", 0, 0, 5), row("2026-11-03", "packet", "0", "0", 0, 2, 0)]);
  const series = buildDailySeries("2026-11", byDate, new Map([["2026-11-02", "sess-2"], ["2026-11-03", "sess-3"]]));
  it("has one point per day; pending/review/none have NO amount (never a zero bar)", () => {
    expect(series).toHaveLength(30);
    expect(series[0]).toMatchObject({ date: "2026-11-01", status: "calculated", amount: 4200, detailSessionId: "sess-2" });
    expect(series[1]).toMatchObject({ status: "pending", amount: null, detailSessionId: "sess-3" });
    expect(series[2]).toMatchObject({ status: "review", amount: null });
    expect(series[3]).toMatchObject({ status: "none", amount: null, detailSessionId: null });
  });
});

describe("month status (Test G: month boundary)", () => {
  it("November stays pending until the Dec 1 count is confirmed", () => {
    expect(monthStatus("2026-11", "2026-12-05", new Set())).toEqual({ status: "pending", waitingFor: "2026-12-01" });
    expect(monthStatus("2026-11", "2026-12-05", new Set(["2026-12-01"]))).toEqual({ status: "complete", waitingFor: null });
  });
  it("the current month is in progress", () => {
    expect(monthStatus("2026-11", "2026-11-20", new Set(["2026-12-01"]))).toEqual({ status: "in_progress", waitingFor: null });
  });
  it("monthly series flags each month and uses decimal totals", () => {
    const byDate = aggregateDays([row("2026-10-31", "packet", "10", "1500.00"), row("2026-11-01", "packet", "28", "4200.00"), row("2026-11-02", "packet", "5", "750.00")]);
    const m = buildMonthlySeries(byDate, "2026-11", 3, "2026-11-06", new Set(["2026-11-01"]));
    expect(m.map((x) => x.month)).toEqual(["2026-09", "2026-10", "2026-11"]);
    // Sept's closing count (Oct 1) is not confirmed -> pending; Oct's (Nov 1) is -> complete; Nov is current
    expect(m.map((x) => x.status)).toEqual(["pending", "complete", "in_progress"]);
    expect(m.map((x) => x.amount)).toEqual([0, 1500, 4950]);
    expect(m.map((x) => x.hasData)).toEqual([false, true, true]);
  });
  it("monthTotals reports how far the total runs", () => {
    const byDate = aggregateDays([row("2026-11-01", "packet", "28", "4200.00"), row("2026-11-04", "bottle", "3", "900.00"), row("2026-11-05", "packet", "0", "0", 0, 0, 2)]);
    expect(monthTotals(byDate, "2026-11")).toMatchObject({ amount: "5100.00", units: { packet: "28", bottle: "3" }, throughDate: "2026-11-04", pending: 2 });
    expect(monthTotals(byDate, "2026-10")).toMatchObject({ amount: "0.00", throughDate: null });
  });
});

describe("yesterdayKpi: pending is pending, never old results", () => {
  const sum = (c: number, r: number, p: number) => aggregateDays([row("2026-11-05", "packet", c ? "28" : "0", c ? "4200.00" : "0", c, r, p)]).get("2026-11-05");
  it("shows the figure once the closing count made it calculated", () => {
    expect(yesterdayKpi(sum(5, 0, 0), true)).toMatchObject({ kind: "value", amount: "4200.00", units: { packet: "28" } });
  });
  it("partial days still show the figure, with the counts of what is missing", () => {
    expect(yesterdayKpi(sum(5, 1, 2), true)).toMatchObject({ kind: "value", needsReview: 1, pending: 2 });
  });
  it("this morning's count not entered -> pending (awaiting), NOT the previous day's number", () => {
    expect(yesterdayKpi(sum(0, 0, 8), false)).toEqual({ kind: "pending", reason: "awaiting_next_count" });
  });
  it("count entered but the day cannot be worked out -> pending with a different reason", () => {
    expect(yesterdayKpi(sum(0, 0, 8), true)).toEqual({ kind: "pending", reason: "missing_count" });
  });
  it("only needs-review rows -> review; nothing at all -> none", () => {
    expect(yesterdayKpi(sum(0, 3, 0), true)).toEqual({ kind: "review", needsReview: 3 });
    expect(yesterdayKpi(undefined, false)).toEqual({ kind: "none" });
  });
});

describe("pendingCountDays", () => {
  it("counts the mornings still owed", () => {
    expect(pendingCountDays(null, "2026-11-06")).toBe(1);
    expect(pendingCountDays("2026-11-06", "2026-11-06")).toBe(0);
    expect(pendingCountDays("2026-11-05", "2026-11-06")).toBe(1);
    expect(pendingCountDays("2026-11-03", "2026-11-06")).toBe(3);
  });
});

describe("unitList", () => {
  it("orders by quantity descending and never merges units", () => {
    expect(unitList({ bottle: "6", packet: "38" })).toEqual([{ unit: "packet", qty: "38" }, { unit: "bottle", qty: "6" }]);
  });
});

describe("buildAlerts", () => {
  const base: AlertInput = { today: "2026-11-06", todayCount: "confirmed", latestConfirmed: "2026-11-06", needsReviewCount: 0, needsReviewHref: null, lowStockCount: 0, report: null };
  it("is quiet when everything is up to date", () => expect(buildAlerts(base)).toEqual([]));
  it("asks for today's count, or to finish the draft", () => {
    expect(buildAlerts({ ...base, todayCount: "none", latestConfirmed: "2026-11-05" }).map((a) => a.id)).toEqual(["count_pending"]);
    expect(buildAlerts({ ...base, todayCount: "draft", latestConfirmed: "2026-11-05" }).map((a) => a.id)).toEqual(["count_draft"]);
  });
  it("warns about skipped mornings (not the normal one-day gap)", () => {
    const a = buildAlerts({ ...base, todayCount: "none", latestConfirmed: "2026-11-03" });
    expect(a.find((x) => x.id === "counts_skipped")).toMatchObject({ params: { days: 2 } });
  });
  it("surfaces review items, low stock and a pending monthly report", () => {
    const a = buildAlerts({ ...base, needsReviewCount: 3, needsReviewHref: "/stock-history/abc", lowStockCount: 4, report: { month: "2026-10", status: "pending", waitingFor: "2026-11-01" } });
    expect(a.map((x) => x.id)).toEqual(["needs_review", "low_stock", "report_pending"]);
    expect(a[0].href).toBe("/stock-history/abc");
  });
  it("a complete or in-progress report raises nothing", () => {
    expect(buildAlerts({ ...base, report: { month: "2026-10", status: "complete", waitingFor: null } })).toEqual([]);
  });
});
