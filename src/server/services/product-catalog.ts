import "server-only";
import Decimal from "decimal.js";
import type { EntryItem } from "@/features/inventory/count-entry";
import type { CatalogItem, ProductCatalog } from "@/features/inventory/catalog-types";
import { describeUnit } from "@/lib/calculations/packaging";
import { addDays } from "@/lib/dates/business";
import { shopLocalDate } from "@/lib/dates/format";
import type { createClient } from "@/lib/supabase/server";
import { fetchAll, loadEntryItems } from "@/server/repositories/inventory";

type Supa = Awaited<ReturnType<typeof createClient>>;

export type { CatalogItem, ProductCatalog };

/**
 * The active products with their prices, packaging and last counted quantity: read-only, for the phone's Products tab. Reuses the
 * morning-count loader (asked "as of tomorrow", so the previous confirmed count is the latest one and the price is today's), so
 * the phone and the web agree on prices, packaging and what "previous count" means.
 */
export async function loadProductCatalog(supabase: Supa, shop: { shopId: string; timezone: string }, now = new Date()): Promise<ProductCatalog> {
  const today = shopLocalDate(now, shop.timezone);
  const { items, previous, truncated } = await loadEntryItems(supabase, shop.shopId, addDays(today, 1), shop.timezone);

  const levels = new Map(
    (await fetchAll<{ id: string; low_stock_threshold: string | null }>((f, t) =>
      supabase.from("product_variants").select("id,low_stock_threshold").eq("shop_id", shop.shopId).eq("is_active", true).order("id").range(f, t) as unknown as PromiseLike<{ data: { id: string; low_stock_threshold: string | null }[] | null; error: unknown }>,
    )).map((r) => [r.id, r.low_stock_threshold ?? "0"]),
  );

  return {
    asOf: previous?.business_date ?? null,
    truncated,
    items: items.map((i) => catalogItemFrom(i, levels.get(i.variantId) ?? "0")),
  };
}

/**
 * One product size as the phone lists it. "Low" is only ever said about a product that WAS counted and has a low-stock level set:
 * a product nobody counted is not "low", it is "not counted", and a level of 0 means none was chosen.
 */
export function catalogItemFrom(i: EntryItem, lowStockLevel: string): CatalogItem {
  return {
    variantId: i.variantId, productName: i.productName, productCode: i.productCode, category: i.category, size: i.sizeLabel, sku: i.sku, baseUnit: i.baseUnit,
    sellingPrice: i.sellingPrice, lastCounted: i.previousBase, lowStockLevel,
    low: i.previousBase !== null && new Decimal(lowStockLevel).gt(0) && new Decimal(i.previousBase).lte(lowStockLevel),
    packaging: i.units.map((u) => describeUnit(u, i.units, i.baseUnit)).filter((s): s is string => !!s),
  };
}
