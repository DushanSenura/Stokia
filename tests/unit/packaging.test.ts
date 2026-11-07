import { describe, expect, it } from "vitest";
import {
  aggregateByBaseUnit, denormalizeQuantity, describeUnit, normalizePackagingQuantity, resolveUnits, type PackUnit,
} from "@/lib/calculations/packaging";
import { calculateInferredUnitsSold } from "@/lib/calculations/inferred-sales";

const bundle: PackUnit = { id: "bundle", name: "Bundle", parentId: null, factor: 12 };
const carton: PackUnit = { id: "carton", name: "Carton", parentId: "bundle", factor: 4 };

describe("resolveUnits", () => {
  it("computes multipliers, including nested units", () => {
    const r = resolveUnits([bundle, carton], "packet");
    expect(r.ok && [...r.multipliers].map(([k, v]) => [k, v.toString()])).toEqual([["bundle", "12"], ["carton", "48"]]);
  });
  it.each([0, -3, "abc", Infinity, "1.1234567"])("Test J: rejects invalid factor %s", (factor) => {
    expect(resolveUnits([{ ...bundle, factor }])).toMatchObject({ ok: false, code: "invalid_factor" });
  });
  it("Test J: rejects circular definitions (A -> B -> A)", () => {
    const a: PackUnit = { id: "a", name: "A", parentId: "b", factor: 2 };
    const b: PackUnit = { id: "b", name: "B", parentId: "a", factor: 3 };
    expect(resolveUnits([a, b])).toMatchObject({ ok: false, code: "cycle" });
  });
  it("rejects self-parent, unknown parent, inactive parent", () => {
    expect(resolveUnits([{ ...bundle, parentId: "bundle" }])).toMatchObject({ code: "self_parent" });
    expect(resolveUnits([{ ...carton, parentId: "ghost" }])).toMatchObject({ code: "unknown_parent" });
    expect(resolveUnits([{ ...bundle, isActive: false }, carton])).toMatchObject({ code: "inactive_parent" });
  });
  it("rejects duplicate / empty names and a name equal to the base unit", () => {
    expect(resolveUnits([bundle, { ...carton, name: " bundle " }])).toMatchObject({ code: "duplicate_name" });
    expect(resolveUnits([{ ...bundle, name: "  " }])).toMatchObject({ code: "empty_name" });
    expect(resolveUnits([{ ...bundle, name: "Packet" }], "packet")).toMatchObject({ code: "name_equals_base" });
  });
  it("limits depth and absurd multipliers", () => {
    const chain: PackUnit[] = Array.from({ length: 6 }, (_, i) => ({ id: `u${i}`, name: `U${i}`, parentId: i ? `u${i - 1}` : null, factor: 2 }));
    expect(resolveUnits(chain)).toMatchObject({ code: "too_deep" });
    expect(resolveUnits([{ ...bundle, factor: 2_000_000 }])).toMatchObject({ code: "multiplier_too_large" });
  });
  it("ignores inactive units", () => {
    expect(resolveUnits([bundle, { ...carton, isActive: false, factor: 0 }]).ok).toBe(true);
  });
});

describe("normalizePackagingQuantity", () => {
  const units = [bundle, carton];
  it("Test D: 10 bundles = 120 packets; 7 bundles + 5 loose = 89; sold = 31", () => {
    const d1 = normalizePackagingQuantity([{ unitId: "bundle", quantity: 10 }, { unitId: null, quantity: 0 }], units);
    const d2 = normalizePackagingQuantity([{ unitId: "bundle", quantity: 7 }, { unitId: null, quantity: 5 }], units);
    expect(d1).toMatchObject({ ok: true, baseQuantity: "120" });
    expect(d2).toMatchObject({ ok: true, baseQuantity: "89" });
    if (d1.ok && d2.ok) expect(calculateInferredUnitsSold({ opening: d1.baseQuantity, closing: d2.baseQuantity })).toMatchObject({ unitsSold: "31" });
  });
  it("handles nested units: 1 carton + 3 bundles + 5 loose = 89", () => {
    expect(normalizePackagingQuantity([{ unitId: "carton", quantity: 1 }, { unitId: "bundle", quantity: 3 }, { unitId: null, quantity: 5 }], units)).toMatchObject({ baseQuantity: "89" });
  });
  it("all-blank means NOT counted (never zero); explicit zero is counted", () => {
    expect(normalizePackagingQuantity([{ unitId: "bundle", quantity: "" }, { unitId: null, quantity: null }], units)).toMatchObject({ ok: true, counted: false });
    expect(normalizePackagingQuantity([{ unitId: "bundle", quantity: "0" }], units)).toMatchObject({ ok: true, counted: true, baseQuantity: "0" });
  });
  it("one filled field counts; a blank sibling contributes nothing", () => {
    expect(normalizePackagingQuantity([{ unitId: "bundle", quantity: 7 }, { unitId: null, quantity: "" }], units)).toMatchObject({ counted: true, baseQuantity: "84" });
  });
  it("Test J: rejects duplicate counted units (would double count)", () => {
    expect(normalizePackagingQuantity([{ unitId: "bundle", quantity: 1 }, { unitId: "bundle", quantity: 2 }], units)).toMatchObject({ ok: false, code: "duplicate_unit" });
    expect(normalizePackagingQuantity([{ unitId: null, quantity: 1 }, { unitId: null, quantity: 2 }], units)).toMatchObject({ ok: false, code: "duplicate_unit" });
  });
  it("Test J: rejects negative counts and bad numbers", () => {
    expect(normalizePackagingQuantity([{ unitId: null, quantity: -1 }], units)).toMatchObject({ code: "negative" });
    expect(normalizePackagingQuantity([{ unitId: null, quantity: "abc" }], units)).toMatchObject({ code: "invalid_number" });
    expect(normalizePackagingQuantity([{ unitId: null, quantity: "NaN" }], units)).toMatchObject({ code: "invalid_number" });
  });
  it("only whole bundles count as bundles; base unit allows up to 3 decimals", () => {
    expect(normalizePackagingQuantity([{ unitId: "bundle", quantity: "2.5" }], units)).toMatchObject({ code: "fractional_package" });
    expect(normalizePackagingQuantity([{ unitId: null, quantity: "1.5" }], units)).toMatchObject({ ok: true, baseQuantity: "1.5" });
    expect(normalizePackagingQuantity([{ unitId: null, quantity: "1.2345" }], units)).toMatchObject({ code: "too_many_decimals" });
  });
  it("rejects units that are not part of this variant", () => {
    expect(normalizePackagingQuantity([{ unitId: "other-variant-bundle", quantity: 1 }], units)).toMatchObject({ code: "unknown_unit" });
  });
  it("refuses to compute from an invalid definition", () => {
    expect(normalizePackagingQuantity([{ unitId: null, quantity: 1 }], [{ ...bundle, factor: 0 }])).toMatchObject({ code: "definition_invalid" });
  });
  it("is decimal-exact (no float drift)", () => {
    expect(normalizePackagingQuantity([{ unitId: null, quantity: "0.1" }, { unitId: "bundle", quantity: 3 }], units)).toMatchObject({ baseQuantity: "36.1" });
  });
  it("caps absurd quantities", () => {
    expect(normalizePackagingQuantity([{ unitId: "bundle", quantity: "1e12" }], units)).toMatchObject({ code: "too_large" });
  });
});

describe("denormalizeQuantity / describeUnit / aggregate", () => {
  const units = [bundle, carton];
  it("splits into largest whole units first", () => {
    expect(denormalizeQuantity(89, units)).toEqual([{ unitId: "carton", quantity: "1" }, { unitId: "bundle", quantity: "3" }, { unitId: null, quantity: "5" }]);
    expect(denormalizeQuantity(89, [bundle])).toEqual([{ unitId: "bundle", quantity: "7" }, { unitId: null, quantity: "5" }]);
    expect(denormalizeQuantity(0, units)).toEqual([{ unitId: null, quantity: "0" }]);
    expect(denormalizeQuantity(-1, units)).toBeNull();
  });
  it("round-trips with normalize", () => {
    for (const total of [0, 1, 11, 12, 47, 48, 89, 1000]) {
      const parts = denormalizeQuantity(total, units)!;
      const r = normalizePackagingQuantity(parts.map((p) => ({ unitId: p.unitId, quantity: p.quantity })), units);
      expect(r).toMatchObject({ ok: true, baseQuantity: String(total) });
    }
  });
  it("describes conversions", () => {
    expect(describeUnit(bundle, [bundle, carton], "packet")).toBe("1 Bundle = 12 packet");
    expect(describeUnit(carton, [bundle, carton], "packet")).toBe("1 Carton = 4 Bundle = 48 packet");
  });
  it("never merges different base units", () => {
    expect(aggregateByBaseUnit([{ baseUnit: "Packet", quantity: 10 }, { baseUnit: "bottle", quantity: 3 }, { baseUnit: "packet", quantity: "2.5" }])).toEqual({ packet: "12.5", bottle: "3" });
  });
});
