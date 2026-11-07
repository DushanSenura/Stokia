/**
 * CSV catalog import: parsing + validation only (no database access), so it is fully testable.
 * One CSV row = one variant. Rows sharing a product_code form one product.
 */
import { parseCsv } from "@/lib/exports/csv";
import { moneySchema, productSchema, variantSchema } from "@/server/validators/catalog";

export const IMPORT_COLUMNS = [
  "product_code", "product_name", "category", "description", "sku",
  "size_value", "size_unit", "base_inventory_unit", "low_stock_threshold",
  "selling_price_lkr", "purchase_cost_lkr", "barcode",
] as const;

export const MAX_IMPORT_ROWS = 2000;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export interface ImportVariant {
  sku: string;
  size_value?: string;
  size_unit?: string;
  base_inventory_unit: string;
  low_stock_threshold: string;
  barcode?: string;
  selling_price?: string;
  purchase_cost?: string;
}
export interface ImportProduct {
  product_code: string;
  name: string;
  category?: string;
  description?: string;
  variants: ImportVariant[];
}
export interface ImportError { row: number; message: string }
export interface ImportResult { products: ImportProduct[]; errors: ImportError[]; rowCount: number }

export function validateImport(text: string): ImportResult {
  const errors: ImportError[] = [];
  const table = parseCsv(text);
  if (table.length === 0) return { products: [], errors: [{ row: 0, message: "The file is empty." }], rowCount: 0 };

  const header = table[0].map((h) => h.trim().toLowerCase());
  const missing = ["product_code", "product_name", "sku"].filter((c) => !header.includes(c));
  if (missing.length) return { products: [], errors: [{ row: 1, message: `Missing required column(s): ${missing.join(", ")}` }], rowCount: 0 };
  const unknown = header.filter((h) => !(IMPORT_COLUMNS as readonly string[]).includes(h));
  if (unknown.length) errors.push({ row: 1, message: `Unknown column(s) ignored: ${unknown.join(", ")}` });

  const body = table.slice(1);
  if (body.length > MAX_IMPORT_ROWS) return { products: [], errors: [{ row: 0, message: `Too many rows (max ${MAX_IMPORT_ROWS}).` }], rowCount: body.length };

  const products = new Map<string, ImportProduct>();
  const seenSkus = new Map<string, number>();
  let hardErrors = 0;

  body.forEach((cells, idx) => {
    const row = idx + 2; // 1-based, header is row 1
    const get = (c: string) => (cells[header.indexOf(c)] ?? "").trim();
    const fail = (message: string) => { errors.push({ row, message }); hardErrors++; };

    const p = productSchema.safeParse({ name: get("product_name"), product_code: get("product_code"), description: get("description") });
    if (!p.success) return fail(`Product: ${p.error.issues[0].message.replace("cat.error.", "invalid ")}`);

    const v = variantSchema.safeParse({
      sku: get("sku"), size_value: get("size_value"), size_unit: get("size_unit").toLowerCase(),
      base_inventory_unit: get("base_inventory_unit") || "packet",
      low_stock_threshold: get("low_stock_threshold"), barcode: get("barcode"),
    });
    if (!v.success) return fail(`Variant: ${v.error.issues[0].message.replace("cat.error.", "invalid ")}`);

    const skuKey = v.data.sku.toLowerCase();
    if (seenSkus.has(skuKey)) return fail(`Duplicate SKU "${v.data.sku}" (also on row ${seenSkus.get(skuKey)}).`);
    seenSkus.set(skuKey, row);

    const prices: { selling?: string; cost?: string } = {};
    for (const [col, key] of [["selling_price_lkr", "selling"], ["purchase_cost_lkr", "cost"]] as const) {
      const raw = get(col);
      if (!raw) continue;
      if (!moneySchema.safeParse(raw).success) return fail(`${col} must be a non-negative amount with up to 2 decimals.`);
      prices[key] = raw;
    }

    const codeKey = p.data.product_code.toLowerCase();
    const existing = products.get(codeKey);
    if (existing && existing.name !== p.data.name) return fail(`Product code "${p.data.product_code}" is used with a different name.`);
    const prod = existing ?? {
      product_code: p.data.product_code, name: p.data.name, category: get("category") || undefined,
      description: p.data.description, variants: [],
    };
    prod.variants.push({
      sku: v.data.sku, size_value: v.data.size_value, size_unit: v.data.size_unit,
      base_inventory_unit: v.data.base_inventory_unit, low_stock_threshold: v.data.low_stock_threshold,
      barcode: v.data.barcode, selling_price: prices.selling, purchase_cost: prices.cost,
    });
    products.set(codeKey, prod);
  });

  return { products: hardErrors ? [] : [...products.values()], errors, rowCount: body.length };
}

export const hasBlockingErrors = (r: ImportResult) => r.products.length === 0 || r.errors.some((e) => !e.message.startsWith("Unknown column"));
