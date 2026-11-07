"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { rolesFor } from "@/server/permissions";
import { runHealthCheck, type HealthReport } from "@/server/repositories/data";
import { requireRole } from "@/server/services/guard";
import type { FormState } from "@/server/actions/auth";

export type HealthState = FormState & { report?: HealthReport; repaired?: number };

const daysSchema = z.coerce.number().int().refine((n) => [30, 90, 180, 365].includes(n));

/** Owner only. Reads and compares; changes nothing (the database rolls its trial recalculation back). */
export async function runHealthCheckAction(_: HealthState, fd: FormData): Promise<HealthState> {
  const g = await requireRole(rolesFor("data.manage"));
  if (!g.ok) return { error: g.error };
  const days = daysSchema.safeParse(fd.get("days"));
  if (!days.success) return { fieldErrors: { days: "data.err.range" } };
  const { report, error } = await runHealthCheck(g.supabase, g.shopId, days.data);
  if (error || !report) return { error: /FORBIDDEN/.test(error ?? "") ? "error.forbidden" : "auth.error.generic" };
  return { report };
}

/** Owner only. Recalculates stored sales (history kept, audited), then checks again so the page shows the true result. */
export async function repairSalesAction(_: HealthState, fd: FormData): Promise<HealthState> {
  const g = await requireRole(rolesFor("data.manage"));
  if (!g.ok) return { error: g.error };
  const days = daysSchema.safeParse(fd.get("days"));
  if (!days.success) return { fieldErrors: { days: "data.err.range" } };
  const { data, error } = await g.supabase.rpc("repair_sales", { p_shop: g.shopId, p_days: days.data });
  if (error) return { error: /FORBIDDEN/.test(error.message) ? "error.forbidden" : "auth.error.generic" };
  const after = await runHealthCheck(g.supabase, g.shopId, days.data);
  for (const path of ["/dashboard", "/analytics", "/reports", "/stock-history"]) revalidatePath(path);
  return { report: after.report ?? undefined, repaired: Number((data as { changed?: number } | null)?.changed ?? 0) };
}
