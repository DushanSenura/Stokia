/**
 * Packaging conversion engine — the ONE place that turns "7 bundles + 5 loose packets"
 * into a base-unit quantity. Stock entry, receiving, movements, reports and analytics must
 * all call this module (never re-implement the multiplication).
 *
 * Model (per product variant):
 *  - The variant has an implicit BASE unit (e.g. "packet") with multiplier 1. Stock is stored
 *    and calculated only in base units.
 *  - A packaging unit contains `factor` of the next-smaller unit (`parentId`), or `factor`
 *    BASE units when parentId is null.
 *      Bundle: parentId=null, factor=12   -> 1 bundle = 12 packets
 *      Carton: parentId=Bundle, factor=4  -> 1 carton = 4 bundles = 48 packets
 *  - Units only ever live inside one variant, so different sizes can never be mixed.
 *  - Mixed-product kits (several SKUs in one pack) are NOT packaging; they need a separate
 *    bill-of-materials model and are deliberately unsupported here.
 *
 * Counting rules: packaging units are counted in WHOLE numbers; only the base unit may hold
 * a fraction (max 3 decimals, matching numeric(18,3)). A bundle and its contents are never
 * double counted because each counted unit contributes exactly once and a unit may appear
 * at most once per count.
 */
import Decimal from "decimal.js";

export const MAX_DEPTH = 5;
export const MAX_MULTIPLIER = new Decimal(1_000_000);
export const MAX_QUANTITY = new Decimal("1e12");

export interface PackUnit {
  id: string;
  name: string;
  /** Next-smaller unit this one is made of; null = made of base units. */
  parentId: string | null;
  /** How many `parent` units (or base units) one of this unit contains. */
  factor: Decimal.Value;
  isActive?: boolean;
}

export type DefinitionError =
  | "invalid_factor" | "unknown_parent" | "inactive_parent" | "cycle" | "self_parent"
  | "duplicate_name" | "empty_name" | "name_equals_base" | "too_deep" | "multiplier_too_large";

export type DefinitionResult =
  | { ok: true; multipliers: Map<string, Decimal> }
  | { ok: false; code: DefinitionError; unitId: string };

const isPositive = (v: Decimal.Value): boolean => {
  try {
    const d = new Decimal(v);
    return d.isFinite() && d.gt(0) && d.decimalPlaces() <= 6;
  } catch {
    return false;
  }
};

/** Validate a variant's packaging definition and compute base-unit multipliers. */
export function resolveUnits(units: PackUnit[], baseUnitName?: string): DefinitionResult {
  const active = units.filter((u) => u.isActive !== false);
  const byId = new Map(active.map((u) => [u.id, u]));
  const names = new Set<string>();

  for (const u of active) {
    const name = u.name.trim().toLowerCase();
    if (!name) return { ok: false, code: "empty_name", unitId: u.id };
    if (baseUnitName && name === baseUnitName.trim().toLowerCase()) return { ok: false, code: "name_equals_base", unitId: u.id };
    if (names.has(name)) return { ok: false, code: "duplicate_name", unitId: u.id };
    names.add(name);
    if (!isPositive(u.factor)) return { ok: false, code: "invalid_factor", unitId: u.id };
    if (u.parentId === u.id) return { ok: false, code: "self_parent", unitId: u.id };
    if (u.parentId !== null && !byId.has(u.parentId)) {
      const exists = units.some((x) => x.id === u.parentId);
      return { ok: false, code: exists ? "inactive_parent" : "unknown_parent", unitId: u.id };
    }
  }

  const multipliers = new Map<string, Decimal>();
  for (const start of active) {
    // Walk down the chain, multiplying factors. Revisiting a unit means a cycle.
    let mult = new Decimal(1);
    let cur: PackUnit | undefined = start;
    const seen = new Set<string>();
    let depth = 0;
    while (cur) {
      if (seen.has(cur.id)) return { ok: false, code: "cycle", unitId: start.id };
      seen.add(cur.id);
      if (++depth > MAX_DEPTH) return { ok: false, code: "too_deep", unitId: start.id };
      mult = mult.times(new Decimal(cur.factor));
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    if (mult.gt(MAX_MULTIPLIER)) return { ok: false, code: "multiplier_too_large", unitId: start.id };
    multipliers.set(start.id, mult);
  }
  return { ok: true, multipliers };
}

// ---------- normalisation ----------

/** `unitId: null` means the base unit (loose items). Blank quantity = not entered. */
export interface CountEntry {
  unitId: string | null;
  quantity: Decimal.Value | null | undefined;
}

export type NormalizeError =
  | "definition_invalid" | "duplicate_unit" | "unknown_unit" | "invalid_number"
  | "negative" | "fractional_package" | "too_many_decimals" | "too_large";

export type NormalizeResult =
  /** counted=false when every field was blank: the product is NOT counted (never zero). */
  | { ok: true; counted: boolean; baseQuantity: string; lines: { unitId: string | null; quantity: string; baseQuantity: string }[] }
  | { ok: false; code: NormalizeError; unitId?: string | null };

const blank = (v: CountEntry["quantity"]) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

export function normalizePackagingQuantity(entries: CountEntry[], units: PackUnit[], baseUnitName?: string): NormalizeResult {
  const def = resolveUnits(units, baseUnitName);
  if (!def.ok) return { ok: false, code: "definition_invalid", unitId: def.unitId };

  const seen = new Set<string | null>();
  const lines: { unitId: string | null; quantity: string; baseQuantity: string }[] = [];
  let total = new Decimal(0);

  for (const e of entries) {
    // A unit counted twice would double count (e.g. two "bundle" boxes in one count).
    if (seen.has(e.unitId)) return { ok: false, code: "duplicate_unit", unitId: e.unitId };
    seen.add(e.unitId);
    if (blank(e.quantity)) continue;

    let q: Decimal;
    try {
      q = new Decimal(e.quantity as Decimal.Value);
    } catch {
      return { ok: false, code: "invalid_number", unitId: e.unitId };
    }
    if (!q.isFinite()) return { ok: false, code: "invalid_number", unitId: e.unitId };
    if (q.isNegative()) return { ok: false, code: "negative", unitId: e.unitId };
    if (q.gt(MAX_QUANTITY)) return { ok: false, code: "too_large", unitId: e.unitId };

    let mult = new Decimal(1);
    if (e.unitId !== null) {
      const m = def.multipliers.get(e.unitId);
      if (!m) return { ok: false, code: "unknown_unit", unitId: e.unitId };
      if (!q.isInteger()) return { ok: false, code: "fractional_package", unitId: e.unitId }; // only full bundles count as bundles
      mult = m;
    } else if (q.decimalPlaces() > 3) {
      return { ok: false, code: "too_many_decimals", unitId: null };
    }

    const base = q.times(mult);
    total = total.plus(base);
    lines.push({ unitId: e.unitId, quantity: q.toString(), baseQuantity: base.toString() });
  }

  if (total.gt(MAX_QUANTITY)) return { ok: false, code: "too_large" };
  return { ok: true, counted: lines.length > 0, baseQuantity: total.toString(), lines };
}

// ---------- display helpers ----------

export interface Breakdown { unitId: string | null; quantity: string }

/**
 * Express a base quantity as whole bigger units + loose base units (largest first),
 * e.g. 89 with bundle=12 -> 7 bundles + 5 loose. Used for display/preview only; the base
 * quantity remains the source of truth.
 */
export function denormalizeQuantity(baseQuantity: Decimal.Value, units: PackUnit[]): Breakdown[] | null {
  const def = resolveUnits(units);
  if (!def.ok) return null;
  let rest = new Decimal(baseQuantity);
  if (!rest.isFinite() || rest.isNegative()) return null;

  const ordered = units
    .filter((u) => u.isActive !== false)
    .map((u) => ({ id: u.id, mult: def.multipliers.get(u.id)! }))
    .filter((u) => u.mult.gt(1) && u.mult.isInteger())
    .sort((a, b) => b.mult.comparedTo(a.mult));

  const out: Breakdown[] = [];
  for (const u of ordered) {
    const n = rest.dividedToIntegerBy(u.mult);
    if (n.gt(0)) {
      out.push({ unitId: u.id, quantity: n.toString() });
      rest = rest.minus(n.times(u.mult));
    }
  }
  if (rest.gt(0) || out.length === 0) out.push({ unitId: null, quantity: rest.toString() });
  return out;
}

/** Human summary like "1 Carton = 4 Bundle = 48 packet", used in lists and the preview. */
export function describeUnit(unit: PackUnit, units: PackUnit[], baseUnitName: string): string | null {
  const def = resolveUnits(units, baseUnitName);
  if (!def.ok) return null;
  const mult = def.multipliers.get(unit.id);
  if (!mult) return null;
  const parent = unit.parentId ? units.find((u) => u.id === unit.parentId) : null;
  const direct = `${new Decimal(unit.factor).toString()} ${parent ? parent.name : baseUnitName}`;
  return parent ? `1 ${unit.name} = ${direct} = ${mult.toString()} ${baseUnitName}` : `1 ${unit.name} = ${direct}`;
}

/**
 * Never add quantities of different base units together (packets + bottles, or grams + ml).
 * Returns separate totals keyed by base unit; callers show them side by side.
 */
export function aggregateByBaseUnit(items: { baseUnit: string; quantity: Decimal.Value }[]): Record<string, string> {
  const totals: Record<string, Decimal> = {};
  for (const i of items) {
    const key = i.baseUnit.trim().toLowerCase();
    totals[key] = (totals[key] ?? new Decimal(0)).plus(new Decimal(i.quantity));
  }
  return Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v.toString()]));
}
