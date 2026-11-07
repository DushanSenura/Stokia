import { describe, expect, it } from "vitest";
import { buildEntryDetails, buildPayloadItems, BASE_KEY, evaluateItem, summarize, type EntryItem } from "@/features/inventory/count-entry";
import { addDays, daysBetween, formatBusinessDate, isBusinessDate, priceInstantForSalesDate, salesDateFor } from "@/lib/dates/business";
import { normalizePackagingQuantity } from "@/lib/calculations/packaging";

const bundle = { id: "b", name: "Bundle", parentId: null, factor: 12 };
const item = (over: Partial<EntryItem> = {}): EntryItem => ({
  variantId: "v1", productName: "Chilli", productCode: "CHL", category: null, sizeLabel: "250 g", sku: "CHL-250",
  baseUnit: "packet", units: [bundle], previousBase: "100", sellingPrice: "150", ...over,
});

describe("business dates", () => {
  it("a count on Nov 2 calculates sales for Nov 1 (never Nov 2)", () => {
    expect(salesDateFor("2026-11-02")).toBe("2026-11-01");
    expect(salesDateFor("2026-12-01")).toBe("2026-11-30"); // month boundary (Test G)
    expect(salesDateFor("2027-01-01")).toBe("2026-12-31");
  });
  it("date arithmetic is timezone-proof and handles leap days", () => {
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(daysBetween("2026-10-30", "2026-11-02")).toBe(3);
  });
  it("validates real calendar dates only", () => {
    expect(isBusinessDate("2026-11-02")).toBe(true);
    for (const bad of ["2026-02-31", "2026-13-01", "11/02/2026", "", 5, null]) expect(isBusinessDate(bad)).toBe(false);
  });
  it("formats without timezone drift", () => {
    expect(formatBusinessDate("2026-11-02")).toBe("2 November 2026");
  });
  it("price lookup instant is noon in the shop timezone (Asia/Colombo = UTC+5:30)", () => {
    expect(priceInstantForSalesDate("2026-11-01", "Asia/Colombo").toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });
});

describe("evaluateItem", () => {
  it("Test A: previous 100, now 72 -> sold 28, Rs. 4200.00", () => {
    const s = evaluateItem(item(), { [BASE_KEY]: "72" });
    expect(s).toMatchObject({ kind: "counted", baseQuantity: "72", change: "-28", estimatedValue: "4200.00", flag: null });
    expect(s.kind === "counted" && s.sales).toMatchObject({ status: "calculated", unitsSold: "28" });
  });
  it("Test D: 10 bundles -> 7 bundles + 5 loose, sold 31", () => {
    const s = evaluateItem(item({ previousBase: "120" }), { b: "7", [BASE_KEY]: "5" });
    expect(s).toMatchObject({ baseQuantity: "89", change: "-31" });
    expect(s.kind === "counted" && s.sales).toMatchObject({ unitsSold: "31" });
  });
  it("blank is not counted; explicit 0 is a count (all sold)", () => {
    expect(evaluateItem(item(), {})).toEqual({ kind: "not_counted" });
    expect(evaluateItem(item(), { b: "", [BASE_KEY]: "  " })).toEqual({ kind: "not_counted" });
    const z = evaluateItem(item(), { [BASE_KEY]: "0" });
    expect(z).toMatchObject({ kind: "counted", baseQuantity: "0", estimatedValue: "15000.00" });
  });
  it("Test F: unexpected increase needs review and has no sales value", () => {
    const s = evaluateItem(item({ previousBase: "50" }), { [BASE_KEY]: "80" });
    expect(s).toMatchObject({ kind: "counted", flag: "increase", estimatedValue: null, change: "30" });
    expect(s.kind === "counted" && s.sales).toMatchObject({ status: "needs_review" });
  });
  it("no previous count (first count / new variant): no sales claimed", () => {
    expect(evaluateItem(item({ previousBase: null }), { [BASE_KEY]: "40" })).toMatchObject({ flag: "no_previous", sales: null, estimatedValue: null });
  });
  it("no price -> units but no money", () => {
    expect(evaluateItem(item({ sellingPrice: null }), { [BASE_KEY]: "72" })).toMatchObject({ estimatedValue: null });
  });
  it("surfaces packaging errors", () => {
    expect(evaluateItem(item(), { b: "2.5" })).toEqual({ kind: "error", code: "fractional_package" });
    expect(evaluateItem(item(), { [BASE_KEY]: "-1" })).toEqual({ kind: "error", code: "negative" });
  });
});

describe("summarize / payload / snapshot", () => {
  const items = [item(), item({ variantId: "v2", baseUnit: "bottle", units: [], previousBase: "10", sellingPrice: "200" }), item({ variantId: "v3" }), item({ variantId: "v4", previousBase: "5" })];
  const values = { v1: { [BASE_KEY]: "72" }, v2: { [BASE_KEY]: "4" }, v4: { [BASE_KEY]: "9" } };
  it("counts progress, flags, and keeps units separate while summing money", () => {
    expect(summarize(items, values)).toMatchObject({
      total: 4, counted: 3, notCounted: 1, errors: 0, needsReview: 1,
      estimatedTotal: "5400.00", unitsByBaseUnit: { packet: "28", bottle: "6" },
    });
  });
  it("payload omits blank rows (blank = not counted)", () => {
    expect(buildPayloadItems(items, { v1: { [BASE_KEY]: "72", b: "" }, v3: { b: "" } })).toEqual([{ variantId: "v1", entries: [{ unitId: null, quantity: "72" }] }]);
  });
  it("snapshot records multipliers so history survives packaging changes", () => {
    const n = normalizePackagingQuantity([{ unitId: "b", quantity: "7" }, { unitId: null, quantity: "5" }], [bundle]);
    if (!n.ok) throw new Error("x");
    expect(buildEntryDetails([bundle], "packet", n.lines)).toEqual({
      version: 1, base_unit: "packet",
      entries: [{ unit_id: "b", unit_name: "Bundle", quantity: "7", multiplier: "12" }, { unit_id: null, unit_name: "packet", quantity: "5", multiplier: "1" }],
    });
  });
});

import { describeQuantity, valuesFromLine } from "@/features/inventory/count-entry";
describe("describeQuantity / valuesFromLine", () => {
  it("shows bundles + loose with the total", () => {
    expect(describeQuantity("89", [bundle], "packet")).toBe("7 Bundle + 5 packet (89 packet)");
    expect(describeQuantity("5", [bundle], "packet")).toBe("5 packet");
    expect(describeQuantity("24", [bundle], "packet")).toBe("2 Bundle (24 packet)");
  });
  it("restores a draft from its snapshot", () => {
    const line = { normalized_base_quantity: "89.000", entry_details: { entries: [{ unit_id: "b", quantity: "7" }, { unit_id: null, quantity: "5" }] } };
    expect(valuesFromLine({ units: [bundle] }, line)).toEqual({ b: "7", [BASE_KEY]: "5" });
  });
  it("falls back to base units when a snapshot unit no longer exists", () => {
    const line = { normalized_base_quantity: "89.000", entry_details: { entries: [{ unit_id: "gone", quantity: "7" }] } };
    expect(valuesFromLine({ units: [bundle] }, line)).toEqual({ [BASE_KEY]: "89" });
  });
});

import { movementParts } from "@/features/inventory/count-entry";
describe("entry preview includes recorded movements (same formula as the database)", () => {
  const mvs = { received: "20", returns: "0", damaged: "2", otherOut: "0", adjustments: "0" };
  it("Test C in the preview: 100 + 20 - 2 - 72 = 46", () => {
    const s = evaluateItem(item({ previousBase: "100", movements: mvs }), { [BASE_KEY]: "72" });
    expect(s.kind === "counted" && s.sales).toMatchObject({ status: "calculated", unitsSold: "46" });
    expect(s).toMatchObject({ estimatedValue: "6900.00", change: "-28" });
  });
  it("a delivery explains an increase (Test F no longer needs review)", () => {
    expect(evaluateItem(item({ previousBase: "50", movements: { ...mvs, received: "40", damaged: "0" } }), { [BASE_KEY]: "80" })).toMatchObject({ flag: null, estimatedValue: "1500.00" });
  });
  it("without movements it still flags an unexplained increase", () => {
    expect(evaluateItem(item({ previousBase: "50" }), { [BASE_KEY]: "80" })).toMatchObject({ flag: "increase" });
  });
  it("lists only non-zero movement parts with signs", () => {
    expect(movementParts(mvs)).toEqual([["stock_received", "+20"], ["damaged", "-2"]]);
    expect(movementParts({ received: "0", returns: "3", damaged: "0", otherOut: "1", adjustments: "-4" })).toEqual([["customer_return", "+3"], ["supplier_return", "-1"], ["manual_adjustment", "-4"]]);
    expect(movementParts(undefined)).toEqual([]);
  });
});
