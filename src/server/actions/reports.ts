"use server";

import { revalidatePath } from "next/cache";
import { isMonth } from "@/lib/dates/business";
import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/server/services/session";

/**
 * Logs that a report was printed (PDF/Excel/CSV exports are logged by their own route). Same audit trail:
 * who, when, and the data version they saw, so the report can later say whether its figures changed since.
 */
export async function recordPrintAction(month: string): Promise<{ ok: boolean }> {
  const ctx = await getSessionContext();
  if (!ctx.user || !ctx.membership || !isMonth(month)) return { ok: false };
  const supabase = await createClient();
  const { data: fp, error } = await supabase.rpc("monthly_report_fingerprint", { p_shop: ctx.membership.shopId, p_month: month });
  if (error) return { ok: false };
  const { error: e2 } = await supabase.rpc("record_report_export", { p_shop: ctx.membership.shopId, p_month: month, p_format: "print", p_fingerprint: String(fp), p_totals: null });
  if (e2) return { ok: false };
  revalidatePath("/reports"); revalidatePath(`/reports/${month}`);
  return { ok: true };
}
