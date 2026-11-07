"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/server/services/guard";
import { getSessionContext } from "@/server/services/session";
import { movementError, movementIssues, recordMovementCore, resolveEffectiveAt, reverseMovementCore, toBase, variantUnits } from "@/server/services/movement-submit";
import { repackSchema } from "@/server/validators/movements";
import type { FormState } from "@/server/actions/auth";
import { rolesFor } from "@/server/permissions";

function refresh() {
  for (const path of ["/movements", "/stock-history", "/morning-stock", "/dashboard"]) revalidatePath(path);
}

export async function recordMovementAction(_: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(rolesFor("inventory.write"));
  if (!g.ok) return { error: g.error };
  const ctx = await getSessionContext();
  const r = await recordMovementCore(g, ctx.membership?.timezone ?? "Asia/Colombo", Object.fromEntries(fd));
  if (!r.ok) return r.fieldErrors ? { fieldErrors: r.fieldErrors } : { error: r.error };
  refresh();
  return { success: r.duplicate ? "mv.duplicate" : "mv.recorded" };
}

export async function recordRepackingAction(_: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(rolesFor("inventory.write"));
  if (!g.ok) return { error: g.error };
  const p = repackSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { fieldErrors: movementIssues(p.error.issues) };
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
  if (error) return { error: movementError(error) };
  refresh();
  return { success: (data as { duplicate: boolean }).duplicate ? "mv.duplicate" : "mv.recorded" };
}

export async function reverseMovementAction(movementId: string, _: FormState, fd: FormData): Promise<FormState> {
  const g = await requireRole(rolesFor("inventory.write"));
  if (!g.ok) return { error: g.error };
  const r = await reverseMovementCore(g, movementId, Object.fromEntries(fd));
  if (!r.ok) return r.fieldErrors ? { fieldErrors: r.fieldErrors } : { error: r.error };
  refresh();
  return { success: "mv.reversed" };
}
