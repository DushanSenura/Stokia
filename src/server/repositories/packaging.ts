import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { PackUnit } from "@/lib/calculations/packaging";
import { PAGE_SIZE } from "./catalog";

export interface PackagingUnitRow {
  id: string; variant_id: string; name: string; parent_unit_id: string | null;
  conversion_factor: string; base_unit_multiplier: string; is_active: boolean;
  /** Present where the query asks for them (the packaging setup page). Missing means the defaults: counted, not sold. */
  can_be_sold?: boolean; can_be_counted?: boolean;
}

export interface PackagingPriceRow { id: string; unit_id: string; amount_lkr: string; effective_from: string; effective_to: string | null }

/** DB row -> engine unit (single mapping so every caller shares the same interpretation). */
export const toPackUnit = (r: PackagingUnitRow): PackUnit => ({
  id: r.id, name: r.name, parentId: r.parent_unit_id, factor: r.conversion_factor, isActive: r.is_active, countable: r.can_be_counted !== false,
});

const cleanTerm = (s: string) => s.replace(/[,()%*_\\"']/g, " ").trim().slice(0, 60);

export interface PackagingListRow {
  id: string; sku: string; size_value: string | null; size_unit: string | null; base_inventory_unit: string;
  products: { name: string; product_code: string } | null;
  packaging_units: PackagingUnitRow[];
}

export async function listVariantsForPackaging(opts: { q?: string; page?: number }) {
  const supabase = await createClient();
  const page = Math.max(1, opts.page ?? 1);
  const from = (page - 1) * PAGE_SIZE;

  let req = supabase
    .from("product_variants")
    .select("id,sku,size_value,size_unit,base_inventory_unit,products!inner(name,product_code,is_active),packaging_units(id,variant_id,name,parent_unit_id,conversion_factor,base_unit_multiplier,is_active)", { count: "exact" })
    .eq("is_active", true)
    .eq("products.is_active", true);

  const term = opts.q ? cleanTerm(opts.q) : "";
  if (term) {
    const { data: hits } = await supabase.from("products").select("id").or(`name.ilike.%${term}%,product_code.ilike.%${term}%`).limit(200);
    const ids = (hits ?? []).map((h) => h.id);
    const parts = [`sku.ilike.%${term}%`, `barcode.ilike.%${term}%`];
    if (ids.length) parts.push(`product_id.in.(${ids.join(",")})`);
    req = req.or(parts.join(","));
  }

  const { data, count, error } = await req.order("sku").range(from, from + PAGE_SIZE - 1);
  return { rows: (data ?? []) as unknown as PackagingListRow[], total: count ?? 0, page, error };
}

export async function getVariantPackaging(variantId: string) {
  const supabase = await createClient();
  const { data: variant } = await supabase
    .from("product_variants")
    .select("id,sku,size_value,size_unit,base_inventory_unit,base_unit_sellable,is_active,product_id,products(id,name,product_code)")
    .eq("id", variantId)
    .maybeSingle();
  if (!variant) return null;
  const { data: units } = await supabase
    .from("packaging_units")
    .select("id,variant_id,name,parent_unit_id,conversion_factor,base_unit_multiplier,is_active,can_be_sold,can_be_counted")
    .eq("variant_id", variantId)
    .order("base_unit_multiplier");
  const unitIds = (units ?? []).map((u) => u.id as string);
  const [{ data: prices }, { data: basePrice }] = await Promise.all([
    unitIds.length
      ? supabase.from("packaging_unit_price_history").select("id,unit_id,amount_lkr,effective_from,effective_to").in("unit_id", unitIds).order("effective_from", { ascending: false })
      : Promise.resolve({ data: [] as PackagingPriceRow[] }),
    supabase.from("product_price_history").select("amount_lkr,effective_from").eq("variant_id", variantId).eq("price_type", "selling").is("effective_to", null).maybeSingle(),
  ]);
  const { data: used } = await supabase.from("stock_movements").select("input_unit_id").eq("variant_id", variantId).not("input_unit_id", "is", null).limit(1000);
  return {
    variant: variant as unknown as {
      id: string; sku: string; size_value: string | null; size_unit: string | null; base_inventory_unit: string; base_unit_sellable: boolean;
      is_active: boolean; product_id: string; products: { id: string; name: string; product_code: string } | null;
    },
    units: (units ?? []) as PackagingUnitRow[],
    prices: (prices ?? []) as PackagingPriceRow[],
    basePrice: (basePrice as { amount_lkr: string; effective_from: string } | null) ?? null,
    lockedUnitIds: new Set((used ?? []).map((u) => u.input_unit_id as string)),
  };
}
