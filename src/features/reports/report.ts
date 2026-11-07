/**
 * Monthly report model (pure). One structure feeds the on-screen report, the print view and the PDF / Excel / CSV exports,
 * so every output shows the same numbers.
 *
 * Definitions (see supabase/migrations/..._analytics_and_reports.sql):
 *  - opening stock = the count on the 1st; closing stock = the count on the 1st of the NEXT month. Stock is never summed over mornings.
 *  - A month is COMPLETE only once that closing count is confirmed; until then it is in progress (current month) or pending.
 *  - "Estimated Sales" are units inferred from stock counts x the selling price on each sales date. They are not cash received.
 *  - Quantities are totalled per base unit only; money is the only figure added across products.
 */
import Decimal from "decimal.js";
import { aggregateCategories, aggregateProducts, buildSeries, type CategoryAgg, type ProductAgg, type SeriesPoint, type VariantSalesRow } from "@/features/analytics/aggregate";
import { aggregateDays, type DaySummaryRow, type MonthStatus } from "@/features/dashboard/summary";
import { addMonths, firstOfMonth, lastOfMonth, monthOf } from "@/lib/dates/business";
import { sizeLabel } from "@/lib/formatting/units";

export interface ReportVariantRow {
  variant_id: string; product_id: string; product_name: string; product_code: string; category_id: string | null; category_name: string | null;
  sku: string; size_value: string | null; size_unit: string | null; base_unit: string; is_active: boolean;
  opening: string | null; closing: string | null;
  received: string; returned_in: string; damaged_out: string; other_out: string; adjustments: string;
  units_sold: string; estimated_amount: string;
  days_calculated: number; days_review: number; days_pending: number; max_revision: number;
  closing_cost: string | null; closing_value: string | null;
}

export interface ReportVariant {
  variantId: string; productId: string; productName: string; productCode: string; categoryName: string | null; sku: string; size: string; unit: string; isActive: boolean;
  opening: string | null; received: string; returnedIn: string; damagedOut: string; otherOut: string; adjustments: string; closing: string | null;
  unitsSold: string; estimatedAmount: string; closingCost: string | null; closingValue: string | null;
  daysCalculated: number; daysReview: number; daysPending: number;
  /** opening + movements - closing - units sold. Zero when every day was calculated; the quantity sitting in uncalculated days otherwise. null if a count is missing. */
  unreconciled: string | null;
  flags: { missingOpening: boolean; missingClosing: boolean; review: boolean; pendingDays: boolean; uncosted: boolean };
}

export interface StockUnitSummary {
  unit: string; variants: number;
  opening: string; received: string; returnedIn: string; damagedOut: string; otherOut: string; adjustments: string; closing: string;
  unitsSold: string; unreconciled: string;
  /** Products left out of the opening / closing totals because they were not counted. */
  withoutOpening: number; withoutClosing: number;
}

export type ReportNoteCode =
  | "in_progress" | "waiting_closing_count" | "recalculated" | "days_review" | "days_pending"
  | "without_opening" | "without_closing" | "uncosted";
export interface ReportNote { code: ReportNoteCode; params: Record<string, string | number> }

export type ExportFormat = "pdf" | "xlsx" | "csv" | "print";
export interface ExportRecord { format: ExportFormat; exported_at: string; fingerprint: string }

/** One month in the report list: status and flags, without the per-month detail. */
export interface ReportIndexRow {
  month: string; estimatedSales: string | null; daysCalculated: number; daysReview: number;
  status: "in_progress" | "pending" | "complete"; waitingFor: string | null; recalculated: boolean;
  lastExport: { format: ExportFormat; at: string } | null;
}

export interface MonthlyReport {
  month: string; shopName: string; timezone: string; currency: "LKR";
  period: { from: string; to: string }; openingCountDate: string; closingCountDate: string;
  status: { kind: MonthStatus; waitingFor: string | null };
  /** Some day of this month was recalculated after its first calculation (a late movement or a corrected count). */
  recalculated: boolean;
  /** The latest export; `stale` = the figures changed after it was made. */
  lastExport: { format: ExportFormat; at: string; stale: boolean } | null;
  fingerprint: string;
  generatedAt: string;
  totals: { estimatedSales: string; closingValue: string; uncostedVariants: number; variantsWithGaps: number; daysCalculated: number; daysReview: number; daysPending: number };
  stock: StockUnitSummary[];
  variants: ReportVariant[];
  products: ProductAgg[];
  categories: CategoryAgg[];
  daily: SeriesPoint[];
  lowStock: { name: string; size: string; sku: string; unit: string; quantity: string; threshold: string }[];
  notes: ReportNote[];
}

const D = (v: Decimal.Value | null | undefined) => new Decimal(v ?? 0);
const s = (d: Decimal) => d.toString();

export interface BuildInput {
  month: string; today: string; shopName: string; timezone: string; generatedAt: string;
  rows: ReportVariantRow[];
  daily: DaySummaryRow[];
  hasClosingCount: boolean;
  fingerprint: string;
  exports: ExportRecord[];
  lowStock: MonthlyReport["lowStock"];
}

export function reportStatus(month: string, today: string, hasClosingCount: boolean): MonthlyReport["status"] {
  if (month >= monthOf(today)) return { kind: "in_progress", waitingFor: null };
  return hasClosingCount ? { kind: "complete", waitingFor: null } : { kind: "pending", waitingFor: firstOfMonth(addMonths(month, 1)) };
}

export function buildMonthlyReport(i: BuildInput): MonthlyReport {
  const status = reportStatus(i.month, i.today, i.hasClosingCount);
  const closed = status.kind !== "in_progress";

  const variants: ReportVariant[] = i.rows.map((r) => {
    const haveBoth = r.opening !== null && r.closing !== null;
    const unrec = haveBoth ? D(r.opening).plus(r.received).plus(r.returned_in).minus(r.damaged_out).minus(r.other_out).plus(r.adjustments).minus(r.closing!).minus(r.units_sold) : null;
    return {
      variantId: r.variant_id, productId: r.product_id, productName: r.product_name, productCode: r.product_code, categoryName: r.category_name, sku: r.sku,
      size: sizeLabel(r.size_value, r.size_unit), unit: r.base_unit, isActive: r.is_active,
      opening: r.opening === null ? null : s(D(r.opening)), received: s(D(r.received)), returnedIn: s(D(r.returned_in)), damagedOut: s(D(r.damaged_out)),
      otherOut: s(D(r.other_out)), adjustments: s(D(r.adjustments)), closing: r.closing === null ? null : s(D(r.closing)),
      unitsSold: s(D(r.units_sold)), estimatedAmount: D(r.estimated_amount).toFixed(2),
      closingCost: r.closing_cost === null ? null : D(r.closing_cost).toFixed(2), closingValue: r.closing_value === null ? null : D(r.closing_value).toFixed(2),
      daysCalculated: r.days_calculated, daysReview: r.days_review, daysPending: r.days_pending,
      unreconciled: unrec === null ? null : s(unrec),
      flags: {
        missingOpening: r.opening === null && r.is_active, missingClosing: closed && r.closing === null && r.is_active,
        review: r.days_review > 0, pendingDays: closed && r.days_pending > 0,
        uncosted: r.closing !== null && D(r.closing).gt(0) && r.closing_cost === null,
      },
    };
  });

  // ---- stock by base unit: quantities are only added within a unit ----
  const byUnit = new Map<string, { s: StockUnitSummary; acc: Record<string, Decimal> }>();
  const key = (u: string) => u.toLowerCase();
  for (const v of variants) {
    const e = byUnit.get(key(v.unit)) ?? {
      s: { unit: key(v.unit), variants: 0, opening: "0", received: "0", returnedIn: "0", damagedOut: "0", otherOut: "0", adjustments: "0", closing: "0", unitsSold: "0", unreconciled: "0", withoutOpening: 0, withoutClosing: 0 },
      acc: { opening: D(0), received: D(0), returnedIn: D(0), damagedOut: D(0), otherOut: D(0), adjustments: D(0), closing: D(0), unitsSold: D(0), unreconciled: D(0) },
    };
    e.s.variants++;
    if (v.opening === null) e.s.withoutOpening++; else e.acc.opening = e.acc.opening.plus(v.opening);
    if (v.closing === null) e.s.withoutClosing++; else e.acc.closing = e.acc.closing.plus(v.closing);
    e.acc.received = e.acc.received.plus(v.received); e.acc.returnedIn = e.acc.returnedIn.plus(v.returnedIn);
    e.acc.damagedOut = e.acc.damagedOut.plus(v.damagedOut); e.acc.otherOut = e.acc.otherOut.plus(v.otherOut);
    e.acc.adjustments = e.acc.adjustments.plus(v.adjustments); e.acc.unitsSold = e.acc.unitsSold.plus(v.unitsSold);
    if (v.unreconciled !== null) e.acc.unreconciled = e.acc.unreconciled.plus(v.unreconciled);
    byUnit.set(key(v.unit), e);
  }
  const stock = [...byUnit.values()].map(({ s: u, acc }) => ({ ...u, ...Object.fromEntries(Object.entries(acc).map(([k, val]) => [k, s(val)])) } as StockUnitSummary))
    .sort((a, b) => a.unit.localeCompare(b.unit));

  // ---- product / category rollups reuse the analytics aggregation ----
  const asSales: VariantSalesRow[] = i.rows.map((r) => ({
    variant_id: r.variant_id, product_id: r.product_id, product_name: r.product_name, category_id: r.category_id, category_name: r.category_name, sku: r.sku,
    size_value: r.size_value, size_unit: r.size_unit, base_unit: r.base_unit, units_sold: r.units_sold, estimated_amount: r.estimated_amount,
    days_calculated: r.days_calculated, days_review: r.days_review, days_pending: r.days_pending,
  }));

  const estimatedSales = i.rows.reduce((n, r) => n.plus(r.estimated_amount), D(0));
  const closingValue = i.rows.reduce((n, r) => n.plus(r.closing_value ?? 0), D(0));
  const totals = {
    estimatedSales: estimatedSales.toFixed(2), closingValue: closingValue.toFixed(2),
    uncostedVariants: variants.filter((v) => v.flags.uncosted).length,
    variantsWithGaps: variants.filter((v) => v.flags.review || v.flags.pendingDays || v.flags.missingOpening || v.flags.missingClosing).length,
    daysCalculated: i.rows.reduce((n, r) => n + r.days_calculated, 0), daysReview: i.rows.reduce((n, r) => n + r.days_review, 0), daysPending: i.rows.reduce((n, r) => n + r.days_pending, 0),
  };

  const recalculated = i.rows.some((r) => r.max_revision > 1);
  const latest = [...i.exports].sort((a, b) => b.exported_at.localeCompare(a.exported_at))[0];

  const notes: ReportNote[] = [];
  if (status.kind === "in_progress") notes.push({ code: "in_progress", params: {} });
  if (status.kind === "pending") notes.push({ code: "waiting_closing_count", params: { date: status.waitingFor ?? "" } });
  if (recalculated) notes.push({ code: "recalculated", params: {} });
  if (totals.daysReview > 0) notes.push({ code: "days_review", params: { count: totals.daysReview } });
  if (closed && totals.daysPending > 0) notes.push({ code: "days_pending", params: { count: totals.daysPending } });
  const noOpen = variants.filter((v) => v.flags.missingOpening).length, noClose = variants.filter((v) => v.flags.missingClosing).length;
  if (noOpen > 0) notes.push({ code: "without_opening", params: { count: noOpen } });
  if (noClose > 0) notes.push({ code: "without_closing", params: { count: noClose } });
  if (totals.uncostedVariants > 0) notes.push({ code: "uncosted", params: { count: totals.uncostedVariants } });

  const from = firstOfMonth(i.month), to = lastOfMonth(i.month);
  return {
    month: i.month, shopName: i.shopName, timezone: i.timezone, currency: "LKR",
    period: { from, to }, openingCountDate: from, closingCountDate: firstOfMonth(addMonths(i.month, 1)),
    status, recalculated,
    lastExport: latest ? { format: latest.format, at: latest.exported_at, stale: latest.fingerprint !== i.fingerprint } : null,
    fingerprint: i.fingerprint, generatedAt: i.generatedAt, totals, stock, variants,
    products: aggregateProducts(asSales), categories: aggregateCategories(asSales),
    daily: buildSeries(aggregateDays(i.daily), from, to, "day"),
    lowStock: i.lowStock, notes,
  };
}

/** Summary stored with each export record (what the report said when it was exported). */
export function exportTotals(r: MonthlyReport) {
  return { estimatedSales: r.totals.estimatedSales, closingValue: r.totals.closingValue, status: r.status.kind, recalculated: r.recalculated, variants: r.variants.length };
}
