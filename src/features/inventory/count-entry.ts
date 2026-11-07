/**
 * Pure logic behind the Morning Stock form (no React, no database).
 * The server re-runs the same functions on submit — the browser is never trusted for totals.
 */
import Decimal from "decimal.js";
import {
  denormalizeQuantity, normalizePackagingQuantity, type CountEntry, type NormalizeError, type PackUnit,
} from "@/lib/calculations/packaging";
import type { MovementTotals } from "@/lib/calculations/reconcile";
import {
  calculateEstimatedSalesValue, calculateInferredUnitsSold, type InferredSalesResult,
} from "@/lib/calculations/inferred-sales";

/** Key of the "loose items in the base unit" field. */
export const BASE_KEY = "__base";

export interface EntryItem {
  variantId: string;
  productName: string;
  productCode: string;
  category: string | null;
  sizeLabel: string;
  sku: string;
  baseUnit: string;
  /** Active packaging units for this variant only. */
  units: PackUnit[];
  /** Previous confirmed count in base units; null when this variant had no previous count. */
  previousBase: string | null;
  /** Selling price in force on the sales date, as a decimal string; null when none was set. */
  sellingPrice: string | null;
  /** Recorded movements (deliveries, returns, damage, adjustments) in the interval this count would close. */
  movements?: MovementTotals;
}

/** unitId (or BASE_KEY) -> text typed by the user. "" / missing = blank. */
export type FieldValues = Record<string, string>;

export type ItemFlag = "increase" | "no_previous";

export type ItemState =
  | { kind: "not_counted" }
  | { kind: "error"; code: NormalizeError }
  | {
      kind: "counted";
      baseQuantity: string;
      /** closing - previous (negative = stock went down). null when there is no previous count. */
      change: string | null;
      sales: InferredSalesResult | null;
      estimatedValue: string | null;
      flag: ItemFlag | null;
    };

export function entriesFor(item: Pick<EntryItem, "units">, values: FieldValues): CountEntry[] {
  return [
    ...item.units.map((u) => ({ unitId: u.id as string | null, quantity: values[u.id] })),
    { unitId: null, quantity: values[BASE_KEY] },
  ];
}

/**
 * Evaluate one product row. A fully blank row is NOT counted (never zero). The figure includes the movements
 * recorded in this interval; a rise that no movement explains is surfaced as needing review, never as a number.
 * (The database repeats this calculation at confirmation and is the source of truth.)
 */
export function evaluateItem(item: EntryItem, values: FieldValues): ItemState {
  const norm = normalizePackagingQuantity(entriesFor(item, values), item.units, item.baseUnit);
  if (!norm.ok) return { kind: "error", code: norm.code };
  if (!norm.counted) return { kind: "not_counted" };

  if (item.previousBase === null) {
    return { kind: "counted", baseQuantity: norm.baseQuantity, change: null, sales: null, estimatedValue: null, flag: "no_previous" };
  }
  const change = new Decimal(norm.baseQuantity).minus(item.previousBase).toString();
  const m = item.movements;
  const sales = calculateInferredUnitsSold({
    opening: item.previousBase, closing: norm.baseQuantity,
    received: m?.received, returnsToStock: m?.returns, damaged: m?.damaged, otherNonSaleOut: m?.otherOut, adjustments: m?.adjustments,
  });
  const estimatedValue =
    sales.status === "calculated" && item.sellingPrice !== null ? calculateEstimatedSalesValue(sales.unitsSold, item.sellingPrice) : null;
  return {
    kind: "counted", baseQuantity: norm.baseQuantity, change, sales, estimatedValue,
    flag: sales.status === "needs_review" ? "increase" : null,
  };
}

export interface Summary {
  total: number;
  counted: number;
  notCounted: number;
  errors: number;
  needsReview: number;
  /** Sum of estimated sales across products that have a price (money is additive, units are not). */
  estimatedTotal: string;
  /** Units sold per base unit — never mixed across different units. */
  unitsByBaseUnit: Record<string, string>;
}

export function summarize(items: EntryItem[], values: Record<string, FieldValues>): Summary {
  const s: Summary = { total: items.length, counted: 0, notCounted: 0, errors: 0, needsReview: 0, estimatedTotal: "0.00", unitsByBaseUnit: {} };
  let money = new Decimal(0);
  const units: Record<string, Decimal> = {};
  for (const item of items) {
    const st = evaluateItem(item, values[item.variantId] ?? {});
    if (st.kind === "not_counted") s.notCounted++;
    else if (st.kind === "error") s.errors++;
    else {
      s.counted++;
      if (st.flag === "increase") s.needsReview++;
      if (st.sales?.status === "calculated") {
        const k = item.baseUnit.toLowerCase();
        units[k] = (units[k] ?? new Decimal(0)).plus(st.sales.unitsSold);
      }
      if (st.estimatedValue) money = money.plus(st.estimatedValue);
    }
  }
  s.estimatedTotal = money.toFixed(2);
  s.unitsByBaseUnit = Object.fromEntries(Object.entries(units).map(([k, v]) => [k, v.toString()]));
  return s;
}

/** Payload sent to the server: only rows the user actually filled in (blank rows are omitted = not counted). */
export function buildPayloadItems(items: EntryItem[], values: Record<string, FieldValues>) {
  const out: { variantId: string; entries: { unitId: string | null; quantity: string }[] }[] = [];
  for (const item of items) {
    const v = values[item.variantId];
    if (!v) continue;
    const entries = entriesFor(item, v)
      .filter((e) => typeof e.quantity === "string" && e.quantity.trim() !== "")
      .map((e) => ({ unitId: e.unitId, quantity: (e.quantity as string).trim() }));
    if (entries.length) out.push({ variantId: item.variantId, entries });
  }
  return out;
}

/** Snapshot stored with each count line so old counts stay explainable if packaging changes later. */
export function buildEntryDetails(units: PackUnit[], baseUnit: string, lines: { unitId: string | null; quantity: string; baseQuantity: string }[]) {
  return {
    version: 1,
    base_unit: baseUnit,
    entries: lines.map((l) => {
      const u = l.unitId ? units.find((x) => x.id === l.unitId) : null;
      return {
        unit_id: l.unitId, unit_name: u ? u.name : baseUnit, quantity: l.quantity,
        multiplier: u ? new Decimal(l.baseQuantity).dividedBy(l.quantity).toString() : "1",
      };
    }),
  };
}

/** "7 Bundle + 5 packet (89 packet)" — readable form of a stored base quantity. */
export function describeQuantity(baseQuantity: string, units: PackUnit[], baseUnit: string): string {
  const parts = denormalizeQuantity(baseQuantity, units);
  const total = `${baseQuantity} ${baseUnit}`;
  if (!parts || (parts.length === 1 && parts[0].unitId === null)) return total;
  const text = parts.map((p) => `${p.quantity} ${p.unitId ? (units.find((u) => u.id === p.unitId)?.name ?? "") : baseUnit}`).join(" + ");
  return `${text} (${total})`;
}

/** Rebuild form fields from a saved line's snapshot; falls back to base units if packaging changed since. */
export function valuesFromLine(item: Pick<EntryItem, "units">, line: { normalized_base_quantity: string | null; entry_details: { entries?: { unit_id: string | null; quantity: string }[] } | null }): FieldValues {
  const out: FieldValues = {};
  const entries = line.entry_details?.entries ?? [];
  const known = new Set(item.units.map((u) => u.id));
  if (entries.length && entries.every((e) => e.unit_id === null || known.has(e.unit_id))) {
    for (const e of entries) out[e.unit_id ?? BASE_KEY] = e.quantity;
    return out;
  }
  if (line.normalized_base_quantity !== null) out[BASE_KEY] = new Decimal(line.normalized_base_quantity).toString();
  return out;
}

/** Non-zero recorded movements as short signed parts, e.g. [["stock_received", "+20"], ["damaged", "-2"]]. */
export function movementParts(m: MovementTotals | undefined): [key: "stock_received" | "customer_return" | "damaged" | "supplier_return" | "manual_adjustment", text: string][] {
  if (!m) return [];
  const out: ReturnType<typeof movementParts> = [];
  const add = (k: ReturnType<typeof movementParts>[number][0], v: string, sign: 1 | -1) => {
    const d = new Decimal(v);
    if (!d.isZero()) out.push([k, `${d.times(sign).gt(0) ? "+" : ""}${d.times(sign).toString()}`]);
  };
  add("stock_received", m.received, 1); add("customer_return", m.returns, 1);
  add("damaged", m.damaged, -1); add("supplier_return", m.otherOut, -1); add("manual_adjustment", m.adjustments, 1);
  return out;
}
