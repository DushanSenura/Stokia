"use server";

import { revalidatePath } from "next/cache";
import type { RecountAnswer } from "@/features/inventory/recount-types";
import { rolesFor } from "@/server/permissions";
import { requireRole } from "@/server/services/guard";
import { cancelRecountCore, decideRecountCore, requestRecountCore, submitRecountCore, type RecountContext } from "@/server/services/recount";
import { getSessionContext } from "@/server/services/session";

/**
 * Server Actions behind "another stock sheet on the same day". Who may do what is decided by the database (and checked again here for a
 * friendly message): stock managers and the owner ask, only the owner decides, only the person who asked can use an approval.
 */
async function context(allowed: ReturnType<typeof rolesFor>): Promise<{ ok: true; ctx: RecountContext } | { ok: false; answer: RecountAnswer }> {
  const g = await requireRole(allowed);
  if (!g.ok) return { ok: false, answer: { ok: false, error: g.error } };
  const s = await getSessionContext();
  return { ok: true, ctx: { supabase: g.supabase, shopId: g.shopId, userId: g.userId, role: g.role, timezone: s.membership?.timezone ?? "Asia/Colombo" } };
}

// These three change what the stock sheet page shows, so the page is refreshed (it is the page the person is on).
export async function requestRecountAction(sessionId: string, reason: string): Promise<RecountAnswer> {
  const c = await context(rolesFor("corrections.request"));
  if (!c.ok) return c.answer;
  const r = await requestRecountCore(c.ctx, sessionId, reason);
  if (r.ok) revalidatePath("/morning-stock");
  return r;
}

export async function decideRecountAction(id: string, approve: boolean, note: string): Promise<RecountAnswer> {
  const c = await context(rolesFor("corrections.decide"));
  if (!c.ok) return c.answer;
  const r = await decideRecountCore(c.ctx, id, approve, note);
  if (r.ok) revalidatePath("/morning-stock");
  return r;
}

export async function cancelRecountAction(id: string): Promise<RecountAnswer> {
  const c = await context(rolesFor("corrections.request"));
  if (!c.ok) return c.answer;
  const r = await cancelRecountCore(c.ctx, id);
  if (r.ok) revalidatePath("/morning-stock");
  return r;
}

/**
 * The recount itself. NO revalidatePath here, on purpose: the person is looking at the sheet's own "updated" screen, and revalidating
 * would replace it with the static "confirmed" page (the same lesson as the count confirmation). The dashboard, reports and history
 * pages read fresh data on every visit.
 */
export async function submitRecountAction(requestId: string, count: unknown, idempotencyKey: string): Promise<RecountAnswer> {
  const c = await context(rolesFor("corrections.request"));
  if (!c.ok) return c.answer;
  try {
    return await submitRecountCore(c.ctx, requestId, count, idempotencyKey);
  } catch {
    return { ok: false, error: "auth.error.generic" };
  }
}
