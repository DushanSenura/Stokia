import { describe, expect, it } from "vitest";
import type { BreakdownItem } from "@/features/sales/breakdown-types";
import { canPressSave, checkClear, checkSave, enteredLines, formUnits, isWholeNumber, previewBreakdown, revenueOf, sameAsRecorded, startingQuantities } from "@/features/sales/breakdown-form";

const BOX = "box-id", TRAY = "tray-id", OLD = "old-id";
const base: BreakdownItem = {
  variantId: "v1", name: "Choco", size: "", sku: "CHOCO-1", baseUnit: "piece", inferred: "145", packagingStatus: "unknown", amount: "4350.00", plainEstimate: "4350.00",
  base: { name: "piece", sellable: true, price: "30" },
  units: [
    { id: BOX, name: "Box", multiplier: "20", canBeSold: true, isActive: true, price: "550" },
    { id: TRAY, name: "Tray", multiplier: "6", canBeSold: true, isActive: true, price: null },
    { id: OLD, name: "Old pack", multiplier: "10", canBeSold: true, isActive: false, price: "200" },
  ],
  current: null,
};
const recorded = (over: Partial<NonNullable<BreakdownItem["current"]>> = {}): BreakdownItem => ({
  ...base, packagingStatus: "known", amount: "4150.00",
  current: { revision: 2, status: "active", inferred: "145", packaged: "80", remainder: "65", amount: "4150.00", note: null, updatedAt: "2026-11-07T01:00:00Z",
    lines: [{ unitId: BOX, isBaseUnit: false, name: "Box", quantity: "4", baseUnits: "80", unitPrice: "550", amount: "2200.00" }, { unitId: null, isBaseUnit: true, name: "piece", quantity: "65", baseUnits: "65", unitPrice: "30", amount: "1950.00" }], ...over },
});
const DATE = "2026-11-06";

describe("what the form shows", () => {
  it("whole numbers only", () => {
    for (const ok of ["", "0", "4", "123456789"]) expect(isWholeNumber(ok), ok).toBe(true);
    for (const bad of ["2.5", "-1", "a", "1e3", " 1", "1234567890"]) expect(isWholeNumber(bad), bad).toBe(false);
  });

  it("offers active sellable units, plus an inactive one only if a recorded breakdown still uses it", () => {
    expect(formUnits(base).map((u) => u.id)).toEqual([BOX, TRAY]);
    const usesOld = recorded({ lines: [{ unitId: OLD, isBaseUnit: false, name: "Old pack", quantity: "1", baseUnits: "10", unitPrice: "200", amount: "200.00" }] });
    expect(formUnits(usesOld).map((u) => u.id)).toEqual([BOX, TRAY, OLD]);
  });

  it("starts empty when nothing is recorded, and from the recorded boxes otherwise", () => {
    expect(startingQuantities(base)).toEqual({ [BOX]: "", [TRAY]: "" });
    expect(startingQuantities(recorded())).toEqual({ [BOX]: "4", [TRAY]: "" });
  });

  it("an empty box means 'I do not know', not zero: only typed boxes are sent", () => {
    expect(enteredLines(base, { [BOX]: "4", [TRAY]: "" })).toEqual([{ unitId: BOX, quantity: "4" }]);
    expect(enteredLines(base, { [BOX]: "  ", [TRAY]: "" })).toEqual([]);
    expect(enteredLines(base, { [BOX]: "0" })).toEqual([{ unitId: BOX, quantity: "0" }]); // a typed zero is a known fact
  });
});

describe("the live preview (the same rule the database applies)", () => {
  it("145 sold with 4 boxes: 65 loose, Rs. 4,150.00", () => {
    const p = previewBreakdown(base, { [BOX]: "4" });
    expect(p.entered).toBe(true);
    expect(p.result).toMatchObject({ ok: true, amount: "4150.00", packaged: "80", remainder: "65" });
  });
  it("nothing typed: not entered", () => expect(previewBreakdown(base, {}).entered).toBe(false));
  it("too many boxes is an error the screen can show", () => expect(previewBreakdown(base, { [BOX]: "8" }).result).toEqual({ ok: false, error: "EXCEEDS_INFERRED" }));
  it("a unit with no price on that day is an error only once it is used", () => {
    expect(previewBreakdown(base, { [BOX]: "1" }).result.ok).toBe(true);
    expect(previewBreakdown(base, { [TRAY]: "1" }).result).toMatchObject({ ok: false, error: "PRICE_MISSING" });
  });
});

describe("revenue shown", () => {
  it("with boxes typed: the known amount", () => expect(revenueOf(base, { [BOX]: "4" })).toEqual({ kind: "known", amount: "4150.00" }));
  it("with nothing typed: the plain estimate (packaging unknown), never a made-up known figure", () => expect(revenueOf(base, {})).toEqual({ kind: "estimate", amount: "4350.00" }));
  it("with no price at all: no figure", () => expect(revenueOf({ ...base, plainEstimate: null }, {})).toEqual({ kind: "estimate", amount: null }));
  it("with an impossible entry: says so", () => expect(revenueOf(base, { [BOX]: "9" })).toEqual({ kind: "invalid", error: "sb.err.EXCEEDS_INFERRED" }));
});

describe("saving", () => {
  it("builds the draft: only typed boxes, the day, the revision the person saw", () => {
    expect(checkSave(base, DATE, { [BOX]: "4" }, "")).toEqual({ ok: true, draft: { variantId: "v1", date: DATE, lines: [{ unitId: BOX, quantity: "4" }], reason: undefined, expectedRevision: null } });
    const r = checkSave(recorded(), DATE, { [BOX]: "3" }, "  Recount  ");
    expect(r).toEqual({ ok: true, draft: { variantId: "v1", date: DATE, lines: [{ unitId: BOX, quantity: "3" }], reason: "Recount", expectedRevision: 2 } });
  });

  it("changing a recorded breakdown needs a reason; a first entry does not", () => {
    expect(checkSave(recorded(), DATE, { [BOX]: "3" }, "")).toEqual({ ok: false, error: "sb.err.REASON_REQUIRED" });
    expect(checkSave(recorded(), DATE, { [BOX]: "3" }, "   ")).toEqual({ ok: false, error: "sb.err.REASON_REQUIRED" });
    expect(checkSave(base, DATE, { [BOX]: "3" }, "").ok).toBe(true);
  });

  it("refuses numbers that do not fit the day", () => {
    expect(checkSave(base, DATE, { [BOX]: "8" }, "")).toEqual({ ok: false, error: "sb.err.EXCEEDS_INFERRED" });
    expect(checkSave(base, DATE, { [BOX]: "2.5" }, "")).toEqual({ ok: false, error: "sb.err.FRACTIONAL_PACKAGE" });
  });

  it("nothing typed is not a breakdown, even when one is recorded (a typed 0 is: it means everything was sold loose)", () => {
    expect(checkSave(base, DATE, {}, "")).toEqual({ ok: false, error: "sb.err.INVALID_LINE" });
    expect(checkSave(recorded(), DATE, { [BOX]: "" }, "Recount")).toEqual({ ok: false, error: "sb.err.INVALID_LINE" });
    expect(checkSave(base, DATE, { [BOX]: "0" }, "")).toMatchObject({ ok: true, draft: { lines: [{ unitId: BOX, quantity: "0" }] } });
  });

  it("removing needs a reason", () => {
    expect(checkClear("")).toEqual({ ok: false, error: "sb.err.REASON_REQUIRED" });
    expect(checkClear("Not sure")).toEqual({ ok: true });
  });
});

describe("whether Save is enabled", () => {
  it("nothing recorded: needs something typed", () => {
    expect(canPressSave(base, {})).toBe(false);
    expect(canPressSave(base, { [BOX]: "4" })).toBe(true);
  });
  it("recorded: needs a change", () => {
    expect(sameAsRecorded(recorded(), { [BOX]: "4" })).toBe(true);
    expect(canPressSave(recorded(), { [BOX]: "4" })).toBe(false);
    expect(canPressSave(recorded(), { [BOX]: "3" })).toBe(true);
    expect(canPressSave(recorded(), { [BOX]: "" })).toBe(false); // emptied boxes mean "I do not know": that is what the clear button is for
    expect(canPressSave(recorded(), { [BOX]: "0" })).toBe(true);  // a typed zero is a known fact (everything sold loose)
  });
  it("a stale breakdown can be confirmed as it is", () => {
    const stale = { ...recorded(), packagingStatus: "stale" as const, current: { ...recorded().current!, status: "stale" as const } };
    expect(canPressSave(stale, { [BOX]: "4" })).toBe(true);
  });
});
