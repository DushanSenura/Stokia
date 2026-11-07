import "server-only";
import Decimal from "decimal.js";
import { createClient } from "@/lib/supabase/server";
import type { EntryItem } from "@/features/inventory/count-entry";
import type { SalesSummary } from "@/features/inventory/count-types";
import { priceAt, type PricePeriod } from "@/lib/calculations/pricing";
import { priceInstantForSalesDate, salesDateFor } from "@/lib/dates/business";
import { sizeLabel } from "@/lib/formatting/units";
import { toPackUnit, type PackagingUnitRow } from "./packaging";

type Supa = Awaited<ReturnType<typeof createClient>>;
const PAGE = 1000; // PostgREST returns at most 1000 rows per request
export const MAX_ENTRY_ITEMS = 2000;

/** Read every page of a query (Supabase silently truncates at 1000 rows otherwise). */
export async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>, cap = 5000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error("QUERY_FAILED");
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export interface SessionRow {
  id: string; business_date: string; status: "draft" | "needs_review" | "confirmed" | "corrected";
  revision: number; counted_at: string; confirmed_at: string | null; confirmed_by: string | null; created_by: string;
}
export interface LineRow {
  variant_id: string; normalized_base_quantity: string | null; count_status: "counted" | "not_counted";
  entry_details: { entries?: { unit_id: string | null; quantity: string }[] } | null;
}

export async function getSessionByDate(supabase: Supa, shopId: string, date: string) {
  const { data } = await supabase.from("stock_count_sessions").select("*").eq("shop_id", shopId).eq("business_date", date).maybeSingle();
  return (data as SessionRow | null) ?? null;
}

export async function getLines(supabase: Supa, sessionId: string): Promise<LineRow[]> {
  return fetchAll<LineRow>((f, t) =>
    supabase.from("stock_count_lines").select("variant_id,normalized_base_quantity,count_status,entry_details").eq("session_id", sessionId).order("variant_id").range(f, t));
}

/** Latest CONFIRMED count strictly before `date` (the opening count for this interval). */
export async function getPreviousConfirmed(supabase: Supa, shopId: string, date: string) {
  const { data } = await supabase.from("stock_count_sessions").select("*").eq("shop_id", shopId).in("status", ["confirmed", "corrected"])
    .lt("business_date", date).order("business_date", { ascending: false }).limit(1).maybeSingle();
  return (data as SessionRow | null) ?? null;
}

export async function getLatestConfirmedDate(supabase: Supa, shopId: string) {
  const { data } = await supabase.from("stock_count_sessions").select("business_date").eq("shop_id", shopId).in("status", ["confirmed", "corrected"])
    .order("business_date", { ascending: false }).limit(1).maybeSingle();
  return (data?.business_date as string | undefined) ?? null;
}

interface VariantQueryRow {
  id: string; sku: string; size_value: string | null; size_unit: string | null; base_inventory_unit: string;
  products: { name: string; product_code: string; categories: { name: string } | null };
  packaging_units: PackagingUnitRow[];
}

/**
 * Everything the entry form needs: active variants (+ active packaging), the previous confirmed
 * count, and the selling price in force on the SALES date (not today's price).
 */
export async function loadEntryItems(supabase: Supa, shopId: string, countDate: string, timeZone: string) {
  const variants = await fetchAll<VariantQueryRow>((f, t) =>
    supabase.from("product_variants")
      .select("id,sku,size_value,size_unit,base_inventory_unit,products!inner(name,product_code,categories(name)),packaging_units(id,variant_id,name,parent_unit_id,conversion_factor,base_unit_multiplier,is_active)")
      .eq("shop_id", shopId).eq("is_active", true).eq("products.is_active", true).order("id").range(f, t) as unknown as PromiseLike<{ data: VariantQueryRow[] | null; error: unknown }>);

  const prev = await getPreviousConfirmed(supabase, shopId, countDate);
  const prevLines = prev ? await getLines(supabase, prev.id) : [];
  const prevQty = new Map(prevLines.filter((l) => l.count_status === "counted").map((l) => [l.variant_id, l.normalized_base_quantity as string]));

  const instant = priceInstantForSalesDate(salesDateFor(countDate), timeZone).toISOString();
  const prices = await fetchAll<PricePeriod & { variant_id: string }>((f, t) =>
    supabase.from("product_price_history").select("variant_id,price_type,amount_lkr,effective_from,effective_to")
      .eq("price_type", "selling").lte("effective_from", instant).or(`effective_to.is.null,effective_to.gt.${instant}`).order("variant_id").range(f, t) as unknown as PromiseLike<{ data: (PricePeriod & { variant_id: string })[] | null; error: unknown }>);
  const priceBy = new Map<string, PricePeriod[]>();
  for (const p of prices) priceBy.set(p.variant_id, [...(priceBy.get(p.variant_id) ?? []), p]);

  // Movements recorded in the open interval, so the preview includes deliveries/damage/returns.
  const current = await getSessionByDate(supabase, shopId, countDate);
  const totals = await loadMovementTotals(supabase, shopId, prev?.counted_at ?? null, current?.counted_at ?? new Date().toISOString());

  const truncated = variants.length > MAX_ENTRY_ITEMS;
  const items: EntryItem[] = variants
    .map((v) => ({
      variantId: v.id,
      productName: v.products.name,
      productCode: v.products.product_code,
      category: v.products.categories?.name ?? null,
      sizeLabel: sizeLabel(v.size_value, v.size_unit),
      sku: v.sku,
      baseUnit: v.base_inventory_unit,
      units: v.packaging_units.filter((u) => u.is_active).map(toPackUnit),
      previousBase: prevQty.get(v.id) ?? null,
      sellingPrice: priceAt(priceBy.get(v.id) ?? [], "selling", instant)?.amount_lkr ?? null,
      movements: totals.get(v.id) ?? ZERO_MOVEMENTS,
    }))
    .sort((a, b) => a.productName.localeCompare(b.productName) || a.sku.localeCompare(b.sku))
    .slice(0, MAX_ENTRY_ITEMS);

  return { items, previous: prev, truncated };
}

export interface HistoryFilters { from?: string; to?: string; page?: number }
export const HISTORY_PAGE_SIZE = 20;

export async function listSessions(supabase: Supa, f: HistoryFilters) {
  const page = Math.max(1, f.page ?? 1);
  let req = supabase.from("stock_count_sessions").select("id,business_date,status,revision,counted_at,confirmed_at,confirmed_by,created_by", { count: "exact" });
  if (f.from) req = req.gte("business_date", f.from);
  if (f.to) req = req.lte("business_date", f.to);
  const { data, count, error } = await req.order("business_date", { ascending: false }).range((page - 1) * HISTORY_PAGE_SIZE, page * HISTORY_PAGE_SIZE - 1);
  const rows = (data ?? []) as SessionRow[];

  // Line counts for the visible sessions + display names of the people involved.
  const ids = rows.map((r) => r.id);
  const { data: lines } = ids.length ? await supabase.from("stock_count_lines").select("session_id,count_status").in("session_id", ids).limit(20000) : { data: [] };
  const tally = new Map<string, { counted: number; notCounted: number }>();
  for (const l of lines ?? []) {
    const t = tally.get(l.session_id) ?? { counted: 0, notCounted: 0 };
    if (l.count_status === "counted") t.counted++; else t.notCounted++;
    tally.set(l.session_id, t);
  }
  const people = await displayNames(supabase, rows.flatMap((r) => [r.confirmed_by, r.created_by]));
  return { rows, total: count ?? 0, page, error, tally, people };
}

export async function displayNames(supabase: Supa, ids: (string | null)[]) {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  const { data } = uniq.length ? await supabase.from("user_profiles").select("id,display_name").in("id", uniq) : { data: [] };
  return new Map((data ?? []).map((p) => [p.id as string, p.display_name as string]));
}

export async function getSessionDetail(supabase: Supa, sessionId: string) {
  const { data: session } = await supabase.from("stock_count_sessions").select("*").eq("id", sessionId).maybeSingle();
  if (!session) return null;
  const s = session as SessionRow & { shop_id: string };
  const lines = await getLines(supabase, s.id);
  const prev = await getPreviousConfirmed(supabase, s.shop_id, s.business_date);
  const prevLines = prev ? await getLines(supabase, prev.id) : [];
  const ids = lines.map((l) => l.variant_id);
  const info = new Map<string, { name: string; sku: string; size: string; unit: string }>();
  for (let i = 0; i < ids.length; i += 150) {
    const { data } = await supabase.from("product_variants").select("id,sku,size_value,size_unit,base_inventory_unit,products(name)").in("id", ids.slice(i, i + 150));
    for (const v of (data ?? []) as unknown as { id: string; sku: string; size_value: string | null; size_unit: string | null; base_inventory_unit: string; products: { name: string } | null }[]) {
      info.set(v.id, { name: v.products?.name ?? "", sku: v.sku, size: sizeLabel(v.size_value, v.size_unit), unit: v.base_inventory_unit });
    }
  }
  const people = await displayNames(supabase, [s.confirmed_by, s.created_by]);
  return { session: s, lines, prev, prevQty: new Map(prevLines.filter((l) => l.count_status === "counted").map((l) => [l.variant_id, l.normalized_base_quantity as string])), info, people };
}

/** Flat rows for CSV export: one per count line, newest first. Capped to protect memory. */
export async function exportCountLines(supabase: Supa, f: { from?: string; to?: string }) {
  let req = supabase.from("stock_count_sessions").select("id,business_date,status").order("business_date", { ascending: false }).limit(400);
  if (f.from) req = req.gte("business_date", f.from);
  if (f.to) req = req.lte("business_date", f.to);
  const { data: sessions } = await req;
  const out: { date: string; status: string; sku: string; product: string; size: string; unit: string; countStatus: string; quantity: string | null; enteredAs: string }[] = [];
  for (const s of sessions ?? []) {
    const lines = await getLines(supabase, s.id);
    const ids = lines.map((l) => l.variant_id);
    const info = new Map<string, { name: string; sku: string; size: string; unit: string }>();
    for (let i = 0; i < ids.length; i += 150) {
      const { data } = await supabase.from("product_variants").select("id,sku,size_value,size_unit,base_inventory_unit,products(name)").in("id", ids.slice(i, i + 150));
      for (const v of (data ?? []) as unknown as { id: string; sku: string; size_value: string | null; size_unit: string | null; base_inventory_unit: string; products: { name: string } | null }[]) {
        info.set(v.id, { name: v.products?.name ?? "", sku: v.sku, size: sizeLabel(v.size_value, v.size_unit), unit: v.base_inventory_unit });
      }
    }
    for (const l of lines) {
      const v = info.get(l.variant_id);
      out.push({
        date: s.business_date, status: s.status, sku: v?.sku ?? "", product: v?.name ?? "", size: v?.size ?? "", unit: v?.unit ?? "",
        countStatus: l.count_status, quantity: l.normalized_base_quantity,
        enteredAs: (l.entry_details?.entries ?? []).map((e) => `${e.quantity} ${(e as { unit_name?: string }).unit_name ?? ""}`.trim()).join(" + "),
      });
    }
    if (out.length > 50000) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Phase 5: movements in the open interval + calculated sales
// ---------------------------------------------------------------------------------------------
import { classifyMovements, type MovementTotals, type MovementType } from "@/lib/calculations/reconcile";

export const ZERO_MOVEMENTS: MovementTotals = { received: "0", returns: "0", damaged: "0", otherOut: "0", adjustments: "0" };

/**
 * Per-variant movement totals for the interval a count would close: (openedAt, closedAt].
 * Uses exactly the window the database uses when it reconciles at confirmation, so the on-screen preview matches.
 */
export async function loadMovementTotals(supabase: Supa, shopId: string, openedAt: string | null, closedAt: string) {
  const out = new Map<string, MovementTotals>();
  if (!openedAt) return out; // no previous count: there is no interval yet
  const rows = await fetchAll<{ variant_id: string; type: MovementType; normalized_base_quantity: string }>((f, t) =>
    supabase.from("stock_movements").select("variant_id,type,normalized_base_quantity")
      .eq("shop_id", shopId).gt("effective_at", openedAt).lte("effective_at", closedAt).order("id").range(f, t));
  const by = new Map<string, { type: MovementType; effect: string }[]>();
  for (const r of rows) by.set(r.variant_id, [...(by.get(r.variant_id) ?? []), { type: r.type, effect: r.normalized_base_quantity }]);
  for (const [v, list] of by) out.set(v, classifyMovements(list));
  return out;
}

export interface SalesRow {
  variant_id: string; sales_date: string; inferred_base_units_sold: string | null; estimated_sales_amount: string | null;
  price_reference: string | null; calculation_status: "pending" | "calculated" | "needs_review" | "recalculated";
  calculation_revision: number; pending_reason: string | null;
  breakdown: { opening: number | null; closing: number | null; received: number; returns: number; damaged: number; other_out: number; adjustments: number } | null;
  product_variants: { sku: string; size_value: string | null; size_unit: string | null; base_inventory_unit: string; products: { name: string } | null } | null;
}

export async function getSalesForDate(supabase: Supa, shopId: string, date: string): Promise<SalesRow[]> {
  const rows = await fetchAll<SalesRow>((f, t) =>
    supabase.from("daily_sales")
      .select("variant_id,sales_date,inferred_base_units_sold,estimated_sales_amount,price_reference,calculation_status,calculation_revision,pending_reason,breakdown,product_variants(sku,size_value,size_unit,base_inventory_unit,products(name))")
      .eq("shop_id", shopId).eq("sales_date", date).order("variant_id").range(f, t) as unknown as PromiseLike<{ data: SalesRow[] | null; error: unknown }>);
  return rows.sort((a, b) => (a.product_variants?.products?.name ?? "").localeCompare(b.product_variants?.products?.name ?? "") || (a.product_variants?.sku ?? "").localeCompare(b.product_variants?.sku ?? ""));
}

// The shape lives in a pure module so the phone app can share it; re-exported here for existing imports.
export type { SalesSummary };

export function summarizeSales(date: string, rows: SalesRow[]): SalesSummary {
  let money = new Decimal(0);
  const units: Record<string, Decimal> = {};
  const s: SalesSummary = { date, calculated: 0, needsReview: 0, pending: 0, estimatedTotal: "0.00", unitsByBaseUnit: {} };
  for (const r of rows) {
    if (r.calculation_status === "pending") s.pending++;
    else if (r.calculation_status === "needs_review") s.needsReview++;
    else {
      s.calculated++;
      const u = r.product_variants?.base_inventory_unit.toLowerCase() ?? "unit";
      units[u] = (units[u] ?? new Decimal(0)).plus(r.inferred_base_units_sold ?? 0);
      if (r.estimated_sales_amount) money = money.plus(r.estimated_sales_amount);
    }
  }
  s.estimatedTotal = money.toFixed(2);
  s.unitsByBaseUnit = Object.fromEntries(Object.entries(units).map(([k, v]) => [k, v.toString()]));
  return s;
}
