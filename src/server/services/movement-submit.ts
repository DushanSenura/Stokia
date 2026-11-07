import "server-only";
import { normalizePackagingQuantity, type PackUnit } from "@/lib/calculations/packaging";
import { signedEffect } from "@/lib/calculations/reconcile";
import { localDateTimeToInstant } from "@/lib/dates/business";
import { shopLocalDate } from "@/lib/dates/format";
import type { createClient } from "@/lib/supabase/server";
import type { MessageKey } from "@/i18n";
import { toPackUnit, type PackagingUnitRow } from "@/server/repositories/packaging";
import { movementSchema, reverseSchema } from "@/server/validators/movements";

/**
 * Recording and reversing stock movements, shared by the web app's Server Actions and the phone API, so both validate the same way,
 * work out the same signed effect, resolve "when" the same way and call the same database functions. The database checks the role,
 * the unit, the time window and the idempotency key again.
 */
type Supa = Awaited<ReturnType<typeof createClient>>;
export interface MovementContext { supabase: Supa; shopId: string }

export type MovementOutcome =
  | { ok: true; id: string; duplicate: boolean }
  | { ok: false; error?: MessageKey; fieldErrors?: Record<string, MessageKey> };

const DB_CODES = [
  "FUTURE_TIME", "TOO_OLD", "REASON_REQUIRED", "INVALID_VARIANT", "INVALID_UNIT", "FRACTIONAL_PACKAGE", "EFFECT_MISMATCH",
  "IDEMPOTENCY_MISMATCH", "SAME_VARIANT", "IS_REVERSAL", "NOT_FOUND", "KEY_REQUIRED", "USE_REPACKING",
] as const;

/** A database error as a translatable message, without leaking internals. */
export function movementError(err: { message?: string } | null): MessageKey {
  const text = err?.message ?? "";
  if (/FORBIDDEN/.test(text)) return "error.forbidden";
  const c = DB_CODES.find((x) => text.includes(x));
  return c ? (`mv.err.${c}` as MessageKey) : "auth.error.generic";
}

/** Zod issues as per-field messages (the messages are already translation keys). */
export function movementIssues(issues: { path: PropertyKey[]; message: string }[]): Record<string, MessageKey> {
  const fieldErrors: Record<string, MessageKey> = {};
  for (const i of issues) fieldErrors[String(i.path[0] ?? "form")] ??= i.message as MessageKey;
  return fieldErrors;
}

/** Load a variant's base unit + active packaging, scoped to the caller's shop. */
export async function variantUnits(ctx: MovementContext, variantId: string): Promise<{ base: string; units: PackUnit[] } | null> {
  const { data } = await ctx.supabase.from("product_variants")
    .select("base_inventory_unit,packaging_units(id,variant_id,name,parent_unit_id,conversion_factor,base_unit_multiplier,is_active)")
    .eq("id", variantId).eq("shop_id", ctx.shopId).maybeSingle();
  if (!data) return null;
  const v = data as unknown as { base_inventory_unit: string; packaging_units: PackagingUnitRow[] };
  return { base: v.base_inventory_unit, units: v.packaging_units.filter((u) => u.is_active).map(toPackUnit) };
}

/** Quantity entered in a packaging unit (or base units) -> base-unit magnitude, using the shared engine. */
export function toBase(v: { base: string; units: PackUnit[] }, unitId: string | undefined, quantity: string) {
  const r = normalizePackagingQuantity([{ unitId: unitId ?? null, quantity }], v.units, v.base);
  return r.ok && r.counted ? r.baseQuantity : null;
}

/**
 * Resolve WHEN the stock moved. This decides which counting interval the movement belongs to, so it is explicit:
 *  - now:          after any count already taken today (belongs to the NEXT interval);
 *  - before_count: it was already on the shelf when today's count was taken (belongs to the interval that count closes);
 *  - custom:       a time the user chose (shop timezone).
 */
export async function resolveEffectiveAt(ctx: MovementContext, tz: string, when: string, local: string | undefined, countDate?: string): Promise<{ at: Date } | { error: MessageKey }> {
  if (when === "custom") {
    const at = local ? localDateTimeToInstant(local, tz) : null;
    return at ? { at } : { error: "mv.err.time" };
  }
  if (when === "before_count") {
    const today = shopLocalDate(new Date(), tz);
    const date = countDate ?? today; // a movement saved offline names the morning it was entered; the web form means today
    if (date > today) return { error: "mv.err.time" };
    const { data } = await ctx.supabase.from("stock_count_sessions").select("counted_at").eq("shop_id", ctx.shopId)
      .eq("business_date", date).maybeSingle();
    if (!data) return { error: "mv.err.noCountToday" };
    return { at: new Date(new Date(data.counted_at as string).getTime() - 60_000) }; // one minute before counting started
  }
  return { at: new Date() };
}

/** `raw` uses the form's field names (variant_id, type, direction, unit_id, quantity, when, effective_local, reason, reference, supplier, cost, key). */
export async function recordMovementCore(ctx: MovementContext, timezone: string, raw: Record<string, unknown>): Promise<MovementOutcome> {
  const p = movementSchema.safeParse(raw);
  if (!p.success) return { ok: false, fieldErrors: movementIssues(p.error.issues) };
  const v = p.data;

  const info = await variantUnits(ctx, v.variant_id);
  if (!info) return { ok: false, fieldErrors: { variant_id: "mv.err.INVALID_VARIANT" } };
  const base = toBase(info, v.unit_id, v.quantity);
  if (base === null) return { ok: false, fieldErrors: { quantity: "mv.err.quantity" } };

  let effect: string;
  try { effect = signedEffect(v.type, base, v.direction); } catch { return { ok: false, fieldErrors: { direction: "mv.err.direction" } }; }

  const when = await resolveEffectiveAt(ctx, timezone, v.when, v.effective_local, v.count_date);
  if ("error" in when) return { ok: false, fieldErrors: { [v.when === "custom" ? "effective_local" : "when"]: when.error } };

  const { data, error } = await ctx.supabase.rpc("record_movement", {
    p_shop: ctx.shopId, p_variant: v.variant_id, p_type: v.type, p_input_quantity: Number(v.quantity), p_input_unit: v.unit_id ?? null,
    p_effect: Number(effect), p_effective_at: when.at.toISOString(), p_reason: v.reason ?? null, p_reference: v.reference ?? null,
    p_supplier: v.supplier ?? null, p_cost: v.cost ? Number(v.cost) : null, p_key: v.key,
  });
  if (error) return { ok: false, error: movementError(error) };
  const r = data as { id: string; duplicate: boolean };
  return { ok: true, id: r.id, duplicate: r.duplicate };
}

/** `raw` = { reason, key }. Nothing is deleted: a matching entry cancels the original at its original time. */
export async function reverseMovementCore(ctx: MovementContext, movementId: string, raw: Record<string, unknown>): Promise<MovementOutcome> {
  const p = reverseSchema.safeParse(raw);
  if (!p.success) return { ok: false, fieldErrors: movementIssues(p.error.issues) };
  const { data, error } = await ctx.supabase.rpc("reverse_movement", { p_movement: movementId, p_reason: p.data.reason, p_key: p.data.key });
  if (error) return { ok: false, error: movementError(error) };
  const r = data as { id: string; duplicate: boolean };
  return { ok: true, id: r.id, duplicate: r.duplicate };
}
