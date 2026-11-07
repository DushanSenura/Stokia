import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { DaySummaryRow } from "@/features/dashboard/summary";
import { buildMonthlyReport, type ExportFormat, type ExportRecord, type MonthlyReport, type ReportIndexRow, type ReportVariantRow } from "@/features/reports/report";
import { addMonths, firstOfMonth, isMonth, lastOfMonth, monthOf } from "@/lib/dates/business";
import { shopLocalDate } from "@/lib/dates/format";
import { sizeLabel } from "@/lib/formatting/units";
import { fetchAll } from "./inventory";

type Supa = Awaited<ReturnType<typeof createClient>>;
export interface ShopInfo { shopId: string; shopName: string; timezone: string }

/** A report can be built for any month from 2000 up to (and including) the current month. */
export function validReportMonth(month: unknown, today: string): month is string {
  return isMonth(month) && month >= "2000-01" && month <= monthOf(today);
}

export async function loadMonthlyReport(supabase: Supa, shop: ShopInfo, month: string, now = new Date()): Promise<MonthlyReport> {
  const today = shopLocalDate(now, shop.timezone);
  const closingDate = firstOfMonth(addMonths(month, 1));

  const [rows, dailyRes, closingRes, fpRes, exportsRes, lowRes] = await Promise.all([
    fetchAll<ReportVariantRow>((f, t) => supabase.rpc("monthly_report_variants", { p_shop: shop.shopId, p_month: month }).range(f, t) as unknown as PromiseLike<{ data: ReportVariantRow[] | null; error: unknown }>, 20000),
    supabase.rpc("analytics_daily", { p_shop: shop.shopId, p_from: firstOfMonth(month), p_to: lastOfMonth(month) }),
    supabase.from("stock_count_sessions").select("id").eq("shop_id", shop.shopId).in("status", ["confirmed", "corrected"]).eq("business_date", closingDate).maybeSingle(),
    supabase.rpc("monthly_report_fingerprint", { p_shop: shop.shopId, p_month: month }),
    supabase.from("report_exports").select("format,exported_at,fingerprint").eq("shop_id", shop.shopId).eq("report_month", month).order("exported_at", { ascending: false }).limit(20),
    supabase.rpc("low_stock_items", { p_shop: shop.shopId, p_limit: 50 }),
  ]);
  if (dailyRes.error || fpRes.error) throw new Error("REPORT_QUERY_FAILED");

  const low = ((lowRes.data ?? []) as { product_name: string; size_value: string | null; size_unit: string | null; sku: string; base_unit: string; quantity: string; threshold: string }[])
    .map((x) => ({ name: x.product_name, size: sizeLabel(x.size_value, x.size_unit), sku: x.sku, unit: x.base_unit, quantity: String(Number(x.quantity)), threshold: String(Number(x.threshold)) }));

  return buildMonthlyReport({
    month, today, shopName: shop.shopName, timezone: shop.timezone, generatedAt: now.toISOString(),
    rows, daily: (dailyRes.data ?? []) as DaySummaryRow[], hasClosingCount: !!closingRes.data,
    fingerprint: String(fpRes.data ?? ""), exports: (exportsRes.data ?? []) as ExportRecord[], lowStock: low,
  });
}

/** Writes the audit record for an export (who, when, which format, and the data version exported). */
export async function recordExport(supabase: Supa, shopId: string, report: MonthlyReport, format: ExportFormat, totals: Record<string, unknown>) {
  const { error } = await supabase.rpc("record_report_export", { p_shop: shopId, p_month: report.month, p_format: format, p_fingerprint: report.fingerprint, p_totals: totals });
  return !error;
}

// The shape lives in a pure module so the phone app can share it; re-exported here for existing imports.
export type { ReportIndexRow };

/** The last `count` months, newest first, with status / recalculated / exported flags (cheap: no per-month fingerprints). */
export async function loadReportIndex(supabase: Supa, shop: ShopInfo, count = 12, now = new Date()): Promise<ReportIndexRow[]> {
  const today = shopLocalDate(now, shop.timezone);
  const cur = monthOf(today);
  const oldest = addMonths(cur, -(count - 1));
  const from = firstOfMonth(oldest);

  const [dailyRes, sessionsRes, revRes, expRes] = await Promise.all([
    supabase.rpc("analytics_daily", { p_shop: shop.shopId, p_from: from, p_to: lastOfMonth(cur) }),
    supabase.from("stock_count_sessions").select("business_date").eq("shop_id", shop.shopId).in("status", ["confirmed", "corrected"]).gte("business_date", from).lte("business_date", firstOfMonth(addMonths(cur, 1))).limit(1000),
    supabase.from("daily_sales").select("sales_date").eq("shop_id", shop.shopId).gt("calculation_revision", 1).gte("sales_date", from).limit(1000),
    supabase.from("report_exports").select("report_month,format,exported_at").eq("shop_id", shop.shopId).gte("report_month", oldest).order("exported_at", { ascending: false }).limit(500),
  ]);

  const daily = (dailyRes.data ?? []) as DaySummaryRow[];
  const confirmed = new Set(((sessionsRes.data ?? []) as { business_date: string }[]).map((s) => s.business_date));
  const recalculated = new Set(((revRes.data ?? []) as { sales_date: string }[]).map((r) => monthOf(r.sales_date)));
  const lastExport = new Map<string, { format: ExportFormat; at: string }>();
  for (const e of (expRes.data ?? []) as { report_month: string; format: ExportFormat; exported_at: string }[]) if (!lastExport.has(e.report_month)) lastExport.set(e.report_month, { format: e.format, at: e.exported_at });

  return Array.from({ length: count }, (_, i) => addMonths(cur, -i)).map((month): ReportIndexRow => {
    const days = daily.filter((d) => monthOf(d.sales_date) === month);
    const hasFigures = days.some((d) => d.calculated_count > 0);
    const amount = days.reduce((n, d) => n + Number(d.estimated_amount), 0);
    const closing = firstOfMonth(addMonths(month, 1));
    const status = month >= cur ? "in_progress" : confirmed.has(closing) ? "complete" : "pending";
    return {
      month, estimatedSales: hasFigures ? amount.toFixed(2) : null,
      daysCalculated: days.reduce((n, d) => n + d.calculated_count, 0), daysReview: days.reduce((n, d) => n + d.needs_review_count, 0),
      status, waitingFor: status === "pending" ? closing : null, recalculated: recalculated.has(month), lastExport: lastExport.get(month) ?? null,
    };
  });
}
