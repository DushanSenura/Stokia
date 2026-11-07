// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CatalogItem } from "@/features/inventory/catalog-types";
import { PHONE_MOVEMENT_TYPES } from "@/features/movements/phone-types";
import { baseQuantity, blankForm, buildDraft, effectOf, problemsIn, signOf, unitOptions, type FormState } from "../../mobile/src/features/movements/form";

const BUNDLE = "00000000-0000-4000-8000-0000000000b1";
const CARTON = "00000000-0000-4000-8000-0000000000b2";
const item = (over: Partial<CatalogItem> = {}): CatalogItem => ({
  variantId: "00000000-0000-4000-8000-000000000001", productName: "Chilli Powder", productCode: "CHL", category: null, size: "250 g", sku: "CHL-250", baseUnit: "packet",
  sellingPrice: "150.00", lastCounted: "30", lowStockLevel: "0", low: false, packaging: [],
  units: [{ id: BUNDLE, name: "Bundle", parentId: null, factor: "12" }, { id: CARTON, name: "Carton", parentId: BUNDLE, factor: "4" }], ...over,
});
const form = (over: Partial<FormState> = {}): FormState => ({ ...blankForm(), item: item(), unitId: BUNDLE, quantity: "3", reason: "Weekly delivery", ...over });

describe("units to choose from", () => {
  it("lists each packaging unit, then loose items in the base unit", () => {
    expect(unitOptions(item())).toEqual([{ id: BUNDLE, label: "Bundle" }, { id: CARTON, label: "Carton" }, { id: null, label: "packet" }]);
    expect(unitOptions(item({ units: [] }))).toEqual([{ id: null, label: "packet" }]);
  });
});

describe("quantity in the base unit (the shared packaging engine)", () => {
  it("3 bundles of 12 is 36 packets; a carton of 4 bundles is 48", () => {
    expect(baseQuantity(item(), BUNDLE, "3")).toBe("36");
    expect(baseQuantity(item(), CARTON, "2")).toBe("96");
    expect(baseQuantity(item(), null, "5")).toBe("5");
  });
  it("loose items may have decimals (a weight), bundles must be whole", () => {
    expect(baseQuantity(item(), null, "2.5")).toBe("2.5");
    expect(baseQuantity(item(), BUNDLE, "2.5")).toBeNull();
  });
  it("refuses zero, negatives, junk, too many decimals, and a unit that is not this product's", () => {
    for (const q of ["", "0", "-3", "abc", "1.2345", "1e9", "3 ", " "]) expect(baseQuantity(item(), null, q) !== null, JSON.stringify(q)).toBe(q === "3 ");
    expect(baseQuantity(item(), "00000000-0000-4000-8000-0000000000ff", "3")).toBeNull();
  });
});

describe("which way a movement goes (derived from the shared rule, never repeated)", () => {
  it("adds, removes, or lets the person choose", () => {
    expect(signOf("stock_received")).toBe("add");
    expect(signOf("customer_return")).toBe("add");
    for (const t of ["damaged", "expired", "discarded", "supplier_return"] as const) expect(signOf(t), t).toBe("remove");
    expect(signOf("manual_adjustment")).toBe("choose");
  });
  it("covers every type the phone offers", () => {
    for (const t of PHONE_MOVEMENT_TYPES) expect(["add", "remove", "choose"]).toContain(signOf(t));
  });
  it("the signed effect follows, and an incomplete form has none yet", () => {
    expect(effectOf("damaged", undefined, "5")).toBe("-5");
    expect(effectOf("stock_received", undefined, "36")).toBe("36");
    expect(effectOf("manual_adjustment", "out", "4")).toBe("-4");
    expect(effectOf("manual_adjustment", "in", "4")).toBe("4");
    expect(effectOf("manual_adjustment", undefined, "4")).toBeNull();
    expect(effectOf("stock_received", undefined, null)).toBeNull();
  });
});

describe("what still needs fixing", () => {
  it("a complete form has no problems", () => expect(problemsIn(form())).toEqual({}));
  it("needs a product", () => expect(problemsIn(form({ item: null })).variant_id).toBe("mv.form.pick"));
  it("needs a usable quantity", () => {
    expect(problemsIn(form({ quantity: "" })).quantity).toBe("mv.err.quantity");
    expect(problemsIn(form({ quantity: "2.5" })).quantity).toBe("mv.err.quantity"); // 2.5 bundles
    expect(problemsIn(form({ unitId: null, quantity: "2.5" }))).toEqual({});
  });
  it("needs a reason OR a reference", () => {
    expect(problemsIn(form({ reason: "", reference: "" })).reason).toBe("mv.err.reason");
    expect(problemsIn(form({ reason: "   ", reference: " " })).reason).toBe("mv.err.reason");
    expect(problemsIn(form({ reason: "", reference: "INV-1" }))).toEqual({});
  });
  it("a manual adjustment needs a direction; other types do not", () => {
    expect(problemsIn(form({ type: "manual_adjustment" })).direction).toBe("mv.err.direction");
    expect(problemsIn(form({ type: "manual_adjustment", direction: "out" }))).toEqual({});
    expect(problemsIn(form({ type: "damaged" })).direction).toBeUndefined();
  });
  it("a cost, if given, must be money (and is only checked where it applies)", () => {
    expect(problemsIn(form({ cost: "120.50" }))).toEqual({});
    expect(problemsIn(form({ cost: "12.345" })).cost).toBe("cat.error.money");
    expect(problemsIn(form({ cost: "abc" })).cost).toBe("cat.error.money");
    expect(problemsIn(form({ type: "damaged", cost: "abc" })).cost).toBeUndefined();
  });
});

describe("what is sent", () => {
  it("trims text and leaves empty optional fields out", () => {
    expect(buildDraft(form({ reason: "  Weekly delivery  ", reference: "  ", supplier: "", cost: "" }))).toEqual({
      variantId: "00000000-0000-4000-8000-000000000001", type: "stock_received", unitId: BUNDLE, quantity: "3", when: "now", reason: "Weekly delivery",
    });
  });
  it("a received movement may carry a supplier and a cost", () => {
    expect(buildDraft(form({ supplier: " Perera Traders ", cost: " 120.50 ", reference: "INV-9" }))).toMatchObject({ supplier: "Perera Traders", cost: "120.50", reference: "INV-9" });
  });
  it("a supplier and a cost are never sent for a type they do not belong to", () => {
    const d = buildDraft(form({ type: "damaged", supplier: "x", cost: "5" }));
    expect("supplier" in d).toBe(false);
    expect("cost" in d).toBe(false);
  });
  it("a direction is sent only when the person had to choose one", () => {
    expect("direction" in buildDraft(form({ type: "damaged", direction: "in" }))).toBe(false);
    expect(buildDraft(form({ type: "manual_adjustment", direction: "out" })).direction).toBe("out");
  });
  it("keeps 'before today's count' explicit", () => {
    expect(buildDraft(form({ when: "before_count" })).when).toBe("before_count");
  });
  it("cannot be built without a product", () => {
    expect(() => buildDraft(form({ item: null }))).toThrow("NO_PRODUCT");
  });
});
