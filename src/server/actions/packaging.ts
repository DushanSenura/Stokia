"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { FormState } from "@/server/actions/auth";
import { resolveUnits, type DefinitionError, type PackUnit } from "@/lib/calculations/packaging";
import { getVariantPackaging, toPackUnit } from "@/server/repositories/packaging";
import { mapDbError, requireRole } from "@/server/services/guard";
import { packagingUnitSchema } from "@/server/validators/packaging";
import type { MessageKey } from "@/i18n";
import { rolesFor } from "@/server/permissions";
import { getSessionContext } from "@/server/services/session";
import { localDateTimeToInstant, isBusinessDate } from "@/lib/dates/business";
import { MONEY_RE } from "@/server/validators/catalog";

const defErr = (c: DefinitionError) => `pk.err.${c}` as MessageKey;

/**
 * Validate the whole proposed definition with the shared engine first (friendly, specific errors),
 * then write. The database trigger re-checks everything, so this is UX, not the security boundary.
 */
async function save(variantId: string, unitId: string | null, fd: FormData): Promise<FormState> {
  const g = await requireRole(rolesFor("catalog.write"));
  if (!g.ok) return { error: g.error };
  const parsed = packagingUnitSchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) {
    const fieldErrors: Record<string, MessageKey> = {};
    for (const i of parsed.error.issues) fieldErrors[String(i.path[0])] ??= i.message as MessageKey;
    return { fieldErrors };
  }
  const { name, parent_unit_id: parent, conversion_factor } = parsed.data;

  const current = await getVariantPackaging(variantId);
  if (!current) return { error: "error.notFoundTitle" };

  const id = unitId ?? randomUUID();
  const proposed: PackUnit[] = [
    ...current.units.filter((u) => u.id !== id).map(toPackUnit),
    { id, name, parentId: parent ?? null, factor: conversion_factor, isActive: true },
  ];
  const check = resolveUnits(proposed, current.variant.base_inventory_unit);
  if (!check.ok) {
    const field = check.code === "invalid_factor" ? "conversion_factor" : check.code.includes("name") ? "name" : "parent_unit_id";
    return { fieldErrors: { [field]: defErr(check.code) } };
  }

  const row = { name, parent_unit_id: parent ?? null, conversion_factor };
  const { error } = unitId
    ? await g.supabase.from("packaging_units").update(row).eq("id", unitId).eq("variant_id", variantId)
    : await g.supabase.from("packaging_units").insert({ ...row, variant_id: variantId, base_unit_multiplier: 1 }); // multiplier is derived by the DB trigger
  if (error) return { error: mapDbError(error) };
  revalidatePath(`/packaging/${variantId}`); revalidatePath("/packaging");
  return { success: "common.saved" };
}

export async function createPackagingUnitAction(variantId: string, _: FormState, fd: FormData) {
  return save(variantId, null, fd);
}
export async function updatePackagingUnitAction(variantId: string, unitId: string, _: FormState, fd: FormData) {
  return save(variantId, unitId, fd);
}

/** Units are deactivated, never deleted, so past records stay interpretable. Failures are reported, not swallowed. */
// React appends the previous form state as the final argument; it is intentionally unused.
export async function setPackagingUnitActiveAction(variantId: string, unitId: string, active: boolean, _: FormState): Promise<FormState> {
  const g = await requireRole(rolesFor("catalog.write"));
  if (!g.ok) return { error: g.error };
  const { error } = await g.supabase.from("packaging_units").update({ is_active: active }).eq("id", unitId).eq("variant_id", variantId);
  if (error) return { error: mapDbError(error) };
  revalidatePath(`/packaging/${variantId}`); revalidatePath("/packaging");
  return {};
}

/**
 * What a unit is FOR: counted in stock counts, sold to customers, or both (a carton is often only counted and received; boxes and
 * single items are sold). Prices and past records are untouched: switching "sold" off keeps the price history.
 */
export async function updatePackagingUseAction(variantId: string, unitId: string, _: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(rolesFor("catalog.write"));
  if (!g.ok) return { error: g.error };
  const sold = fd.get("can_be_sold") === "on";
  const counted = fd.get("can_be_counted") === "on";
  if (!sold && !counted) return { error: "pk.err.useNone" };
  const { error } = await g.supabase.from("packaging_units").update({ can_be_sold: sold, can_be_counted: counted }).eq("id", unitId).eq("variant_id", variantId);
  if (error) return { error: mapDbError(error) };
  revalidatePath(`/packaging/${variantId}`); revalidatePath("/packaging"); revalidatePath("/morning-stock");
  return { success: "common.saved" };
}

/** A new selling price for a SELLABLE packaging unit, from a date on. The old period is closed, never edited or deleted. */
export async function setPackagingPriceAction(variantId: string, unitId: string, _: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(rolesFor("catalog.write"));
  if (!g.ok) return { error: g.error };
  const amount = String(fd.get("amount") ?? "").trim();
  if (!MONEY_RE.test(amount)) return { fieldErrors: { amount: "pk.err.priceAmount" } };

  let from = new Date();
  const day = String(fd.get("effective_from") ?? "").trim();
  if (day) {
    const ctx = await getSessionContext();
    const at = isBusinessDate(day) ? localDateTimeToInstant(`${day}T00:00`, ctx.membership?.timezone ?? "Asia/Colombo") : null;
    if (!at) return { fieldErrors: { effective_from: "pk.err.priceDate" } };
    from = at;
  }
  const { error } = await g.supabase.rpc("set_packaging_price", { p_unit: unitId, p_amount: Number(amount), p_effective_from: from.toISOString() });
  if (error) {
    if (/NOT_SELLABLE/.test(error.message ?? "")) return { error: "pk.price.needsSold" };
    if (/PRICE_PERIOD_CONFLICT/.test(error.message ?? "")) return { fieldErrors: { effective_from: "pk.price.conflict" } };
    return { error: mapDbError(error) };
  }
  revalidatePath(`/packaging/${variantId}`); revalidatePath("/reports"); revalidatePath("/dashboard");
  return { success: "pk.price.saved" };
}

/** Whether the base unit (the one you count in, e.g. "piece") is itself sold. Its price is the variant's own selling price. */
export async function setBaseUnitSellableAction(variantId: string, _: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(rolesFor("catalog.write"));
  if (!g.ok) return { error: g.error };
  const { error } = await g.supabase.from("product_variants").update({ base_unit_sellable: fd.get("base_unit_sellable") === "on" }).eq("id", variantId);
  if (error) return { error: mapDbError(error) };
  revalidatePath(`/packaging/${variantId}`);
  return { success: "common.saved" };
}
