"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { CountConflict, CountInput, CountResult } from "@/features/inventory/count-types";
import { countFailure, countInputSchema, saveCountDraftCore, submitCountCore, variantLabels } from "@/server/services/count-submit";
import { requireRole } from "@/server/services/guard";
import type { MessageKey } from "@/i18n";
import { rolesFor } from "@/server/permissions";

// The shapes live in a pure module so the phone app shares them; re-exported here for the web code that imports them.
export type { CountConflict, CountInput, CountResult };

export async function saveDraftAction(raw: CountInput): Promise<CountResult> {
  const g = await requireRole(rolesFor("inventory.write"));
  if (!g.ok) return { ok: false, error: g.error };
  const parsed = countInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "ms.err.INVALID_PAYLOAD" };
  // No revalidatePath here: refreshing the page mid-typing would remount the form and drop focus.
  return saveCountDraftCore(g, parsed.data);
}

/** Names for the conflict screen: the server's copy may hold products this device did not count. */
export async function variantLabelsAction(ids: string[]): Promise<Record<string, string>> {
  const g = await requireRole(rolesFor("inventory.write"));
  if (!g.ok) return {};
  return variantLabels(g, ids);
}

/**
 * Save the entries and confirm them in ONE database transaction, keyed by `idempotencyKey` (see `submitCountCore`).
 *
 * No revalidatePath here. Calling it inside a Server Action makes Next re-render the page the person is on, and for
 * /morning-stock that replaces the form (and its success screen) with the static "confirmed" page the instant the count is
 * saved. The dashboard and history pages are dynamic and read fresh data on every visit, so there is nothing to invalidate.
 */
export async function confirmCountAction(raw: CountInput, ackMissing: boolean, idempotencyKey: string, device?: string): Promise<CountResult> {
  const g = await requireRole(rolesFor("inventory.write"));
  if (!g.ok) return { ok: false, error: g.error };
  return submitCountCore(g, raw, ackMissing, idempotencyKey, device);
}

export async function discardDraftAction(sessionId: string, revision: number): Promise<{ ok: boolean; error?: MessageKey }> {
  const g = await requireRole(rolesFor("inventory.write"));
  if (!g.ok) return { ok: false, error: g.error };
  if (!z.string().uuid().safeParse(sessionId).success) return { ok: false, error: "auth.error.generic" };
  const { error } = await g.supabase.rpc("discard_count_draft", { p_session: sessionId, p_revision: revision });
  if (error) { const f = countFailure(error); return { ok: false, error: f.ok ? undefined : f.error }; }
  revalidatePath("/morning-stock");
  return { ok: true };
}
