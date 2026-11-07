import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import type { MessageKey } from "@/i18n";
import { getSessionContext, type Role } from "./session";

export type Guard =
  | { ok: true; userId: string; shopId: string; role: Role; supabase: Awaited<ReturnType<typeof createClient>> }
  | { ok: false; error: MessageKey };

/**
 * Server-side authorization for every mutation. The database (RLS / SECURITY DEFINER checks)
 * enforces the same rule again; this gives a friendly error instead of a raw policy failure.
 */
export async function requireRole(allowed: Role[]): Promise<Guard> {
  if (!isSupabaseConfigured()) return { ok: false, error: "error.supabaseMissing" };
  const ctx = await getSessionContext();
  if (!ctx.user) return { ok: false, error: "auth.error.notSignedIn" };
  if (!ctx.membership || !allowed.includes(ctx.membership.role)) return { ok: false, error: "error.forbidden" };
  return { ok: true, userId: ctx.user.id, shopId: ctx.membership.shopId, role: ctx.membership.role, supabase: await createClient() };
}

/** Map Postgres/PostgREST errors to translatable messages without leaking internals. */
export function mapDbError(err: { code?: string; message?: string; details?: string } | null): MessageKey {
  if (!err) return "auth.error.generic";
  const text = `${err.message ?? ""} ${err.details ?? ""}`;
  if (err.code === "23505") {
    if (/packaging_variant_name_uq/.test(text)) return "pk.err.duplicate_name";
    if (/sku/i.test(text)) return "cat.error.duplicateSku";
    if (/barcode/i.test(text)) return "cat.error.duplicateBarcode";
    if (/categories/i.test(text)) return "cat.error.duplicateCategory";
    return "cat.error.duplicateCode";
  }
  if (err.code === "42501" || /FORBIDDEN/.test(text)) return "error.forbidden";
  if (/PRICE_PERIOD_CONFLICT/.test(text)) return "cat.error.priceConflict";
  const pk: [RegExp, MessageKey][] = [
    [/CIRCULAR_PACKAGING|SELF_PARENT/, "pk.err.cycle"], [/PACKAGING_TOO_DEEP/, "pk.err.too_deep"],
    [/MULTIPLIER_TOO_LARGE/, "pk.err.multiplier_too_large"], [/NAME_EQUALS_BASE/, "pk.err.name_equals_base"],
    [/PARENT_OTHER_VARIANT/, "pk.err.other_variant"], [/INACTIVE_PARENT/, "pk.err.inactive_parent"],
    [/PACKAGING_IN_USE/, "pk.err.in_use"], [/HAS_ACTIVE_CHILDREN/, "pk.err.has_children"],
    [/packaging_variant_name_uq/, "pk.err.duplicate_name"],
  ];
  for (const [re, key] of pk) if (re.test(text)) return key;
  if (err.code === "23514") return "pk.err.invalid_factor";
  return "auth.error.generic";
}
