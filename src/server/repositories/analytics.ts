import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  aggregateCategories, aggregateProducts, buildSeries, compareMonths, coverage, pickMovementUnit, rangeTotals, slowMovers, topSellers,
  type CategoryAgg, type Coverage, type Granularity, type MonthCompare, type MovementTrendRow, type ProductAgg, type SeriesPoint, type UnitTotals, type VariantSalesRow,
} from "@/features/analytics/aggregate";
import { aggregateDays, buildMonthlySeries, type DaySummaryRow, type MonthPoint } from "@/features/dashboard/summary";
import { addDays, addMonths, daysBetween, firstOfMonth, isBusinessDate, monthOf } from "@/lib/dates/business";
import { shopLocalDate } from "@/lib/dates/format";
import { fetchAll } from "./inventory";

type Supa = Awaited<ReturnType<typeof createClient>>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_RANGE_DAYS = 399;

export interface AnalyticsRequest { from?: string; to?: string; category?: string; product?: string; variant?: string; by?: string; unit?: string }

export interface AnalyticsData {
  today: string;
  range: { from: string; to: string; days: number; clamped: boolean };
  filters: { category: string | null; product: string | null; variant: string | null };
  granularity: Granularity;
  totals: { amount: string; units: UnitTotals; best: { date: string; amount: string } | null };
  coverage: Coverage;
  series: SeriesPoint[];
  trend: MonthPoint[];
  compare: MonthCompare;
  products: ProductAgg[];
  categories: CategoryAgg[];
  variants: VariantSalesRow[];
  top: VariantSalesRow[];
  slow: VariantSalesRow[];
  movement: { units: string[]; unit: string | null; rows: MovementTrendRow[] };
  /** Count session id by count date, so a day can link to the count that explains it. */
  sessionByDate: Map<string, string>;
  error: boolean;
}

/** Normalises the request: valid dates, sensible defaults (this month so far), a range the database accepts. */
export function resolveRange(req: AnalyticsRequest, today: string) {
  const yesterday = addDays(today, -1);
  let to = req.to && isBusinessDate(req.to) ? req.to : yesterday;
  if (to > yesterday) to = yesterday;            // today has no sales yet: a count tomorrow morning calculates it
  let from = req.from && isBusinessDate(req.from) ? req.from : firstOfMonth(monthOf(to));
  if (from > to) from = to;
  let clamped = false;
  if (daysBetween(from, to) > MAX_RANGE_DAYS) { from = addDays(to, -MAX_RANGE_DAYS); clamped = true; }
  return { from, to, days: daysBetween(from, to) + 1, clamped };
}

export async function loadAnalytics(supabase: Supa, shop: { shopId: string; timezone: string }, req: AnalyticsRequest, now = new Date()): Promise<AnalyticsData> {
  const today = shopLocalDate(now, shop.timezone);
  const range = resolveRange(req, today);
  const granularity: Granularity = req.by === "week" || req.by === "month" ? req.by : "day";
  const filters = {
    category: req.category && UUID.test(req.category) ? req.category : null,
    product: req.product && UUID.test(req.product) ? req.product : null,
    variant: req.variant && UUID.test(req.variant) ? req.variant : null,
  };
  const args = { p_shop: shop.shopId, p_category: filters.category, p_product: filters.product, p_variant: filters.variant };

  // One wide daily fetch serves the chart, the 12-month trend and the month comparison (<= 400 days by construction).
  const trendStart = firstOfMonth(addMonths(monthOf(range.to), -11));
  const prevStart = firstOfMonth(addMonths(monthOf(range.to), -1));
  const wideFrom = [range.from, trendStart, prevStart].sort()[0];
  const wideTo = range.to;

  const [dailyRes, variants, movRes, sessRes] = await Promise.all([
    supabase.rpc("analytics_daily", { ...args, p_from: wideFrom, p_to: wideTo }),
    fetchAll<VariantSalesRow>((f, t) => supabase.rpc("analytics_variant_summary", { ...args, p_from: range.from, p_to: range.to }).range(f, t) as unknown as PromiseLike<{ data: VariantSalesRow[] | null; error: unknown }>),
    supabase.rpc("analytics_movement_trend", { ...args, p_from: range.from, p_to: range.to }),
    supabase.from("stock_count_sessions").select("id,business_date").eq("shop_id", shop.shopId).in("status", ["confirmed", "corrected"]).gte("business_date", trendStart).lte("business_date", firstOfMonth(addMonths(monthOf(range.to), 1))).limit(1000),
  ]);

  const byDate = aggregateDays((dailyRes.data ?? []) as DaySummaryRow[]);
  const sessions = (sessRes.data ?? []) as { id: string; business_date: string }[];
  const confirmed = new Set(sessions.map((s) => s.business_date));
  const sessionByDate = new Map(sessions.map((s) => [s.business_date, s.id]));
  const movRows = (movRes.data ?? []) as MovementTrendRow[];

  return {
    today, range, filters, granularity,
    totals: rangeTotals(byDate, range.from, range.to),
    coverage: coverage(byDate, range.from, range.to),
    series: buildSeries(byDate, range.from, range.to, granularity),
    trend: buildMonthlySeries(byDate, monthOf(range.to), 12, today, confirmed),
    compare: compareMonths(byDate, monthOf(range.to), today),
    products: aggregateProducts(variants), categories: aggregateCategories(variants), variants,
    top: topSellers(variants, 10), slow: slowMovers(variants, 10),
    movement: { ...pickMovementUnit(movRows, req.unit), rows: movRows },
    sessionByDate,
    error: !!(dailyRes.error || movRes.error),
  };
}
