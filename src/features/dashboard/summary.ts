/**
 * Pure shaping of dashboard data (no React, no database). Keeps the rules that decide what the
 * dashboard may claim in ONE tested place:
 *  - a pending day is shown as pending, never as zero and never replaced by an older result;
 *  - money is summed across products, quantities are only summed within the same base unit;
 *  - a month is "complete" only when the next month's first count has been confirmed.
 */
import Decimal from "decimal.js";
import { addDays, addMonths, daysBetween, daysInMonth, firstOfMonth, lastOfMonth, monthOf } from "@/lib/dates/business";

export interface DaySummaryRow {
  sales_date: string; base_unit: string; units_sold: string; estimated_amount: string;
  calculated_count: number; needs_review_count: number; pending_count: number;
}

export interface DaySummary {
  date: string;
  /** Estimated Sales (2dp string), summed over calculated products. */
  amount: string;
  /** Units sold per base unit (never mixed). */
  units: Record<string, string>;
  calculated: number;
  needsReview: number;
  pending: number;
}

export function aggregateDays(rows: DaySummaryRow[]): Map<string, DaySummary> {
  const out = new Map<string, DaySummary & { _amt: Decimal; _units: Record<string, Decimal> }>();
  for (const r of rows) {
    const d = out.get(r.sales_date) ?? { date: r.sales_date, amount: "0.00", units: {}, calculated: 0, needsReview: 0, pending: 0, _amt: new Decimal(0), _units: {} };
    d._amt = d._amt.plus(r.estimated_amount);
    const u = r.base_unit.toLowerCase();
    if (new Decimal(r.units_sold).gt(0)) d._units[u] = (d._units[u] ?? new Decimal(0)).plus(r.units_sold);
    d.calculated += r.calculated_count; d.needsReview += r.needs_review_count; d.pending += r.pending_count;
    d.amount = d._amt.toFixed(2);
    d.units = Object.fromEntries(Object.entries(d._units).map(([k, v]) => [k, v.toString()]));
    out.set(r.sales_date, d);
  }
  return out;
}

export type DayStatus = "calculated" | "partial" | "review" | "pending" | "none";

export function dayStatus(s: DaySummary | undefined): DayStatus {
  if (!s) return "none";
  if (s.calculated > 0) return s.pending > 0 || s.needsReview > 0 ? "partial" : "calculated";
  if (s.needsReview > 0) return "review";
  if (s.pending > 0) return "pending";
  return "none";
}

export interface DailyPoint {
  date: string; day: number; status: DayStatus;
  /** null when nothing was calculated (pending / none): a missing bar, never a zero bar. */
  amount: number | null;
  units: Record<string, string>; calculated: number; needsReview: number; pending: number;
  /** Count session whose detail page explains this day (the NEXT morning's count). */
  detailSessionId: string | null;
}

export function buildDailySeries(month: string, byDate: Map<string, DaySummary>, sessionByCountDate: Map<string, string>): DailyPoint[] {
  return Array.from({ length: daysInMonth(month) }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, "0")}`;
    const s = byDate.get(date);
    const status = dayStatus(s);
    return {
      date, day: i + 1, status,
      amount: s && (status === "calculated" || status === "partial") ? Number(s.amount) : null,
      units: s?.units ?? {}, calculated: s?.calculated ?? 0, needsReview: s?.needsReview ?? 0, pending: s?.pending ?? 0,
      detailSessionId: sessionByCountDate.get(addDays(date, 1)) ?? null,
    };
  });
}

export type MonthStatus = "complete" | "in_progress" | "pending";

/** The last sales day of a month is calculated by the NEXT month's first count, so the month stays open until it exists. */
export function monthStatus(month: string, today: string, confirmedCountDates: ReadonlySet<string>): { status: MonthStatus; waitingFor: string | null } {
  if (month >= monthOf(today)) return { status: "in_progress", waitingFor: null };
  const closing = firstOfMonth(addMonths(month, 1));
  return confirmedCountDates.has(closing) ? { status: "complete", waitingFor: null } : { status: "pending", waitingFor: closing };
}

export interface MonthTotals {
  amount: string; units: Record<string, string>; calculated: number; needsReview: number; pending: number;
  /** Latest sales date in the month that has a calculated figure (what the total runs through). */
  throughDate: string | null;
}

export function monthTotals(byDate: Map<string, DaySummary>, month: string): MonthTotals {
  let amount = new Decimal(0);
  const units: Record<string, Decimal> = {};
  const t: MonthTotals = { amount: "0.00", units: {}, calculated: 0, needsReview: 0, pending: 0, throughDate: null };
  const from = firstOfMonth(month), to = lastOfMonth(month);
  for (const [date, s] of byDate) {
    if (date < from || date > to) continue;
    amount = amount.plus(s.amount);
    for (const [u, n] of Object.entries(s.units)) units[u] = (units[u] ?? new Decimal(0)).plus(n);
    t.calculated += s.calculated; t.needsReview += s.needsReview; t.pending += s.pending;
    if (s.calculated > 0 && (t.throughDate === null || date > t.throughDate)) t.throughDate = date;
  }
  t.amount = amount.toFixed(2);
  t.units = Object.fromEntries(Object.entries(units).map(([k, v]) => [k, v.toString()]));
  return t;
}

export interface MonthPoint { month: string; amount: number; units: Record<string, string>; status: MonthStatus; waitingFor: string | null; hasData: boolean }

/** `count` months ending at `endMonth`, oldest first. */
export function buildMonthlySeries(byDate: Map<string, DaySummary>, endMonth: string, count: number, today: string, confirmedCountDates: ReadonlySet<string>): MonthPoint[] {
  return Array.from({ length: count }, (_, i) => {
    const month = addMonths(endMonth, i - (count - 1));
    const t = monthTotals(byDate, month);
    return { month, amount: Number(t.amount), units: t.units, hasData: t.calculated > 0, ...monthStatus(month, today, confirmedCountDates) };
  });
}

export type YesterdayKpi =
  | { kind: "value"; amount: string; units: Record<string, string>; needsReview: number; pending: number }
  | { kind: "pending"; reason: "awaiting_next_count" | "missing_count" }
  | { kind: "review"; needsReview: number }
  | { kind: "none" };

/**
 * What the "Yesterday" tiles may show. If the closing count has not been entered, the day is PENDING:
 * we never present an older day's figure as if it were current.
 */
export function yesterdayKpi(s: DaySummary | undefined, closingCountConfirmed: boolean): YesterdayKpi {
  const st = dayStatus(s);
  if (st === "calculated" || st === "partial") return { kind: "value", amount: s!.amount, units: s!.units, needsReview: s!.needsReview, pending: s!.pending };
  if (st === "review") return { kind: "review", needsReview: s!.needsReview };
  if (st === "pending") return { kind: "pending", reason: closingCountConfirmed ? "missing_count" : "awaiting_next_count" };
  return { kind: "none" };
}

/** Morning counts still owed: today's, plus any skipped mornings since the last confirmed count. 0 once today is confirmed. */
export function pendingCountDays(latestConfirmed: string | null, today: string): number {
  if (latestConfirmed === null) return 1;
  return Math.max(0, daysBetween(latestConfirmed, today));
}

export const unitList = (units: Record<string, string>) =>
  Object.entries(units).map(([unit, qty]) => ({ unit, qty })).sort((a, b) => new Decimal(b.qty).comparedTo(a.qty) || a.unit.localeCompare(b.unit));

// ---------- alerts (notifications) ----------
export type AlertId = "count_pending" | "count_draft" | "counts_skipped" | "needs_review" | "low_stock" | "report_pending";
export interface DashAlert { id: AlertId; severity: "warning" | "info"; href: string; params: Record<string, string | number> }

export interface AlertInput {
  today: string;
  todayCount: "none" | "draft" | "confirmed";
  latestConfirmed: string | null;
  needsReviewCount: number;
  needsReviewHref: string | null;
  lowStockCount: number;
  report: { month: string; status: MonthStatus; waitingFor: string | null } | null;
}

export function buildAlerts(i: AlertInput): DashAlert[] {
  const out: DashAlert[] = [];
  if (i.todayCount === "draft") out.push({ id: "count_draft", severity: "warning", href: "/morning-stock", params: { date: i.today } });
  else if (i.todayCount === "none") out.push({ id: "count_pending", severity: "warning", href: "/morning-stock", params: { date: i.today } });
  if (i.latestConfirmed !== null) {
    const skipped = daysBetween(i.latestConfirmed, i.today) - 1;
    if (skipped > 0) out.push({ id: "counts_skipped", severity: "warning", href: "/stock-history", params: { days: skipped, date: i.latestConfirmed } });
  }
  if (i.needsReviewCount > 0) out.push({ id: "needs_review", severity: "warning", href: i.needsReviewHref ?? "/stock-history", params: { count: i.needsReviewCount } });
  if (i.lowStockCount > 0) out.push({ id: "low_stock", severity: "info", href: "/dashboard#low-stock", params: { count: i.lowStockCount } });
  if (i.report && i.report.status === "pending") out.push({ id: "report_pending", severity: "info", href: "/reports", params: { month: i.report.month, date: i.report.waitingFor ?? "" } });
  return out;
}
