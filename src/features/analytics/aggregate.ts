/**
 * Pure analytics shaping (no React, no database).
 * Rules carried everywhere in this file:
 *  - money (Estimated Sales) is additive across products;
 *  - QUANTITIES ARE NEVER SUMMED ACROSS BASE UNITS: every quantity total is a record keyed by unit;
 *  - a day/week/month with nothing calculated has NO amount (null), never a zero that looks like "no sales".
 */
import Decimal from "decimal.js";
import { dayStatus, type DayStatus, type DaySummary } from "@/features/dashboard/summary";
import { addDays, addMonths, daysBetween, firstOfMonth, lastOfMonth, monthOf } from "@/lib/dates/business";
import { sizeLabel } from "@/lib/formatting/units";

export interface VariantSalesRow {
  variant_id: string; product_id: string; product_name: string; category_id: string | null; category_name: string | null;
  sku: string; size_value: string | null; size_unit: string | null; base_unit: string;
  units_sold: string; estimated_amount: string;
  days_calculated: number; days_review: number; days_pending: number;
}

export type UnitTotals = Record<string, string>;

const addUnit = (acc: Record<string, Decimal>, unit: string, qty: Decimal.Value) => {
  const k = unit.toLowerCase();
  if (new Decimal(qty).gt(0)) acc[k] = (acc[k] ?? new Decimal(0)).plus(qty);
};
const finish = (acc: Record<string, Decimal>): UnitTotals => Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v.toString()]));

export interface ProductAgg {
  productId: string; name: string; categoryName: string | null; variants: number;
  units: UnitTotals; amount: string; daysReview: number; daysPending: number;
}

export function aggregateProducts(rows: VariantSalesRow[]): ProductAgg[] {
  const m = new Map<string, { agg: ProductAgg; amt: Decimal; units: Record<string, Decimal> }>();
  for (const r of rows) {
    const e = m.get(r.product_id) ?? { agg: { productId: r.product_id, name: r.product_name, categoryName: r.category_name, variants: 0, units: {}, amount: "0.00", daysReview: 0, daysPending: 0 }, amt: new Decimal(0), units: {} };
    e.agg.variants++; e.agg.daysReview += r.days_review; e.agg.daysPending += r.days_pending;
    e.amt = e.amt.plus(r.estimated_amount);
    addUnit(e.units, r.base_unit, r.units_sold);
    m.set(r.product_id, e);
  }
  return [...m.values()]
    .map((e) => ({ ...e.agg, amount: e.amt.toFixed(2), units: finish(e.units) }))
    .sort((a, b) => new Decimal(b.amount).comparedTo(a.amount) || a.name.localeCompare(b.name));
}

export interface CategoryAgg {
  categoryId: string | null; name: string | null; products: number; variants: number; units: UnitTotals; amount: string;
  /** Share of the total Estimated Sales (0-100), by money, which is the only thing comparable across units. */
  sharePct: number;
}

export function aggregateCategories(rows: VariantSalesRow[]): CategoryAgg[] {
  const m = new Map<string, { id: string | null; name: string | null; products: Set<string>; variants: number; amt: Decimal; units: Record<string, Decimal> }>();
  let total = new Decimal(0);
  for (const r of rows) {
    const key = r.category_id ?? "__none";
    const e = m.get(key) ?? { id: r.category_id, name: r.category_name, products: new Set<string>(), variants: 0, amt: new Decimal(0), units: {} };
    e.products.add(r.product_id); e.variants++;
    e.amt = e.amt.plus(r.estimated_amount); total = total.plus(r.estimated_amount);
    addUnit(e.units, r.base_unit, r.units_sold);
    m.set(key, e);
  }
  return [...m.values()]
    .map((e): CategoryAgg => ({ categoryId: e.id, name: e.name, products: e.products.size, variants: e.variants, units: finish(e.units), amount: e.amt.toFixed(2), sharePct: total.gt(0) ? e.amt.dividedBy(total).times(100).toDecimalPlaces(1).toNumber() : 0 }))
    .sort((a, b) => new Decimal(b.amount).comparedTo(a.amount) || (a.name ?? "~").localeCompare(b.name ?? "~"));
}

export const variantLabel = (r: Pick<VariantSalesRow, "product_name" | "size_value" | "size_unit">) => `${r.product_name} ${sizeLabel(r.size_value, r.size_unit)}`.trim();

/** Best sellers: ranked by Estimated Sales (the only comparable measure across units), then units. */
export function topSellers(rows: VariantSalesRow[], n: number): VariantSalesRow[] {
  return rows.filter((r) => new Decimal(r.units_sold).gt(0)).sort((a, b) => new Decimal(b.estimated_amount).comparedTo(a.estimated_amount) || new Decimal(b.units_sold).comparedTo(a.units_sold) || a.sku.localeCompare(b.sku)).slice(0, n);
}

/**
 * Slow movers: active products with enough calculated days to judge (default 3), lowest sales first.
 * Zero-sales products are the slowest of all, so they are included (and listed first).
 */
export function slowMovers(rows: VariantSalesRow[], n: number, minDays = 3): VariantSalesRow[] {
  return rows.filter((r) => r.days_calculated >= minDays)
    .sort((a, b) => new Decimal(a.estimated_amount).comparedTo(b.estimated_amount) || new Decimal(a.units_sold).comparedTo(b.units_sold) || a.sku.localeCompare(b.sku))
    .slice(0, n);
}

/* ---------- time series ---------- */

export type Granularity = "day" | "week" | "month";

/** Monday of the week containing `date` (weeks run Monday to Sunday). */
export function weekStart(date: string): string {
  const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  return addDays(date, -dow);
}

export interface SeriesPoint {
  /** First day of the bucket (the day itself, the Monday, or the 1st of the month). */
  key: string;
  /** Last day of the bucket that is inside the requested range. */
  end: string;
  status: DayStatus;
  amount: number | null;
  units: UnitTotals;
  calculated: number; needsReview: number; pending: number;
}

function merge(days: DaySummary[]): DaySummary {
  let amt = new Decimal(0);
  const units: Record<string, Decimal> = {};
  const out: DaySummary = { date: days[0]?.date ?? "", amount: "0.00", units: {}, calculated: 0, needsReview: 0, pending: 0 };
  for (const d of days) {
    amt = amt.plus(d.amount);
    for (const [u, n] of Object.entries(d.units)) addUnit(units, u, n);
    out.calculated += d.calculated; out.needsReview += d.needsReview; out.pending += d.pending;
  }
  out.amount = amt.toFixed(2);
  out.units = finish(units);
  return out;
}

/** Buckets the days of [from, to] by day / week / month. Buckets with no calculated figure carry amount = null. */
export function buildSeries(byDate: Map<string, DaySummary>, from: string, to: string, g: Granularity): SeriesPoint[] {
  const buckets = new Map<string, { end: string; days: DaySummary[] }>();
  for (let d = from, guard = 0; d <= to && guard < 800; d = addDays(d, 1), guard++) {
    const key = g === "day" ? d : g === "week" ? weekStart(d) : firstOfMonth(monthOf(d));
    const b = buckets.get(key) ?? { end: d, days: [] };
    b.end = d;
    const s = byDate.get(d);
    if (s) b.days.push(s);
    buckets.set(key, b);
  }
  return [...buckets.entries()].map(([key, b]) => {
    const s = merge(b.days);
    const status = dayStatus(b.days.length ? s : undefined);
    return { key, end: b.end, status, amount: status === "calculated" || status === "partial" ? Number(s.amount) : null, units: s.units, calculated: s.calculated, needsReview: s.needsReview, pending: s.pending };
  });
}

export interface Coverage { days: number; withFigures: number; partial: number; reviewOnly: number; pendingOnly: number; none: number }

/** How much of the range actually has numbers (so a total is never mistaken for the whole period). */
export function coverage(byDate: Map<string, DaySummary>, from: string, to: string): Coverage {
  const c: Coverage = { days: 0, withFigures: 0, partial: 0, reviewOnly: 0, pendingOnly: 0, none: 0 };
  for (let d = from, guard = 0; d <= to && guard < 800; d = addDays(d, 1), guard++) {
    c.days++;
    const st = dayStatus(byDate.get(d));
    if (st === "calculated") c.withFigures++;
    else if (st === "partial") { c.withFigures++; c.partial++; }
    else if (st === "review") c.reviewOnly++;
    else if (st === "pending") c.pendingOnly++;
    else c.none++;
  }
  return c;
}

export function rangeTotals(byDate: Map<string, DaySummary>, from: string, to: string): { amount: string; units: UnitTotals; best: { date: string; amount: string } | null } {
  let amt = new Decimal(0);
  const units: Record<string, Decimal> = {};
  let best: { date: string; amount: string } | null = null;
  for (const [date, s] of byDate) {
    if (date < from || date > to) continue;
    amt = amt.plus(s.amount);
    for (const [u, n] of Object.entries(s.units)) addUnit(units, u, n);
    if (s.calculated > 0 && (best === null || new Decimal(s.amount).gt(best.amount))) best = { date, amount: s.amount };
  }
  return { amount: amt.toFixed(2), units: finish(units), best };
}

/* ---------- month over month ---------- */

export interface MonthCompare {
  month: string; previous: string;
  /** Set when the current month is still in progress: both sides are limited to the same days, so the comparison is fair. */
  throughDay: number | null;
  current: { amount: string; units: UnitTotals };
  prior: { amount: string; units: UnitTotals };
  /** Percent change of Estimated Sales; null when the prior period had nothing to compare with. */
  amountChangePct: number | null;
  unitChanges: { unit: string; current: string; prior: string; changePct: number | null }[];
}

const pct = (cur: Decimal.Value, prev: Decimal.Value): number | null => {
  const p = new Decimal(prev);
  return p.gt(0) ? new Decimal(cur).minus(p).dividedBy(p).times(100).toDecimalPlaces(1).toNumber() : null;
};

/** Compares `month` with the month before it. If `month` is the current one, only the days elapsed so far are compared (like for like). */
export function compareMonths(byDate: Map<string, DaySummary>, month: string, today: string): MonthCompare {
  const previous = addMonths(month, -1);
  const open = month >= monthOf(today);
  const lastDay = open ? Math.max(1, daysBetween(firstOfMonth(month), today)) : null; // days with a possible figure: up to yesterday
  const curTo = lastDay ? addDays(firstOfMonth(month), lastDay - 1) : lastOfMonth(month);
  const preTo = lastDay ? addDays(firstOfMonth(previous), Math.min(lastDay, Number(lastOfMonth(previous).slice(8))) - 1) : lastOfMonth(previous);
  const cur = rangeTotals(byDate, firstOfMonth(month), curTo);
  const pre = rangeTotals(byDate, firstOfMonth(previous), preTo);
  const units = [...new Set([...Object.keys(cur.units), ...Object.keys(pre.units)])].sort();
  return {
    month, previous, throughDay: lastDay,
    current: { amount: cur.amount, units: cur.units }, prior: { amount: pre.amount, units: pre.units },
    amountChangePct: pct(cur.amount, pre.amount),
    unitChanges: units.map((unit) => ({ unit, current: cur.units[unit] ?? "0", prior: pre.units[unit] ?? "0", changePct: pct(cur.units[unit] ?? 0, pre.units[unit] ?? 0) })),
  };
}

/* ---------- movement trend ---------- */

export interface MovementTrendRow { day: string; base_unit: string; received: string; returned_in: string; damaged_out: string; other_out: string; adjustments: string; movement_count: number }

/** Movement quantities exist per base unit only; pick the unit the user asked for, else the one with the most movements. */
export function pickMovementUnit(rows: MovementTrendRow[], wanted?: string): { units: string[]; unit: string | null } {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.base_unit, (counts.get(r.base_unit) ?? 0) + r.movement_count);
  const units = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([u]) => u);
  const unit = wanted && units.includes(wanted) ? wanted : (units[0] ?? null);
  return { units, unit };
}

export interface MovementBucket {
  key: string;
  /** Stock added (receipts, customer returns, positive adjustments). */
  inflow: number;
  /** Stock removed (damaged/expired/discarded, supplier returns, negative adjustments). A positive number. */
  outflow: number;
  received: number; returned: number; damaged: number; otherOut: number; adjustments: number;
}

/**
 * Buckets one unit's movements by day / week / month. Quantities of other units are never mixed in. Inflow and outflow
 * are worked out per DAY (a day's adjustments net within that day) and then summed, so a week never hides an offsetting
 * correction on a different day.
 */
export function bucketMovements(rows: MovementTrendRow[], unit: string | null, from: string, to: string, g: Granularity): MovementBucket[] {
  type Acc = Record<"inflow" | "outflow" | "received" | "returned" | "damaged" | "otherOut" | "adjustments", Decimal>;
  const zero = (): Acc => ({ inflow: new Decimal(0), outflow: new Decimal(0), received: new Decimal(0), returned: new Decimal(0), damaged: new Decimal(0), otherOut: new Decimal(0), adjustments: new Decimal(0) });
  const buckets = new Map<string, Acc>();
  const keyOf = (d: string) => (g === "day" ? d : g === "week" ? weekStart(d) : firstOfMonth(monthOf(d)));
  for (let d = from, guard = 0; d <= to && guard < 800; d = addDays(d, 1), guard++) if (!buckets.has(keyOf(d))) buckets.set(keyOf(d), zero());
  for (const r of rows) {
    if (unit === null || r.base_unit.toLowerCase() !== unit.toLowerCase()) continue;
    const b = buckets.get(keyOf(r.day));
    if (!b) continue;
    const adj = new Decimal(r.adjustments);
    b.received = b.received.plus(r.received); b.returned = b.returned.plus(r.returned_in); b.damaged = b.damaged.plus(r.damaged_out);
    b.otherOut = b.otherOut.plus(r.other_out); b.adjustments = b.adjustments.plus(adj);
    b.inflow = b.inflow.plus(r.received).plus(r.returned_in).plus(Decimal.max(adj, 0));
    b.outflow = b.outflow.plus(r.damaged_out).plus(r.other_out).plus(Decimal.max(adj.negated(), 0));
  }
  return [...buckets.entries()].map(([key, b]) => ({
    key, inflow: b.inflow.toNumber(), outflow: b.outflow.toNumber(),
    received: b.received.toNumber(), returned: b.returned.toNumber(), damaged: b.damaged.toNumber(), otherOut: b.otherOut.toNumber(), adjustments: b.adjustments.toNumber(),
  }));
}
