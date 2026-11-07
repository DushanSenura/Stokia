import type { CatalogItem } from "@/features/inventory/catalog-types";

export interface CatalogFilter { query: string; category: string; lowOnly: boolean }

/** Search by name, code, SKU or size; narrow by category and by "low stock only". */
export function filterCatalog(items: CatalogItem[], f: CatalogFilter): CatalogItem[] {
  const q = f.query.trim().toLowerCase();
  return items.filter((i) => {
    if (f.category && i.category !== f.category) return false;
    if (f.lowOnly && !i.low) return false;
    if (q && !`${i.productName} ${i.productCode} ${i.sku} ${i.size}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

export interface ProductGroup { key: string; name: string; code: string; category: string | null; items: CatalogItem[]; lowCount: number }

/** One card per product, listing its sizes. Keeps the order the items arrive in (the server sends them sorted by name). */
export function groupByProduct(items: CatalogItem[]): ProductGroup[] {
  const groups = new Map<string, ProductGroup>();
  for (const i of items) {
    const key = `${i.productCode}\u0000${i.productName}`;
    let g = groups.get(key);
    if (!g) { g = { key, name: i.productName, code: i.productCode, category: i.category, items: [], lowCount: 0 }; groups.set(key, g); }
    g.items.push(i);
    if (i.low) g.lowCount++;
  }
  return [...groups.values()];
}

export const categoriesOf = (items: CatalogItem[]): string[] =>
  [...new Set(items.map((i) => i.category).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b));
