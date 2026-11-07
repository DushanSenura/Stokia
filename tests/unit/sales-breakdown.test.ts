import { describe, expect, it } from "vitest";
import { normalizePackagingQuantity, type PackUnit } from "@/lib/calculations/packaging";
import { computeBreakdown, estimateWithoutBreakdown, individualUnitsSold, type BreakdownInput, type SellableUnit } from "@/lib/calculations/sales-breakdown";

/**
 * Choco: base unit Piece (Rs. 30). 1 Box = 20 Pieces (Rs. 550, sold). 1 Carton = 10 Boxes = 200 Pieces (counted, NOT sold).
 */
const BOX = "box-id", CARTON = "carton-id";
const packUnits: PackUnit[] = [
  { id: BOX, name: "Box", parentId: null, factor: "20" },
  { id: CARTON, name: "Carton", parentId: BOX, factor: "10" },
];
const units: SellableUnit[] = [
  { id: BOX, name: "Box", multiplier: "20", canBeSold: true, isActive: true, price: "550" },
  { id: CARTON, name: "Carton", multiplier: "200", canBeSold: false, isActive: true, price: null },
];
const base = { name: "piece", sellable: true, price: "30" };
const run = (inferred: string | null, lines: [string, string][], over: Partial<BreakdownInput> = {}) =>
  computeBreakdown({ inferred, lines: lines.map(([unitId, quantity]) => ({ unitId, quantity })), units, base, ...over });

describe("the Choco packaging hierarchy (through the existing conversion engine)", () => {
  const toBase = (entries: { unitId: string | null; quantity: string }[]) => {
    const r = normalizePackagingQuantity(entries, packUnits, "piece");
    if (!r.ok || !r.counted) throw new Error("not normalised");
    return r.baseQuantity;
  };

  it("1 box = 20 pieces", () => expect(toBase([{ unitId: BOX, quantity: "1" }])).toBe("20"));
  it("1 carton = 10 boxes = 200 pieces", () => expect(toBase([{ unitId: CARTON, quantity: "1" }])).toBe("200"));
  it("2 cartons + 4 boxes + 8 pieces = 488 pieces", () => {
    expect(toBase([{ unitId: CARTON, quantity: "2" }, { unitId: BOX, quantity: "4" }, { unitId: null, quantity: "8" }])).toBe("488");
  });
});

describe("sales of 145 pieces with 4 complete boxes", () => {
  it("individual pieces = 145 - (4 x 20) = 65", () => {
    expect(individualUnitsSold("145", [{ quantity: "4", multiplier: "20" }])).toBe("65");
  });

  it("estimated revenue = 4 x Rs. 550 + 65 x Rs. 30 = Rs. 4,150.00", () => {
    const r = run("145", [[BOX, "4"]]);
    expect(r).toMatchObject({ ok: true, amount: "4150.00", packaged: "80", remainder: "65" });
    if (!r.ok) return;
    expect(r.lines).toEqual([
      { unitId: BOX, isBaseUnit: false, name: "Box", quantity: "4", baseUnits: "80", unitPrice: "550", amount: "2200.00" },
      { unitId: null, isBaseUnit: true, name: "piece", quantity: "65", baseUnits: "65", unitPrice: "30", amount: "1950.00" },
    ]);
  });

  it("without the breakdown the day stays at the inferred total x piece price: Rs. 4,350.00 (an estimate with unknown packaging)", () => {
    expect(estimateWithoutBreakdown("145", "30")).toBe("4350.00");
  });

  it("zero boxes is a KNOWN fact (everything sold loose), different from not knowing", () => {
    expect(run("145", [[BOX, "0"]])).toMatchObject({ ok: true, amount: "4350.00", packaged: "0", remainder: "145" });
    expect(run("145", [])).toMatchObject({ ok: true, packaged: "0", remainder: "145" });
  });

  it("all boxes, no loose pieces: 7 boxes = 140 pieces, 5 loose; exactly 145 is allowed with 145 = 7 x 20 + 5", () => {
    expect(run("145", [[BOX, "7"]])).toMatchObject({ ok: true, remainder: "5", amount: String(7 * 550 + 5 * 30) + ".00" });
    expect(run("140", [[BOX, "7"]])).toMatchObject({ ok: true, remainder: "0", amount: "3850.00" });
  });
});

describe("rejections (the same ones the database makes)", () => {
  it("box sales above the inferred total: 8 boxes = 160 > 145", () => expect(run("145", [[BOX, "8"]])).toEqual({ ok: false, error: "EXCEEDS_INFERRED" }));
  it("negative box sales", () => expect(run("145", [[BOX, "-1"]])).toEqual({ ok: false, error: "NEGATIVE_QUANTITY", unitId: BOX }));
  it("fractional package counts", () => expect(run("145", [[BOX, "2.5"]])).toEqual({ ok: false, error: "FRACTIONAL_PACKAGE", unitId: BOX }));
  it("a unit that is stock-only (Carton)", () => expect(run("500", [[CARTON, "1"]])).toEqual({ ok: false, error: "NOT_SELLABLE", unitId: CARTON }));
  it("an unknown unit", () => expect(run("145", [["nope", "1"]])).toEqual({ ok: false, error: "INVALID_UNIT", unitId: "nope" }));
  it("the same unit twice", () => expect(run("145", [[BOX, "1"], [BOX, "1"]])).toEqual({ ok: false, error: "DUPLICATE_UNIT", unitId: BOX }));
  it("nothing to split when the day has no inferred figure", () => {
    expect(run(null, [[BOX, "1"]])).toEqual({ ok: false, error: "NOT_CALCULATED" });
    expect(run("-3", [[BOX, "1"]])).toEqual({ ok: false, error: "NOT_CALCULATED" });
  });
  it("garbage quantities", () => {
    expect(run("145", [[BOX, "abc"]])).toMatchObject({ ok: false, error: "INVALID_LINE" });
    expect(run("145", [[BOX, ""]])).toMatchObject({ ok: false });
  });
  it("a deactivated unit is refused when recording, but accepted when re-checking an old record", () => {
    const gone = units.map((u) => (u.id === BOX ? { ...u, isActive: false } : u));
    expect(run("145", [[BOX, "4"]], { units: gone, requireActive: true })).toEqual({ ok: false, error: "INVALID_UNIT", unitId: BOX });
    expect(run("145", [[BOX, "4"]], { units: gone, requireActive: false })).toMatchObject({ ok: true, amount: "4150.00" });
  });
});

describe("historical prices", () => {
  it("uses the prices it is GIVEN (the ones in force on the sales date), so a later price change cannot alter an old day", () => {
    const old = run("145", [[BOX, "4"]]);
    const later = run("145", [[BOX, "4"]], { units: units.map((u) => (u.id === BOX ? { ...u, price: "600" } : u)), base: { ...base, price: "35" } });
    expect(old).toMatchObject({ amount: "4150.00" });
    expect(later).toMatchObject({ amount: String(4 * 600 + 65 * 35) + ".00" });
  });

  it("a sellable unit with no price on that date is refused", () => {
    expect(run("145", [[BOX, "4"]], { units: units.map((u) => (u.id === BOX ? { ...u, price: null } : u)) })).toEqual({ ok: false, error: "PRICE_MISSING", unitId: BOX });
  });

  it("a missing base price is only a problem when loose pieces remain", () => {
    const noBase = { ...base, price: null };
    expect(run("145", [[BOX, "4"]], { base: noBase })).toEqual({ ok: false, error: "PRICE_MISSING" });
    expect(run("140", [[BOX, "7"]], { base: noBase })).toMatchObject({ ok: true, amount: "3850.00", remainder: "0" });
  });

  it("a base unit that is not sold cannot take the remainder", () => {
    expect(run("145", [[BOX, "4"]], { base: { ...base, sellable: false } })).toEqual({ ok: false, error: "BASE_NOT_SELLABLE" });
    expect(run("140", [[BOX, "7"]], { base: { ...base, sellable: false } })).toMatchObject({ ok: true });
  });

  it("no price at all means no estimate, never a zero", () => {
    expect(estimateWithoutBreakdown("145", null)).toBeNull();
    expect(estimateWithoutBreakdown(null, "30")).toBeNull();
  });
});

describe("decimal safety", () => {
  it("fractional base quantities (kilograms) split exactly: 2.5 kg inferred, 1 bag of 1 kg, 1.5 loose", () => {
    const r = computeBreakdown({
      inferred: "2.5", lines: [{ unitId: "bag", quantity: "1" }],
      units: [{ id: "bag", name: "Bag", multiplier: "1", canBeSold: true, price: "900" }], base: { name: "kg", sellable: true, price: "1000" },
    });
    expect(r).toMatchObject({ ok: true, packaged: "1", remainder: "1.5", amount: "2400.00" });
  });

  it("no floating-point drift on awkward prices", () => {
    const r = run("145", [[BOX, "3"]], { units: units.map((u) => (u.id === BOX ? { ...u, price: "0.1" } : u)), base: { ...base, price: "0.2" } });
    expect(r).toMatchObject({ ok: true, amount: "17.30" }); // 3 x 0.10 + 85 x 0.20 = 0.30 + 17.00
  });
});
