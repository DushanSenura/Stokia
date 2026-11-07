import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { MovementType } from "@/lib/calculations/reconcile";
import { sizeLabel } from "@/lib/formatting/units";
import { displayNames } from "./inventory";

type Supa = Awaited<ReturnType<typeof createClient>>;
export const MOVEMENTS_PAGE_SIZE = 25;

export interface MovementListRow {
  id: string; type: MovementType; input_quantity: string; normalized_base_quantity: string; effective_at: string; created_at: string;
  reason: string | null; reference: string | null; supplier: string | null; purchase_cost_lkr: string | null; created_by: string;
  reversed_movement_id: string | null; group_id: string | null;
  packaging_units: { name: string } | null;
  product_variants: { sku: string; size_value: string | null; size_unit: string | null; base_inventory_unit: string; products: { name: string } | null } | null;
}

export interface MovementFilters { from?: Date; to?: Date; type?: MovementType; page?: number }

export async function listMovements(supabase: Supa, f: MovementFilters) {
  const page = Math.max(1, f.page ?? 1);
  let req = supabase.from("stock_movements")
    .select("id,type,input_quantity,normalized_base_quantity,effective_at,created_at,reason,reference,supplier,purchase_cost_lkr,created_by,reversed_movement_id,group_id,packaging_units(name),product_variants(sku,size_value,size_unit,base_inventory_unit,products(name))", { count: "exact" });
  if (f.type) req = req.eq("type", f.type);
  if (f.from) req = req.gte("effective_at", f.from.toISOString());
  if (f.to) req = req.lt("effective_at", f.to.toISOString());
  const { data, count, error } = await req.order("effective_at", { ascending: false }).range((page - 1) * MOVEMENTS_PAGE_SIZE, page * MOVEMENTS_PAGE_SIZE - 1);
  const rows = (data ?? []) as unknown as MovementListRow[];

  const ids = rows.map((r) => r.id);
  const { data: reversals } = ids.length ? await supabase.from("stock_movements").select("reversed_movement_id").in("reversed_movement_id", ids) : { data: [] };
  const reversed = new Set((reversals ?? []).map((r) => r.reversed_movement_id as string));
  const people = await displayNames(supabase, rows.map((r) => r.created_by));
  return { rows, total: count ?? 0, page, error, reversed, people };
}

export const variantLabel = (v: MovementListRow["product_variants"]) => (v ? `${v.products?.name ?? ""} ${sizeLabel(v.size_value, v.size_unit)}`.trim() : "");
