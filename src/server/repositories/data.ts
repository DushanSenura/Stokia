import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { BackupSource, BackupTable } from "@/features/data/backup";

type Supa = Awaited<ReturnType<typeof createClient>>;

export interface HealthCheck { key: string; severity: "error" | "warning"; count: number; sample: string[] }
export interface HealthReport { checked_at: string; from: string; days: number; errors: number; warnings: number; checks: HealthCheck[] }

/** Owner only: the database refuses everyone else. */
export async function runHealthCheck(supabase: Supa, shopId: string, days: number): Promise<{ report: HealthReport | null; error: string | null }> {
  const { data, error } = await supabase.rpc("data_health_check", { p_shop: shopId, p_days: days });
  return { report: (data as HealthReport | null) ?? null, error: error?.message ?? null };
}

/** Pages one table through the signed-in user's session, so row-level security scopes every row. */
export function backupSource(supabase: Supa, shopId: string): BackupSource {
  return {
    async page(t: BackupTable, offset: number, size: number) {
      const base = supabase.from(t.name).select("*");
      const scoped = t.scope ? base.eq(t.scope, shopId) : base;
      const { data, error } = await scoped.order(t.order, { ascending: true }).range(offset, offset + size - 1);
      if (error) throw new Error(`${t.name}: ${error.message}`);
      return (data ?? []) as Record<string, unknown>[];
    },
  };
}

export async function recordBackup(supabase: Supa, shopId: string, counts: Record<string, number>, checksum: string) {
  await supabase.rpc("record_backup_export", { p_shop: shopId, p_counts: counts, p_checksum: checksum });
}
