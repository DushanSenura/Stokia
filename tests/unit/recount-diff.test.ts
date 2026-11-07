import { describe, expect, it } from "vitest";
import { BASE_KEY, type EntryItem } from "@/features/inventory/count-entry";
import { reviewRecount } from "@/features/inventory/recount-diff";

const oil = {
  variantId: "v1", productName: "Oil", productCode: "O1", sku: "", sizeLabel: "1 L", category: null, baseUnit: "bottle", units: [],
  previousBase: null, sellingPrice: null,
} as EntryItem;

describe("reviewRecount", () => {
  it("lists only the products whose figure really changed", () => {
    const r = reviewRecount([oil], { v1: { [BASE_KEY]: "60" } }, { v1: "70" });
    expect(r.errors).toEqual([]);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ variantId: "v1", was: "70", now: "60" });
  });

  it("ignores an unchanged figure and a blank one (blank is never zero)", () => {
    expect(reviewRecount([oil], { v1: { [BASE_KEY]: "70" } }, { v1: "70" }).changes).toEqual([]);
    expect(reviewRecount([oil], { v1: { [BASE_KEY]: "" } }, { v1: "70" }).changes).toEqual([]);
  });

  it("flags an entry that cannot be a quantity", () => {
    expect(reviewRecount([oil], { v1: { [BASE_KEY]: "-3" } }, { v1: "70" }).errors).toEqual(["v1"]);
  });
});
