import "server-only";
import type { BreakdownCurrent, BreakdownDay, BreakdownDraft, BreakdownHistoryEntry, BreakdownItem, BreakdownLineView, BreakdownResponse } from "@/features/sales/breakdown-types";
import { breakdownErrorKey, computeBreakdown, estimateWithoutBreakdown, type BreakdownError, type SellableUnit } from "@/lib/calculations/sales-breakdown";
import { isBusinessDate, localDateTimeToInstant } from "@/lib/dates/business";
import { sizeLabel } from "@/lib/formatting/units";
import Decimal from "decimal.js";
import type { createClient } from "@/lib/supabase/server";
import type { MessageKey } from "@/i18n";

/**
 * The optional breakdown of a day's inferred sales (whole sellable packages known), shared by the web app's Server Actions and the
 * phone API. The rule is src/lib/calculations/sales-breakdown.ts; the database repeats every check (role, whole numbers, totals,
 * prices in force, idempotency, revisions) and is the authority.
 */
type Supa = Awaited<ReturnType<typeof createClient>>;
export interface BreakdownContext { supabase: Supa; shopId: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: unknown): string => String(Number(v));

const DB_CODES = [
  "INVALID_LINE", "NEGATIVE_QUANTITY", "FRACTIONAL_PACKAGE", "DUPLICATE_UNIT", "INVALID_UNIT", "NOT_SELLABLE", "PRICE_MISSING", "EXCEEDS_INFERRED",
  "BASE_NOT_SELLABLE", "NOT_CALCULATED", "REASON_REQUIRED", "REVISION_CONFLICT", "IDEMPOTENCY_MISMATCH", "KEY_REQUIRED", "NOT_FOUND",
] as const;

/** A database error as a translatable message, without leaking internals. */
export function breakdownDbError(err: { message?: string } | null): MessageKey {
  const text = err?.message ?? "";
  if (/FORBIDDEN/.test(text)) return "error.forbidden";
  const c = DB_CODES.find((x) => text.includes(x));
  return c ? (`sb.err.${c}` as MessageKey) : "auth.error.generic";
}

interface SalesRow { variant_id: string; inferred_base_units_sold: string | null; estimated_sales_amount: string | null; calculation_status: string; packaging_status: "unknown" | "known" | "stale" }
interface VariantRow {
  id: string; sku: string; size_value: string | null; size_unit: string | null; base_inventory_unit: string; base_unit_sellable: boolean;
  products: { name: string } | null;
  packaging_units: { id: string; name: string; base_unit_multiplier: string; can_be_sold: boolean; is_active: boolean }[];
}
interface BreakdownRow {
  id: string; variant_id: string; status: "active" | "stale"; revision: number; inferred_base_units: string; packaged_base_units: string;
  remainder_base_units: string; amount: string | null; note: string | null; updated_at: string;
  sales_breakdown_lines: { packaging_unit_id: string | null; is_base_unit: boolean; unit_name: string; quantity: string; base_units: string; unit_price: string; amount: string }[];
}

const toLine = (l: BreakdownRow["sales_breakdown_lines"][number]): BreakdownLineView => ({
  unitId: l.packaging_unit_id, isBaseUnit: l.is_base_unit, name: l.unit_name, quantity: num(l.quantity), baseUnits: num(l.base_units), unitPrice: num(l.unit_price), amount: Number(l.amount).toFixed(2),
});
const byBase = (a: BreakdownLineView, b: BreakdownLineView) => Number(a.isBaseUnit) - Number(b.isBaseUnit) || Number(b.baseUnits) - Number(a.baseUnits);

/** The products whose sales on `date` can be split, with the prices in force that day and any breakdown already recorded. */
export async function loadBreakdownDay(ctx: BreakdownContext, timezone: string, date: string): Promise<BreakdownDay> {
  if (!isBusinessDate(date)) throw new Error("INVALID_DATE");
  const noon = localDateTimeToInstant(`${date}T12:00`, timezone)?.toISOString();
  if (!noon) throw new Error("INVALID_DATE");
  const { supabase, shopId } = ctx;

  const { data: sales, error } = await supabase.from("daily_sales")
    .select("variant_id,inferred_base_units_sold,estimated_sales_amount,calculation_status,packaging_status").eq("shop_id", shopId).eq("sales_date", date);
  if (error) throw new Error("SALES_QUERY_FAILED");
  const rows = (sales ?? []) as unknown as SalesRow[];
  const total = rows.filter((r) => r.calculation_status === "calculated" || r.calculation_status === "recalculated")
    .reduce((n, r) => n.plus(r.estimated_sales_amount ?? 0), new Decimal(0)).toFixed(2);
  if (rows.length === 0) return { date, items: [], unavailable: 0, estimatedTotal: total };

  const ids = rows.map((r) => r.variant_id);
  const [variantsRes, breakdownsRes, baseRes] = await Promise.all([
    supabase.from("product_variants")
      .select("id,sku,size_value,size_unit,base_inventory_unit,base_unit_sellable,products(name),packaging_units(id,name,base_unit_multiplier,can_be_sold,is_active)").in("id", ids),
    supabase.from("sales_breakdowns")
      .select("id,variant_id,status,revision,inferred_base_units,packaged_base_units,remainder_base_units,amount,note,updated_at,sales_breakdown_lines(packaging_unit_id,is_base_unit,unit_name,quantity,base_units,unit_price,amount)")
      .eq("shop_id", shopId).eq("sales_date", date),
    supabase.from("product_price_history").select("variant_id,amount_lkr").eq("price_type", "selling").in("variant_id", ids)
      .lte("effective_from", noon).or(`effective_to.is.null,effective_to.gt.${noon}`),
  ]);
  if (variantsRes.error || breakdownsRes.error || baseRes.error) throw new Error("BREAKDOWN_QUERY_FAILED");
  const variants = (variantsRes.data ?? []) as unknown as VariantRow[];
  const breakdowns = new Map(((breakdownsRes.data ?? []) as unknown as BreakdownRow[]).map((b) => [b.variant_id, b]));
  const basePrice = new Map(((baseRes.data ?? []) as { variant_id: string; amount_lkr: string }[]).map((p) => [p.variant_id, num(p.amount_lkr)]));

  const unitIds = variants.flatMap((v) => v.packaging_units.filter((u) => u.can_be_sold).map((u) => u.id));
  const unitPrice = new Map<string, string>();
  if (unitIds.length) {
    const { data, error: pe } = await supabase.from("packaging_unit_price_history").select("unit_id,amount_lkr").in("unit_id", unitIds)
      .lte("effective_from", noon).or(`effective_to.is.null,effective_to.gt.${noon}`);
    if (pe) throw new Error("PRICE_QUERY_FAILED");
    for (const p of (data ?? []) as { unit_id: string; amount_lkr: string }[]) unitPrice.set(p.unit_id, num(p.amount_lkr));
  }

  const items: BreakdownItem[] = [];
  let unavailable = 0;
  for (const s of rows) {
    const v = variants.find((x) => x.id === s.variant_id);
    if (!v) continue;
    const units: SellableUnit[] = v.packaging_units.filter((u) => u.can_be_sold)
      .sort((a, b) => Number(b.base_unit_multiplier) - Number(a.base_unit_multiplier))
      .map((u) => ({ id: u.id, name: u.name, multiplier: num(u.base_unit_multiplier), canBeSold: true, isActive: u.is_active, price: unitPrice.get(u.id) ?? null }));
    const b = breakdowns.get(v.id);
    if (units.filter((u) => u.isActive).length === 0 && !b) continue;
    const calculated = s.calculation_status === "calculated" || s.calculation_status === "recalculated";
    if (!calculated || s.inferred_base_units_sold === null) { unavailable++; continue; }
    const inferred = num(s.inferred_base_units_sold);
    const base = { name: v.base_inventory_unit, sellable: v.base_unit_sellable, price: basePrice.get(v.id) ?? null };
    const current: BreakdownCurrent | null = b ? {
      revision: b.revision, status: b.status, inferred: num(b.inferred_base_units), packaged: num(b.packaged_base_units), remainder: num(b.remainder_base_units),
      amount: b.amount === null ? null : Number(b.amount).toFixed(2), note: b.note, updatedAt: b.updated_at, lines: b.sales_breakdown_lines.map(toLine).sort(byBase),
    } : null;
    items.push({
      variantId: v.id, name: v.products?.name ?? "", size: sizeLabel(v.size_value, v.size_unit), sku: v.sku, baseUnit: v.base_inventory_unit, inferred,
      packagingStatus: s.packaging_status, amount: s.estimated_sales_amount === null ? null : Number(s.estimated_sales_amount).toFixed(2),
      plainEstimate: estimateWithoutBreakdown(inferred, base.price), base, units, current,
    });
  }
  items.sort((a, b) => a.name.localeCompare(b.name) || a.sku.localeCompare(b.sku));
  return { date, items, unavailable, estimatedTotal: total };
}

/** Validate with the shared rule (friendly, per-line messages), then record through the database function. */
export async function saveBreakdownCore(ctx: BreakdownContext, timezone: string, draft: BreakdownDraft, key: string): Promise<BreakdownResponse> {
  if (!UUID.test(draft.variantId) || !isBusinessDate(draft.date) || !Array.isArray(draft.lines) || draft.lines.length > 25) return { ok: false, error: "auth.error.generic" };
  if (draft.lines.some((l) => typeof l?.unitId !== "string" || !UUID.test(l.unitId) || typeof l?.quantity !== "string")) return { ok: false, error: "auth.error.generic" };
  if (typeof key !== "string" || key.trim().length < 8 || key.length > 80) return { ok: false, error: "sb.err.KEY_REQUIRED" };

  const day = await loadBreakdownDay(ctx, timezone, draft.date);
  const item = day.items.find((i) => i.variantId === draft.variantId);
  if (!item) return { ok: false, error: "sb.err.NOT_CALCULATED" };

  const check = computeBreakdown({ inferred: item.inferred, lines: draft.lines, units: item.units, base: item.base, requireActive: true });
  if (!check.ok) return rejection(check.error, check.unitId);

  const reason = draft.reason?.trim().slice(0, 300) || null;
  const { data, error } = await ctx.supabase.rpc("record_sales_breakdown", {
    p_shop: ctx.shopId, p_variant: draft.variantId, p_date: draft.date,
    p_lines: draft.lines.map((l) => ({ unit_id: l.unitId, quantity: Number(l.quantity) })),
    p_reason: reason, p_key: key, p_expected_revision: draft.expectedRevision ?? null,
  });
  if (error) return { ok: false, error: breakdownDbError(error) };
  const r = data as { duplicate: boolean; revision: number; amount?: number };
  return { ok: true, duplicate: r.duplicate, revision: r.revision, amount: r.amount === undefined ? undefined : Number(r.amount).toFixed(2) };
}

/** "I do not know the box sales after all": removes the breakdown (its history stays) and the day returns to the plain estimate. */
export async function clearBreakdownCore(ctx: BreakdownContext, input: { variantId: string; date: string; reason: string }, key: string): Promise<BreakdownResponse> {
  if (!UUID.test(input.variantId) || !isBusinessDate(input.date)) return { ok: false, error: "auth.error.generic" };
  if (typeof key !== "string" || key.trim().length < 8 || key.length > 80) return { ok: false, error: "sb.err.KEY_REQUIRED" };
  const { data, error } = await ctx.supabase.rpc("clear_sales_breakdown", {
    p_shop: ctx.shopId, p_variant: input.variantId, p_date: input.date, p_reason: input.reason?.trim().slice(0, 300) ?? "", p_key: key,
  });
  if (error) return { ok: false, error: breakdownDbError(error) };
  const r = data as { duplicate: boolean; revision: number };
  return { ok: true, duplicate: r.duplicate, revision: r.revision };
}

function rejection(code: BreakdownError, unitId?: string): BreakdownResponse {
  const key = breakdownErrorKey(code);
  const lineLevel: BreakdownError[] = ["NEGATIVE_QUANTITY", "FRACTIONAL_PACKAGE", "DUPLICATE_UNIT", "INVALID_UNIT", "NOT_SELLABLE", "PRICE_MISSING", "INVALID_LINE"];
  return unitId && lineLevel.includes(code) ? { ok: false, error: key, fieldErrors: { [unitId]: key } } : { ok: false, error: key };
}

/** Who changed what, and why, for one product and day. Oldest first. */
export async function loadBreakdownHistory(ctx: BreakdownContext, variantId: string, date: string): Promise<BreakdownHistoryEntry[]> {
  if (!UUID.test(variantId) || !isBusinessDate(date)) throw new Error("INVALID_REQUEST");
  const { data, error } = await ctx.supabase.from("sales_breakdown_revisions")
    .select("revision,action,reason,snapshot,created_at,created_by").eq("shop_id", ctx.shopId).eq("variant_id", variantId).eq("sales_date", date)
    .order("created_at", { ascending: true }).order("revision", { ascending: true });
  if (error) throw new Error("HISTORY_QUERY_FAILED");
  const rows = (data ?? []) as { revision: number; action: BreakdownHistoryEntry["action"]; reason: string | null; created_at: string; created_by: string | null;
    snapshot: { amount?: number | string | null; packaged?: number | string; lines?: { unit_id: string | null; is_base_unit: boolean; name: string; quantity: number | string; base_units: number | string; unit_price: number | string; amount: number | string }[] } | null }[];
  const ids = [...new Set(rows.map((r) => r.created_by).filter((x): x is string => !!x))];
  const people = new Map<string, string>();
  if (ids.length) {
    const { data: profiles } = await ctx.supabase.from("user_profiles").select("id,display_name").in("id", ids);
    for (const p of (profiles ?? []) as { id: string; display_name: string }[]) people.set(p.id, p.display_name);
  }
  return rows.map((r) => ({
    revision: r.revision, action: r.action, reason: r.reason, at: r.created_at, by: r.created_by ? people.get(r.created_by) ?? null : null,
    amount: r.snapshot?.amount === undefined || r.snapshot.amount === null ? null : Number(r.snapshot.amount).toFixed(2),
    packaged: r.snapshot?.packaged === undefined ? null : num(r.snapshot.packaged),
    lines: (r.snapshot?.lines ?? []).map((l) => ({
      unitId: l.unit_id, isBaseUnit: l.is_base_unit, name: l.name, quantity: num(l.quantity), baseUnits: num(l.base_units), unitPrice: num(l.unit_price), amount: Number(l.amount).toFixed(2),
    })).sort(byBase),
  }));
}
