// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { EntryItem } from "@/features/inventory/count-entry";

vi.mock("server-only", () => ({}));
import { catalogItemFrom } from "@/server/services/product-catalog";

const item = (over: Partial<EntryItem> = {}): EntryItem => ({
  variantId: "v1", productName: "Chilli Powder", productCode: "CHL", category: "Spices", sizeLabel: "250 g", sku: "CHL-250", baseUnit: "packet",
  units: [], previousBase: "30", sellingPrice: "150.00", ...over,
});

describe("catalogItemFrom", () => {
  it("passes the product, price and last counted quantity through", () => {
    expect(catalogItemFrom(item(), "0")).toMatchObject({
      variantId: "v1", productName: "Chilli Powder", category: "Spices", size: "250 g", sku: "CHL-250", baseUnit: "packet", sellingPrice: "150.00", lastCounted: "30",
    });
  });

  it("a price that is not set stays null (never shown as 0)", () => {
    expect(catalogItemFrom(item({ sellingPrice: null }), "0").sellingPrice).toBeNull();
  });

  describe("low stock", () => {
    it("is low at or below a level that was set (equal counts as low)", () => {
      expect(catalogItemFrom(item({ previousBase: "10" }), "10").low).toBe(true);
      expect(catalogItemFrom(item({ previousBase: "9.5" }), "10").low).toBe(true);
      expect(catalogItemFrom(item({ previousBase: "0" }), "10").low).toBe(true);
      expect(catalogItemFrom(item({ previousBase: "10.001" }), "10").low).toBe(false);
    });
    it("is never low when no level was chosen (a level of 0 means none)", () => {
      expect(catalogItemFrom(item({ previousBase: "0" }), "0").low).toBe(false);
      expect(catalogItemFrom(item({ previousBase: "0" }), "0.000").low).toBe(false);
    });
    it("is never guessed for a product nobody counted: not counted is not low", () => {
      expect(catalogItemFrom(item({ previousBase: null }), "10")).toMatchObject({ low: false, lastCounted: null });
    });
    it("compares exactly, not in floating point", () => {
      expect(catalogItemFrom(item({ previousBase: "0.3" }), "0.30").low).toBe(true);
      expect(catalogItemFrom(item({ previousBase: "0.1" }), "0.3").low).toBe(true);
    });
  });

  it("describes how the packaging nests, in plain words", () => {
    const units = [
      { id: "b", name: "Bundle", parentId: null, factor: 12 },
      { id: "c", name: "Carton", parentId: "b", factor: 4 },
    ];
    expect(catalogItemFrom(item({ units }), "0").packaging).toEqual(["1 Bundle = 12 packet", "1 Carton = 4 Bundle = 48 packet"]);
    expect(catalogItemFrom(item({ units: [] }), "0").packaging).toEqual([]);
  });

  it("carries the packaging units with their ids, so the phone can enter a quantity in bundles or cartons", () => {
    const units = [{ id: "b", name: "Bundle", parentId: null, factor: 12 }, { id: "c", name: "Carton", parentId: "b", factor: "4" }];
    expect(catalogItemFrom(item({ units }), "0").units).toEqual([
      { id: "b", name: "Bundle", parentId: null, factor: "12" },
      { id: "c", name: "Carton", parentId: "b", factor: "4" },
    ]);
  });

  it("a packaging definition that cannot be resolved is left out rather than shown wrong", () => {
    const broken = [{ id: "a", name: "A", parentId: "a", factor: 2 }]; // a unit that contains itself
    expect(catalogItemFrom(item({ units: broken }), "0").packaging).toEqual([]);
  });
});
