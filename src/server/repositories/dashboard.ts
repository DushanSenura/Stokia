import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  aggregateDays, buildAlerts, buildDailySeries, buildMonthlySeries, monthStatus, monthTotals, pendingCountDays, yesterdayKpi,
  type DailyPoint, type DashAlert, type DaySummaryRow, type MonthPoint, type MonthTotals, type YesterdayKpi,
} from "@/features/dashboard/summary";
import { addDays, addMonths, firstOfMonth, lastOfMonth, monthOf } from "@/lib/dates/business";
import { shopLocalDate } from "@/lib/dates/format";
import { sizeLabel } from "@/lib/formatting/units";
import { displayNames } from "./inventory";

type Supa = Awaited<ReturnType<typeof createClient>>;
export interface ShopRef { shopId: string; timezone: string }

export interface AlertInputs {
  today: string;
  todayCount: "none" | "draft" | "confirmed";
  latest: { id: string; business_date: string; confirmed_at: string | null; confirmed_by: string | null } | null;
  needsReviewCount: number;
  needsReviewHref: string | null;
  lowStockCount: number;
  report: { month: string; status: "complete" | "in_progress" | "pending"; waitingFor: string | null };
}

/** The small set of facts behind the notification bell and the dashboard's alert list (kept cheap: a handful of indexed reads). */
export async function loadAlertInputs(supabase: Supa, m: ShopRef, now = new Date()): Promise<AlertInputs> {
  const today = shopLocalDate(now, m.timezone);
  const curMonth = monthOf(today);
  const prevMonth = addMonths(curMonth, -1);

  const [todayRes, latestRes, reviewRes, lowRes, closingRes] = await Promise.all([
    supabase.from("stock_count_sessions").select("status").eq("shop_id", m.shopId).eq("business_date", today).maybeSingle(),
    supabase.from("stock_count_sessions").select("id,business_date,confirmed_at,confirmed_by").eq("shop_id", m.shopId).in("status", ["confirmed", "corrected"]).order("business_date", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("daily_sales").select("sales_date").eq("shop_id", m.shopId).eq("calculation_status", "needs_review").gte("sales_date", addDays(today, -14)).order("sales_date", { ascending: false }).limit(1000),
    supabase.rpc("low_stock_items", { p_shop: m.shopId, p_limit: 1 }),
    supabase.from("stock_count_sessions").select("business_date").eq("shop_id", m.shopId).in("status", ["confirmed", "corrected"]).eq("business_date", firstOfMonth(curMonth)).maybeSingle(),
  ]);

  const reviewRows = (reviewRes.data ?? []) as { sales_date: string }[];
  let needsReviewHref: string | null = null;
  if (reviewRows.length > 0) {
    // The day's explanation lives on the NEXT morning's count.
    const { data: s } = await supabase.from("stock_count_sessions").select("id").eq("shop_id", m.shopId).eq("business_date", addDays(reviewRows[0].sales_date, 1)).maybeSingle();
    needsReviewHref = s ? `/stock-history/${s.id}` : null;
  }

  const confirmed = new Set<string>(closingRes.data ? [closingRes.data.business_date as string] : []);
  const rep = monthStatus(prevMonth, today, confirmed);
  const status = todayRes.data?.status as string | undefined;
  return {
    today,
    todayCount: !status ? "none" : status === "draft" ? "draft" : "confirmed",
    latest: (latestRes.data as AlertInputs["latest"]) ?? null,
    needsReviewCount: reviewRows.length,
    needsReviewHref,
    lowStockCount: ((lowRes.data ?? []) as { total_low: number }[])[0]?.total_low ?? 0,
    report: { month: prevMonth, ...rep },
  };
}

export function alertsFrom(i: AlertInputs): DashAlert[] {
  return buildAlerts({
    today: i.today, todayCount: i.todayCount, latestConfirmed: i.latest?.business_date ?? null,
    needsReviewCount: i.needsReviewCount, needsReviewHref: i.needsReviewHref, lowStockCount: i.lowStockCount, report: i.report,
  });
}

export interface TopProduct { variantId: string; name: string; size: string; sku: string; baseUnit: string; units: string; amount: string }
export interface LowStockItem { variantId: string; name: string; size: string; sku: string; baseUnit: string; quantity: string; threshold: string }
export interface ActivityItem { kind: "count" | "movement"; at: string; title: string; detail: string; by: string | null; href: string | null }

export interface DashboardData {
  today: string;
  salesDate: string;
  month: string;
  morning: {
    countDate: string; salesDate: string; state: "none" | "draft" | "confirmed"; sessionId: string | null;
    last: { date: string; confirmedAt: string | null; by: string | null; sessionId: string } | null;
  };
  yesterday: YesterdayKpi;
  monthTotals: MonthTotals;
  monthStatus: { status: "complete" | "in_progress" | "pending"; waitingFor: string | null };
  daily: DailyPoint[];
  trend: MonthPoint[];
  top: TopProduct[];
  valuation: { asOf: string; totalCost: string; valued: number; uncosted: number; counted: number } | null;
  activeProducts: number;
  low: { items: LowStockItem[]; total: number };
  pendingCounts: number;
  alerts: DashAlert[];
  activity: ActivityItem[];
}

const clamp = (v: string, lo: string, hi: string) => (v < lo ? lo : v > hi ? hi : v);

export async function loadDashboard(supabase: Supa, m: ShopRef, req: { month?: string; salesDate?: string }): Promise<DashboardData> {
  const inputs = await loadAlertInputs(supabase, m);
  const today = inputs.today;
  const yesterday = addDays(today, -1);

  // The sales date can only be a day a count could have calculated (up to yesterday); the month can't be in the future.
  const salesDate = req.salesDate ? clamp(req.salesDate, "2000-01-01", yesterday) : yesterday;
  const month = req.month ? clamp(req.month, "2000-01", monthOf(today)) : monthOf(today);
  const rangeFrom = firstOfMonth(addMonths(month, -11));
  const rangeTo = lastOfMonth(month);
  // Counts needed to judge month completeness: the selected 12 months plus last month's closing count (the 1st of this month).
  const countsFrom = [rangeFrom, firstOfMonth(addMonths(monthOf(today), -1))].sort()[0];
  const countsTo = [addDays(rangeTo, 1), today].sort()[1];

  const [yearRes, dayRes, topRes, valRes, lowRes, productsRes, sessionsRes, sessionsToday, recentCounts, recentMoves] = await Promise.all([
    supabase.rpc("sales_daily_summary", { p_shop: m.shopId, p_from: rangeFrom, p_to: rangeTo }),
    supabase.rpc("sales_daily_summary", { p_shop: m.shopId, p_from: salesDate, p_to: salesDate }),
    supabase.rpc("sales_top_products", { p_shop: m.shopId, p_from: firstOfMonth(month), p_to: rangeTo, p_limit: 5 }),
    supabase.rpc("stock_valuation", { p_shop: m.shopId }),
    supabase.rpc("low_stock_items", { p_shop: m.shopId, p_limit: 6 }),
    supabase.from("products").select("id", { count: "exact", head: true }).eq("shop_id", m.shopId).eq("is_active", true),
    supabase.from("stock_count_sessions").select("id,business_date").eq("shop_id", m.shopId).in("status", ["confirmed", "corrected"])
      .gte("business_date", countsFrom).lte("business_date", countsTo).order("business_date").limit(1000),
    supabase.from("stock_count_sessions").select("id").eq("shop_id", m.shopId).eq("business_date", today).maybeSingle(),
    supabase.from("stock_count_sessions").select("id,business_date,confirmed_at,confirmed_by").eq("shop_id", m.shopId).in("status", ["confirmed", "corrected"]).order("confirmed_at", { ascending: false }).limit(5),
    supabase.from("stock_movements").select("id,type,normalized_base_quantity,created_at,created_by,product_variants(sku,size_value,size_unit,base_inventory_unit,products(name))").eq("shop_id", m.shopId).order("created_at", { ascending: false }).limit(6),
  ]);

  const byDate = aggregateDays((yearRes.data ?? []) as DaySummaryRow[]);
  const byDay = aggregateDays((dayRes.data ?? []) as DaySummaryRow[]);
  const sessions = (sessionsRes.data ?? []) as { id: string; business_date: string }[];
  const confirmedDates = new Set(sessions.map((s) => s.business_date));
  const sessionByDate = new Map(sessions.map((s) => [s.business_date, s.id]));

  const tops = ((topRes.data ?? []) as { variant_id: string; product_name: string; sku: string; size_value: string | null; size_unit: string | null; base_unit: string; units_sold: string; estimated_amount: string }[])
    .map((r): TopProduct => ({ variantId: r.variant_id, name: r.product_name, size: sizeLabel(r.size_value, r.size_unit), sku: r.sku, baseUnit: r.base_unit, units: String(Number(r.units_sold)), amount: Number(r.estimated_amount).toFixed(2) }));

  const lowRows = (lowRes.data ?? []) as { variant_id: string; product_name: string; sku: string; size_value: string | null; size_unit: string | null; base_unit: string; quantity: string; threshold: string; total_low: number }[];
  const v = ((valRes.data ?? []) as { as_of: string; total_cost: string; valued_count: number; uncosted_count: number; counted_total: number }[])[0];

  // Recent activity: latest confirmed counts + latest movements, newest first.
  const counts = (recentCounts.data ?? []) as { id: string; business_date: string; confirmed_at: string | null; confirmed_by: string | null }[];
  const moves = (recentMoves.data ?? []) as unknown as { id: string; type: string; normalized_base_quantity: string; created_at: string; created_by: string; product_variants: { sku: string; size_value: string | null; size_unit: string | null; base_inventory_unit: string; products: { name: string } | null } | null }[];
  const people = await displayNames(supabase, [...counts.map((c) => c.confirmed_by), ...moves.map((x) => x.created_by), inputs.latest?.confirmed_by ?? null]);
  const activity: ActivityItem[] = [
    ...counts.filter((c) => c.confirmed_at).map((c): ActivityItem => ({ kind: "count", at: c.confirmed_at!, title: c.business_date, detail: "", by: people.get(c.confirmed_by ?? "") ?? null, href: `/stock-history/${c.id}` })),
    ...moves.map((x): ActivityItem => ({
      kind: "movement", at: x.created_at, title: x.type,
      detail: `${Number(x.normalized_base_quantity) > 0 ? "+" : ""}${Number(x.normalized_base_quantity)} ${x.product_variants?.base_inventory_unit ?? ""} · ${x.product_variants?.products?.name ?? ""} ${sizeLabel(x.product_variants?.size_value ?? null, x.product_variants?.size_unit ?? null)}`.trim(),
      by: people.get(x.created_by) ?? null, href: "/movements",
    })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);

  const closingConfirmed = confirmedDates.has(addDays(salesDate, 1));
  return {
    today, salesDate, month,
    morning: {
      countDate: today, salesDate: yesterday, state: inputs.todayCount, sessionId: sessionsToday.data?.id ?? null,
      last: inputs.latest ? { date: inputs.latest.business_date, confirmedAt: inputs.latest.confirmed_at, by: people.get(inputs.latest.confirmed_by ?? "") ?? null, sessionId: inputs.latest.id } : null,
    },
    yesterday: yesterdayKpi(byDay.get(salesDate), closingConfirmed),
    monthTotals: monthTotals(byDate, month),
    monthStatus: monthStatus(month, today, confirmedDates),
    daily: buildDailySeries(month, byDate, sessionByDate),
    trend: buildMonthlySeries(byDate, month, 12, today, confirmedDates),
    top: tops,
    valuation: v ? { asOf: v.as_of, totalCost: Number(v.total_cost).toFixed(2), valued: v.valued_count, uncosted: v.uncosted_count, counted: v.counted_total } : null,
    activeProducts: productsRes.count ?? 0,
    low: {
      total: lowRows[0]?.total_low ?? 0,
      items: lowRows.map((r): LowStockItem => ({ variantId: r.variant_id, name: r.product_name, size: sizeLabel(r.size_value, r.size_unit), sku: r.sku, baseUnit: r.base_unit, quantity: String(Number(r.quantity)), threshold: String(Number(r.threshold)) })),
    },
    pendingCounts: pendingCountDays(inputs.latest?.business_date ?? null, today),
    alerts: alertsFrom(inputs),
    activity,
  };
}
