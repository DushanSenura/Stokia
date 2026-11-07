import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { CategoryRow, PriceRow, ProductListRow, ProductRow, VariantRow } from "@/types/catalog";

export const PAGE_SIZE = 20;
export type ProductSort = "name" | "code" | "updated";
export type StatusFilter = "active" | "archived" | "all";

export interface ProductQuery {
  q?: string; categoryId?: string; sort?: ProductSort; status?: StatusFilter; page?: number;
}

/** Strip characters that have meaning inside PostgREST filter strings / LIKE patterns. */
const cleanTerm = (s: string) => s.replace(/[,()%*_\\"']/g, " ").trim().slice(0, 60);

export async function listCategories(): Promise<CategoryRow[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("categories").select("id,name,description,parent_id").order("name");
  return (data ?? []) as CategoryRow[];
}

/** Server-side filtering, sorting and pagination so large catalogs stay fast. */
export async function listProducts(query: ProductQuery) {
  const supabase = await createClient();
  const page = Math.max(1, query.page ?? 1);
  const from = (page - 1) * PAGE_SIZE;

  let req = supabase
    .from("products")
    .select("id,name,product_code,description,image_url,is_active,category_id,created_at,updated_at,categories(name),product_variants(id,sku,size_value,size_unit,is_active)", { count: "exact" });

  const status = query.status ?? "active";
  if (status !== "all") req = req.eq("is_active", status === "active");
  if (query.categoryId) req = req.eq("category_id", query.categoryId);

  const term = query.q ? cleanTerm(query.q) : "";
  if (term) {
    // Match product name/code, or any variant SKU/barcode belonging to the product.
    const { data: hits } = await supabase.from("product_variants").select("product_id").or(`sku.ilike.%${term}%,barcode.ilike.%${term}%`).limit(200);
    const ids = [...new Set((hits ?? []).map((h) => h.product_id))];
    const parts = [`name.ilike.%${term}%`, `product_code.ilike.%${term}%`];
    if (ids.length) parts.push(`id.in.(${ids.join(",")})`);
    req = req.or(parts.join(","));
  }

  const sort = query.sort ?? "name";
  req = sort === "updated" ? req.order("updated_at", { ascending: false }) : req.order(sort === "code" ? "product_code" : "name", { ascending: true });

  const { data, count, error } = await req.range(from, from + PAGE_SIZE - 1);
  return { rows: (data ?? []) as unknown as ProductListRow[], total: count ?? 0, page, pageSize: PAGE_SIZE, error };
}

export async function getProductDetail(id: string) {
  const supabase = await createClient();
  const { data: product } = await supabase.from("products").select("*").eq("id", id).maybeSingle();
  if (!product) return null;
  const { data: variants } = await supabase.from("product_variants").select("*").eq("product_id", id).order("created_at");
  const vIds = (variants ?? []).map((v) => v.id);
  const { data: prices } = vIds.length
    ? await supabase.from("product_price_history").select("*").in("variant_id", vIds).order("effective_from", { ascending: false })
    : { data: [] };
  return { product: product as ProductRow, variants: (variants ?? []) as VariantRow[], prices: (prices ?? []) as PriceRow[] };
}

/** Everything needed for a catalog export, in one pass (capped to protect memory). */
export async function exportCatalogRows() {
  const supabase = await createClient();
  const { data: products } = await supabase
    .from("products")
    .select("id,name,product_code,description,is_active,categories(name),product_variants(id,sku,size_value,size_unit,base_inventory_unit,low_stock_threshold,barcode,is_active)")
    .order("name")
    .limit(5000);
  const ids = (products ?? []).flatMap((p) => p.product_variants.map((v: { id: string }) => v.id));
  // Chunked: a long `in (...)` list would overflow the request URL.
  const prices: { variant_id: string; price_type: string; amount_lkr: string }[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data } = await supabase.from("product_price_history").select("variant_id,price_type,amount_lkr").is("effective_to", null).in("variant_id", ids.slice(i, i + 150));
    prices.push(...(data ?? []));
  }
  return { products: products ?? [], prices };
}
