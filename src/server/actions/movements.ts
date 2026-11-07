"use server";

import { revalidatePath } from "next/cache";
import { normalizePackagingQuantity, type PackUnit } from "@/lib/calculations/packaging";
import { signedEffect } from "@/lib/calculations/reconcile";
import { localDateTimeToInstant } from "@/lib/dates/business";
import { shopLocalDate } from "@/lib/dates/format";
import { toPackUnit, type PackagingUnitRow } from "@/server/repositories/packaging";
import { requireRole, type Guard } from "@/server/services/guard";
import { getSessionContext } from "@/server/services/session";
import { movementSchema, repackSchema, reverseSchema } from "@/server/validators/movements";
import type { FormState } from "@/server/actions/auth";
import type { MessageKey } from "@/i18n";
import { rolesFor } from "@/server/permissions";

const DB_CODES = [
  "FUTURE_TIME", "TOO_OLD", "REASON_REQUIRED", "INVALID_VARIANT", "INVALID_UNIT", "FRACTIONAL_PACKAGE", "EFFECT_MISMATCH",
  "IDEMPOTENCY_MISMATCH", "SAME_VARIANT", "IS_REVERSAL", "NOT_FOUND", "KEY_REQUIRED", "USE_REPACKING",
] as const;

function mapError(err: { message?: string } | null): MessageKey {
  const text = err?.message ?? "";
  if (/FORBIDDEN/.test(text)) return "error.forbidden";
  const c = DB_CODES.find((x) => text.includes(x));
  return c ? (`mv.err.${c}` as MessageKey) : "auth.error.generic";
}

function invalid(issues: { path: PropertyKey[]; message: string }[]): FormState {
  const fieldErrors: Record<string, MessageKey> = {};
  for (const i of issues) fieldErrors[String(i.path[0] ?? "form")] ??= i.message as MessageKey;
  return { fieldErrors };
}

type Ok = Extract<Guard, { ok: true }>;

/** Load a variant's base unit + active packaging, scoped to the caller's shop. */
async function variantUnits(g: Ok, variantId: string): Promise<{ base: string; units: PackUnit[] } | null> {
  const { data } = await g.supabase.from("product_variants")
    .select("base_inventory_unit,packaging_units(id,variant_id,name,parent_unit_id,conversion_factor,base_unit_multiplier,is_active)")
    .eq("id", variantId).eq("shop_id", g.shopId).maybeSingle();
  if (!data) return null;
  const v = data as unknown as { base_inventory_unit: string; packaging_units: PackagingUnitRow[] };
  return { base: v.base_inventory_unit, units: v.packaging_units.filter((u) => u.is_active).map(toPackUnit) };
}

/** Quantity entered in a packaging unit (or base units) -> base-unit magnitude, using the shared engine. */
function toBase(v: { base: string; units: PackUnit[] }, unitId: string | undefined, quantity: string) {
  const r = normalizePackagingQuantity([{ unitId: unitId ?? null, quantity }], v.units, v.base);
  return r.ok && r.counted ? r.baseQuantity : null;
}

/**
 * Resolve WHEN the stock moved. This decides which counting interval the movement belongs to, so it is explicit:
 *  - now:          after any count already taken today (belongs to the NEXT interval);
 *  - before_count: it was already on the shelf when today's count was taken (belongs to the interval that count closes);
 *  - custom:       a time the user chose (shop timezone).
 */
async function resolveEffectiveAt(g: Ok, tz: string, when: string, local: string | undefined): Promise<{ at: Date } | { error: MessageKey }> {
  if (when === "custom") {
    const at = local ? localDateTimeToInstant(local, tz) : null;
    return at ? { at } : { error: "mv.err.time" };
  }
  if (when === "before_count") {
    const { data } = await g.supabase.from("stock_count_sessions").select("counted_at").eq("shop_id", g.shopId)
      .eq("business_date", shopLocalDate(new Date(), tz)).maybeSingle();
    if (!data) return { error: "mv.err.noCountToday" };
    return { at: new Date(new Date(data.counted_at as string).getTime() - 60_000) }; // one minute before counting started
  }
  return { at: new Date() };
}

export async function recordMovementAction(_: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(rolesFor("inventory.write"));
  if (!g.ok) return { error: g.error };
  const p = movementSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return invalid(p.error.issues);
  const v = p.data;

  const info = await variantUnits(g, v.variant_id);
  if (!info) return { fieldErrors: { variant_id: "mv.err.INVALID_VARIANT" } };
  const base = toBase(info, v.unit_id, v.quantity);
  if (base === null) return { fieldErrors: { quantity: "mv.err.quantity" } };

  let effect: string;
  try { effect = signedEffect(v.type, base, v.direction); } catch { return { fieldErrors: { direction: "mv.err.direction" } }; }

  const ctx = await getSessionContext();
  const when = await resolveEffectiveAt(g, ctx.membership?.timezone ?? "Asia/Colombo", v.when, v.effective_local);
  if ("error" in when) return { fieldErrors: { [v.when === "custom" ? "effective_local" : "when"]: when.error } };

  const { data, error } = await g.supabase.rpc("record_movement", {
    p_shop: g.shopId, p_variant: v.variant_id, p_type: v.type, p_input_quantity: Number(v.quantity), p_input_unit: v.unit_id ?? null,
    p_effect: Number(effect), p_effective_at: when.at.toISOString(), p_reason: v.reason ?? null, p_reference: v.reference ?? null,
    p_supplier: v.supplier ?? null, p_cost: v.cost ? Number(v.cost) : null, p_key: v.key,
  });
  if (error) return { error: mapError(error) };
  for (const path of ["/movements", "/stock-history", "/morning-stock", "/dashboard"]) revalidatePath(path);
  return { success: (data as { duplicate: boolean }).duplicate ? "mv.duplicate" : "mv.recorded" };
}

export async function recordRepackingAction(_: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(rolesFor("inventory.write"));
  if (!g.ok) return { error: g.error };
  const p = repackSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return invalid(p.error.issues);
  const v = p.data;

  const [from, to] = await Promise.all([variantUnits(g, v.from_variant), variantUnits(g, v.to_variant)]);
  if (!from) return { fieldErrors: { from_variant: "mv.err.INVALID_VARIANT" } };
  if (!to) return { fieldErrors: { to_variant: "mv.err.INVALID_VARIANT" } };
  const outQty = toBase(from, v.from_unit, v.from_quantity);
  const inQty = toBase(to, v.to_unit, v.to_quantity);
  if (outQty === null) return { fieldErrors: { from_quantity: "mv.err.quantity" } };
  if (inQty === null) return { fieldErrors: { to_quantity: "mv.err.quantity" } };

  const ctx = await getSessionContext();
  const when = await resolveEffectiveAt(g, ctx.membership?.timezone ?? "Asia/Colombo", v.when, v.effective_local);
  if ("error" in when) return { fieldErrors: { effective_local: when.error } };

  const { data, error } = await g.supabase.rpc("record_repacking", {
    p_shop: g.shopId, p_from_variant: v.from_variant, p_from_qty: Number(outQty), p_to_variant: v.to_variant, p_to_qty: Number(inQty),
    p_effective_at: when.at.toISOString(), p_reason: v.reason, p_reference: null, p_key: v.key,
  });
  if (error) return { error: mapError(error) };
  for (const path of ["/movements", "/stock-history", "/morning-stock", "/dashboard"]) revalidatePath(path);
  return { success: (data as { duplicate: boolean }).duplicate ? "mv.duplicate" : "mv.recorded" };
}

export async function reverseMovementAction(movementId: string, _: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(rolesFor("inventory.write"));
  if (!g.ok) return { error: g.error };
  const p = reverseSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return invalid(p.error.issues);
  const { error } = await g.supabase.rpc("reverse_movement", { p_movement: movementId, p_reason: p.data.reason, p_key: p.data.key });
  if (error) return { error: mapError(error) };
  for (const path of ["/movements", "/stock-history", "/morning-stock", "/dashboard"]) revalidatePath(path);
  return { success: "mv.reversed" };
}
