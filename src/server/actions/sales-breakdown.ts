"use server";

import type { BreakdownDay, BreakdownDraft, BreakdownHistoryEntry, BreakdownResponse } from "@/features/sales/breakdown-types";
import { can, rolesFor } from "@/server/permissions";
import { requireRole } from "@/server/services/guard";
import { clearBreakdownCore, loadBreakdownDay, loadBreakdownHistory, saveBreakdownCore } from "@/server/services/sales-breakdown";
import { getSessionContext } from "@/server/services/session";
import type { MessageKey } from "@/i18n";

/** Server Actions behind the optional "sales breakdown" panel (morning stock success screen and stock history). */

/**
 * No `revalidatePath` anywhere in this file, on purpose. In Next, revalidating inside a Server Action re-renders the page the person is ON,
 * and this panel lives inside the morning-stock success screen: the re-render would replace that screen (and the panel) with the static
 * "already confirmed" page. The dashboard, reports, analytics and history pages are dynamic and read fresh data on every visit, and the
 * history page refreshes itself from the browser after a change (see HistorySalesBreakdown).
 */

export type LoadDayResult = { ok: true; day: BreakdownDay; canWrite: boolean } | { ok: false; error: MessageKey };

/** Any member may look; only people who may count may change anything. */
export async function loadBreakdownDayAction(date: string): Promise<LoadDayResult> {
  const g = await requireRole(rolesFor("reports.export"));
  if (!g.ok) return { ok: false, error: g.error };
  const ctx = await getSessionContext();
  try {
    return { ok: true, day: await loadBreakdownDay(g, ctx.membership?.timezone ?? "Asia/Colombo", date), canWrite: can(g.role, "inventory.write") };
  } catch {
    return { ok: false, error: "sb.loadFailed" };
  }
}

/** `key` is one idempotency key per distinct request: a double click or a retry cannot record it twice. */
export async function saveBreakdownAction(draft: BreakdownDraft, key: string): Promise<BreakdownResponse> {
  const g = await requireRole(rolesFor("inventory.write"));
  if (!g.ok) return { ok: false, error: g.error };
  const ctx = await getSessionContext();
  try {
    const r = await saveBreakdownCore(g, ctx.membership?.timezone ?? "Asia/Colombo", draft, key);
    return r;
  } catch {
    return { ok: false, error: "auth.error.generic" };
  }
}

export async function clearBreakdownAction(input: { variantId: string; date: string; reason: string }, key: string): Promise<BreakdownResponse> {
  const g = await requireRole(rolesFor("inventory.write"));
  if (!g.ok) return { ok: false, error: g.error };
  try {
    return await clearBreakdownCore(g, input, key);
  } catch {
    return { ok: false, error: "auth.error.generic" };
  }
}

export async function loadBreakdownHistoryAction(variantId: string, date: string): Promise<{ ok: true; history: BreakdownHistoryEntry[] } | { ok: false; error: MessageKey }> {
  const g = await requireRole(rolesFor("reports.export"));
  if (!g.ok) return { ok: false, error: g.error };
  try {
    return { ok: true, history: await loadBreakdownHistory(g, variantId, date) };
  } catch {
    return { ok: false, error: "sb.loadFailed" };
  }
}
