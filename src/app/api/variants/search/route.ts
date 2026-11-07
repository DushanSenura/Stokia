import { NextResponse, type NextRequest } from "next/server";
import { sizeLabel } from "@/lib/formatting/units";
import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/server/services/session";

export interface VariantHit {
  id: string; label: string; sku: string; baseUnit: string;
  units: { id: string; name: string; multiplier: string }[];
}

const clean = (s: string) => s.replace(/[,()%*_\\"']/g, " ").trim().slice(0, 60);

/** Type-ahead product picker for the movement forms. RLS scopes results to the caller's shop; active items only. */
export async function GET(request: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx.user || !ctx.membership) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const term = clean(request.nextUrl.searchParams.get("q") ?? "");
  if (term.length < 1) return NextResponse.json({ hits: [] satisfies VariantHit[] });

  const supabase = await createClient();
  const { data: prods } = await supabase.from("products").select("id").eq("is_active", true).or(`name.ilike.%${term}%,product_code.ilike.%${term}%`).limit(100);
  const ids = (prods ?? []).map((p) => p.id);
  const parts = [`sku.ilike.%${term}%`, `barcode.ilike.%${term}%`];
  if (ids.length) parts.push(`product_id.in.(${ids.join(",")})`);

  const { data } = await supabase.from("product_variants")
    .select("id,sku,size_value,size_unit,base_inventory_unit,products!inner(name,is_active),packaging_units(id,name,base_unit_multiplier,is_active)")
    .eq("is_active", true).eq("products.is_active", true).or(parts.join(",")).order("sku").limit(15);

  const hits: VariantHit[] = ((data ?? []) as unknown as {
    id: string; sku: string; size_value: string | null; size_unit: string | null; base_inventory_unit: string;
    products: { name: string }; packaging_units: { id: string; name: string; base_unit_multiplier: string; is_active: boolean }[];
  }[]).map((v) => ({
    id: v.id, sku: v.sku, baseUnit: v.base_inventory_unit,
    label: `${v.products.name} ${sizeLabel(v.size_value, v.size_unit)}`.trim(),
    units: v.packaging_units.filter((u) => u.is_active).map((u) => ({ id: u.id, name: u.name, multiplier: String(Number(u.base_unit_multiplier)) })),
  }));
  return NextResponse.json({ hits }, { headers: { "Cache-Control": "no-store" } });
}
