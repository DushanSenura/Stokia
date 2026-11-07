import { describe, expect, it } from "vitest";
import { priceAt, type PricePeriod } from "@/lib/calculations/pricing";
import { sizeLabel } from "@/lib/formatting/units";
import { detectImageType, productSchema, variantSchema, priceSchema } from "@/server/validators/catalog";
import { validateImport } from "@/features/products/import";

describe("priceAt (Test I: historical prices preserved)", () => {
  const h: PricePeriod[] = [
    { price_type: "selling", amount_lkr: "150.00", effective_from: "2026-01-01T00:00:00Z", effective_to: "2026-11-02T00:00:00Z" },
    { price_type: "selling", amount_lkr: "165.00", effective_from: "2026-11-02T00:00:00Z", effective_to: null },
    { price_type: "purchase_cost", amount_lkr: "120.00", effective_from: "2026-01-01T00:00:00Z", effective_to: null },
  ];
  it("uses the price in force on the sales date, not the latest", () => {
    expect(priceAt(h, "selling", "2026-11-01T10:00:00Z")?.amount_lkr).toBe("150.00");
    expect(priceAt(h, "selling", "2026-11-05T10:00:00Z")?.amount_lkr).toBe("165.00");
  });
  it("period boundary is half-open", () => expect(priceAt(h, "selling", "2026-11-02T00:00:00Z")?.amount_lkr).toBe("165.00"));
  it("returns null when no price existed yet", () => expect(priceAt(h, "selling", "2025-12-31T00:00:00Z")).toBeNull());
  it("keeps price types separate", () => expect(priceAt(h, "purchase_cost", "2026-11-05T00:00:00Z")?.amount_lkr).toBe("120.00"));
});

describe("validators", () => {
  it("product requires name and a safe code", () => {
    expect(productSchema.safeParse({ name: "Rice", product_code: "RICE-01", category_id: "", description: "" }).success).toBe(true);
    expect(productSchema.safeParse({ name: "", product_code: "X" }).success).toBe(false);
    expect(productSchema.safeParse({ name: "R", product_code: "bad code!" }).success).toBe(false);
  });
  it("variant: size value and unit come together and are positive", () => {
    const base = { sku: "RICE-1KG", base_inventory_unit: "packet" };
    expect(variantSchema.safeParse({ ...base, size_value: "1", size_unit: "kg" }).success).toBe(true);
    expect(variantSchema.safeParse({ ...base, size_value: "1" }).success).toBe(false);
    expect(variantSchema.safeParse({ ...base, size_unit: "kg" }).success).toBe(false);
    expect(variantSchema.safeParse({ ...base, size_value: "0", size_unit: "kg" }).success).toBe(false);
    expect(variantSchema.safeParse({ ...base, size_value: "1", size_unit: "stone" }).success).toBe(false);
    expect(variantSchema.parse(base).low_stock_threshold).toBe("0");
  });
  it("money: no negatives, no float noise, max 2dp", () => {
    const ok = (a: string) => priceSchema.safeParse({ variant_id: crypto.randomUUID(), price_type: "selling", amount: a }).success;
    expect([ok("150"), ok("150.5"), ok("0.05")]).toEqual([true, true, true]);
    expect([ok("-1"), ok("1.234"), ok("1e3"), ok("abc"), ok("")]).toEqual([false, false, false, false, false]);
  });
  it("detects real image types by magic bytes", () => {
    expect(detectImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(detectImageType(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });
  it("formats size labels", () => {
    expect(sizeLabel("250.000", "g")).toBe("250 g");
    expect(sizeLabel(1, "l")).toBe("1 L");
    expect(sizeLabel(null, null)).toBe("");
  });
});

const HEAD = "product_code,product_name,category,sku,size_value,size_unit,base_inventory_unit,selling_price_lkr,purchase_cost_lkr";
describe("catalog import", () => {
  it("groups variant rows into products", () => {
    const r = validateImport(`${HEAD}\nCHL,Chilli Powder,Spices,CHL-100,100,g,packet,150,110\nCHL,Chilli Powder,Spices,CHL-250,250,g,packet,350,260`);
    expect(r.errors).toEqual([]);
    expect(r.products).toHaveLength(1);
    expect(r.products[0].variants.map((v) => v.sku)).toEqual(["CHL-100", "CHL-250"]);
    expect(r.products[0].variants[0]).toMatchObject({ selling_price: "150", purchase_cost: "110" });
  });
  it("reports row-numbered errors and blocks the whole import", () => {
    const r = validateImport(`${HEAD}\nA,Alpha,,A-1,1,kg,packet,10,\nB,Beta,,A-1,1,kg,packet,10,\nC,Gamma,,C-1,1,kg,packet,-5,`);
    expect(r.products).toEqual([]);
    expect(r.errors.map((e) => e.row)).toEqual([3, 4]);
    expect(r.errors[0].message).toMatch(/Duplicate SKU/);
  });
  it("rejects a file missing required columns", () => {
    expect(validateImport("name,sku\nx,y").errors[0].message).toMatch(/product_code/);
  });
  it("rejects conflicting product names for one code", () => {
    const r = validateImport(`${HEAD}\nA,Alpha,,A-1,,,packet,,\nA,Other,,A-2,,,packet,,`);
    expect(r.errors[0].message).toMatch(/different name/);
  });
  it("empty file", () => expect(validateImport("").errors).toHaveLength(1));
});
