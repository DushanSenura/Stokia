"use server";

import { revalidatePath } from "next/cache";
import { buildEntryDetails } from "@/features/inventory/count-entry";
import { normalizePackagingQuantity, type PackUnit } from "@/lib/calculations/packaging";
import { rolesFor } from "@/server/permissions";
import { toPackUnit, type PackagingUnitRow } from "@/server/repositories/packaging";
import { requireRole } from "@/server/services/guard";
import { correctionRequestSchema, decisionSchema } from "@/server/validators/settings";
import type { FormState } from "@/server/actions/auth";
import type { MessageKey } from "@/i18n";

const DB_CODES = ["NOT_FOUND", "NOT_CONFIRMED", "REASON_REQUIRED", "INVALID_QUANTITY", "INVALID_VARIANT", "NO_CHANGE", "ALREADY_PENDING", "NOT_PENDING", "NOTE_REQUIRED", "STALE_CORRECTION"] as const;

function mapError(err: { message?: string } | null): MessageKey {
  const text = err?.message ?? "";
  if (/FORBIDDEN/.test(text)) return "error.forbidden";
  const code = DB_CODES.find((c) => text.includes(c));
  return code ? (`cor.err.${code}` as MessageKey) : "auth.error.generic";
}

const refresh = (sessionId?: string) => {
  for (const p of ["/settings/corrections", "/dashboard", "/analytics", "/reports", "/stock-history"]) revalidatePath(p);
  if (sessionId) revalidatePath(`/stock-history/${sessionId}`);
};

/**
 * Ask for a count to be corrected. The new quantity is entered the way counts are (bundles + loose) and recomputed here from the
 * variant's stored packaging. Stock managers file a request for the owner to approve; an owner's request is approved and applied at once.
 */
export async function requestCorrectionAction(sessionId: string, variantId: string, _: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(rolesFor("corrections.request"));
  if (!g.ok) return { error: g.error };
  const parsed = correctionRequestSchema.safeParse({ reason: fd.get("reason") });
  if (!parsed.success) return { fieldErrors: { reason: parsed.error.issues[0].message as MessageKey } };

  const { data } = await g.supabase.from("product_variants")
    .select("base_inventory_unit,packaging_units(id,variant_id,name,parent_unit_id,conversion_factor,base_unit_multiplier,is_active)")
    .eq("id", variantId).eq("shop_id", g.shopId).maybeSingle();
  if (!data) return { error: "cor.err.INVALID_VARIANT" };
  const v = data as unknown as { base_inventory_unit: string; packaging_units: PackagingUnitRow[] };
  const units: PackUnit[] = v.packaging_units.filter((u) => u.is_active).map(toPackUnit);

  // fields are named q:<unitId> (or q:base); anything else is ignored
  const entries = [...fd.entries()].filter(([k]) => k.startsWith("q:")).map(([k, val]) => ({ unitId: k === "q:base" ? null : k.slice(2), quantity: String(val) }));
  const norm = normalizePackagingQuantity(entries, units, v.base_inventory_unit);
  if (!norm.ok) return { fieldErrors: { quantity: `pk.err.${norm.code}` as MessageKey } };
  if (!norm.counted) return { fieldErrors: { quantity: "cor.err.quantity" } }; // a correction needs a real number; type 0 for an empty shelf

  const { data: res, error } = await g.supabase.rpc("request_count_correction", {
    p_session: sessionId, p_variant: variantId, p_new_qty: Number(norm.baseQuantity),
    p_details: buildEntryDetails(units, v.base_inventory_unit, norm.lines), p_reason: parsed.data.reason,
  });
  if (error) return { error: mapError(error) };
  refresh(sessionId);
  return { success: (res as { applied: boolean }).applied ? "cor.applied" : "cor.requested" };
}

export async function decideCorrectionAction(correctionId: string, approve: boolean, _: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(rolesFor("corrections.decide"));
  if (!g.ok) return { error: g.error };
  const parsed = decisionSchema.safeParse({ note: fd.get("note") });
  if (!parsed.success) return { fieldErrors: { note: "cor.err.NOTE_REQUIRED" } };
  const { error } = await g.supabase.rpc("decide_count_correction", { p_id: correctionId, p_approve: approve, p_note: parsed.data.note ?? null });
  if (error) return { error: mapError(error), ...(/NOTE_REQUIRED/.test(error.message ?? "") ? { fieldErrors: { note: "cor.err.NOTE_REQUIRED" as MessageKey } } : {}) };
  refresh();
  return { success: approve ? "cor.approved" : "cor.rejected" };
}

export async function cancelCorrectionAction(correctionId: string, _: FormState): Promise<FormState> {
  const g = await requireRole(rolesFor("corrections.request"));
  if (!g.ok) return { error: g.error };
  const { error } = await g.supabase.rpc("cancel_count_correction", { p_id: correctionId });
  if (error) return { error: mapError(error) };
  refresh();
  return { success: "cor.cancelled" };
}
