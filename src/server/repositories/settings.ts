import "server-only";
import { createClient } from "@/lib/supabase/server";
import { toPackUnit, type PackagingUnitRow } from "./packaging";
import type { PackUnit } from "@/lib/calculations/packaging";
import { sizeLabel } from "@/lib/formatting/units";
import type { Role } from "@/server/permissions";

type Supa = Awaited<ReturnType<typeof createClient>>;

export interface Profile { id: string; display_name: string; email: string | null; preferred_language: "en" | "si" }

export async function profilesByIds(supabase: Supa, ids: (string | null)[]): Promise<Map<string, Profile>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, Profile>();
  for (let i = 0; i < uniq.length; i += 100) {
    const { data } = await supabase.from("user_profiles").select("id,display_name,email,preferred_language").in("id", uniq.slice(i, i + 100));
    for (const p of (data ?? []) as Profile[]) out.set(p.id, p);
  }
  return out;
}

export async function getProfile(supabase: Supa, userId: string): Promise<Profile | null> {
  return (await profilesByIds(supabase, [userId])).get(userId) ?? null;
}

/* ---------------- team ---------------- */

export interface TeamMember { id: string; userId: string; role: Role; status: "invited" | "active" | "suspended"; createdAt: string; name: string; email: string | null }

export async function listTeam(supabase: Supa, shopId: string): Promise<TeamMember[]> {
  const { data } = await supabase.from("shop_memberships").select("id,user_id,role,status,created_at").eq("shop_id", shopId).order("created_at");
  const rows = (data ?? []) as { id: string; user_id: string; role: Role; status: TeamMember["status"]; created_at: string }[];
  const profiles = await profilesByIds(supabase, rows.map((r) => r.user_id));
  return rows.map((r) => ({
    id: r.id, userId: r.user_id, role: r.role, status: r.status, createdAt: r.created_at,
    name: profiles.get(r.user_id)?.display_name ?? "", email: profiles.get(r.user_id)?.email ?? null,
  }));
}

/* ---------------- shop settings ---------------- */

export async function getShopSettings(supabase: Supa, shopId: string) {
  const [{ data: shop }, { data: locked }] = await Promise.all([
    supabase.from("shops").select("name,timezone,currency,settings").eq("id", shopId).maybeSingle(),
    supabase.from("stock_count_sessions").select("id").eq("shop_id", shopId).neq("status", "draft").limit(1).maybeSingle(),
  ]);
  const s = (shop?.settings ?? {}) as { valuation_policy?: string };
  return {
    name: (shop?.name as string | undefined) ?? "", timezone: (shop?.timezone as string | undefined) ?? "Asia/Colombo", currency: "LKR" as const,
    valuationPolicy: s.valuation_policy === "latest_cost" ? ("latest_cost" as const) : ("cost_at_count" as const),
    timezoneLocked: !!locked,
  };
}

/* ---------------- corrections ---------------- */

export interface CorrectionRow {
  id: string; sessionId: string; variantId: string; businessDate: string; status: "pending" | "approved" | "rejected" | "cancelled";
  oldQuantity: string | null; newQuantity: string; reason: string; createdBy: string; createdAt: string;
  decidedBy: string | null; decidedAt: string | null; decisionNote: string | null;
  product: string; size: string; unit: string; sku: string;
  requester: string; decider: string | null;
}

export async function listCorrections(supabase: Supa, opts: { sessionId?: string; status?: CorrectionRow["status"]; limit?: number } = {}): Promise<CorrectionRow[]> {
  let req = supabase.from("stock_count_corrections")
    .select("id,session_id,variant_id,old_quantity,new_quantity,reason,created_by,created_at,status,decided_by,decided_at,decision_note,stock_count_sessions(business_date),product_variants(sku,size_value,size_unit,base_inventory_unit,products(name))")
    .order("created_at", { ascending: false }).limit(opts.limit ?? 100);
  if (opts.sessionId) req = req.eq("session_id", opts.sessionId);
  if (opts.status) req = req.eq("status", opts.status);
  const { data } = await req;
  const rows = (data ?? []) as unknown as {
    id: string; session_id: string; variant_id: string; old_quantity: string | null; new_quantity: string; reason: string; created_by: string; created_at: string;
    status: CorrectionRow["status"]; decided_by: string | null; decided_at: string | null; decision_note: string | null;
    stock_count_sessions: { business_date: string } | null;
    product_variants: { sku: string; size_value: string | null; size_unit: string | null; base_inventory_unit: string; products: { name: string } | null } | null;
  }[];
  const people = await profilesByIds(supabase, rows.flatMap((r) => [r.created_by, r.decided_by]));
  return rows.map((r) => ({
    id: r.id, sessionId: r.session_id, variantId: r.variant_id, businessDate: r.stock_count_sessions?.business_date ?? "", status: r.status,
    oldQuantity: r.old_quantity === null ? null : String(Number(r.old_quantity)), newQuantity: String(Number(r.new_quantity)), reason: r.reason,
    createdBy: r.created_by, createdAt: r.created_at, decidedBy: r.decided_by, decidedAt: r.decided_at, decisionNote: r.decision_note,
    product: r.product_variants?.products?.name ?? "", size: sizeLabel(r.product_variants?.size_value ?? null, r.product_variants?.size_unit ?? null),
    unit: r.product_variants?.base_inventory_unit ?? "", sku: r.product_variants?.sku ?? "",
    requester: people.get(r.created_by)?.display_name ?? "", decider: r.decided_by ? (people.get(r.decided_by)?.display_name ?? "") : null,
  }));
}

export async function getUnitsByVariant(supabase: Supa, variantIds: string[]): Promise<Map<string, PackUnit[]>> {
  const out = new Map<string, PackUnit[]>();
  for (let i = 0; i < variantIds.length; i += 100) {
    const { data } = await supabase.from("packaging_units").select("id,variant_id,name,parent_unit_id,conversion_factor,base_unit_multiplier,is_active").in("variant_id", variantIds.slice(i, i + 100)).eq("is_active", true);
    for (const u of (data ?? []) as PackagingUnitRow[]) out.set(u.variant_id, [...(out.get(u.variant_id) ?? []), toPackUnit(u)]);
  }
  return out;
}

/* ---------------- audit log ---------------- */

export const AUDIT_PAGE_SIZE = 25;
export interface AuditFilters { from?: Date; to?: Date; action?: string; entity?: string; user?: string; page?: number }
export interface AuditRow {
  id: string; createdAt: string; userId: string | null; user: string; action: string; entityType: string; entityId: string | null;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
}

export async function listAudit(supabase: Supa, shopId: string, f: AuditFilters) {
  const page = Math.max(1, f.page ?? 1);
  let req = supabase.from("audit_logs").select("id,created_at,user_id,action,entity_type,entity_id,before_data,after_data", { count: "exact" }).eq("shop_id", shopId);
  if (f.from) req = req.gte("created_at", f.from.toISOString());
  if (f.to) req = req.lt("created_at", f.to.toISOString());
  if (f.action) req = req.eq("action", f.action);
  if (f.entity) req = req.eq("entity_type", f.entity);
  if (f.user) req = req.eq("user_id", f.user);
  const { data, count, error } = await req.order("created_at", { ascending: false }).range((page - 1) * AUDIT_PAGE_SIZE, page * AUDIT_PAGE_SIZE - 1);
  const rows = (data ?? []) as { id: string; created_at: string; user_id: string | null; action: string; entity_type: string; entity_id: string | null; before_data: Record<string, unknown> | null; after_data: Record<string, unknown> | null }[];
  const people = await profilesByIds(supabase, rows.map((r) => r.user_id));
  const out: AuditRow[] = rows.map((r) => ({
    id: r.id, createdAt: r.created_at, userId: r.user_id, user: r.user_id ? (people.get(r.user_id)?.display_name ?? "") : "", action: r.action, entityType: r.entity_type,
    entityId: r.entity_id, before: r.before_data, after: r.after_data,
  }));
  return { rows: out, total: count ?? 0, page, error };
}

/** Distinct actions / entity types present in this shop's log, for the filter controls. */
export async function auditFacets(supabase: Supa, shopId: string) {
  const { data } = await supabase.from("audit_logs").select("action,entity_type").eq("shop_id", shopId).order("created_at", { ascending: false }).limit(2000);
  const rows = (data ?? []) as { action: string; entity_type: string }[];
  return { actions: [...new Set(rows.map((r) => r.action))].sort(), entities: [...new Set(rows.map((r) => r.entity_type))].sort() };
}
