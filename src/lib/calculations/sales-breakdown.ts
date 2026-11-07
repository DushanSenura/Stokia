import Decimal from "decimal.js";

/**
 * The optional breakdown of a day's inferred sales into whole sellable packages and the base unit. Pure and decimal-safe; used by the
 * web form, the phone app and the server, and mirrored by the database function `_breakdown_compute` (a parity test runs both on the
 * same cases), so a number on a screen is the number the database will store.
 *
 *   packaged  = SUM(packages x base units per package)              must not exceed the inferred units sold
 *   remainder = inferred - packaged                                 sold in the base unit (loose pieces)
 *   revenue   = SUM(packages x package price) + remainder x base price     (each line rounded to cents, then added)
 *
 * A breakdown only SPLITS an already-inferred sale. It never adds or removes stock.
 * Prices are the ones in force on the sales date, supplied by the caller (never "today's").
 */
export type BreakdownError =
  | "INVALID_LINE" | "NEGATIVE_QUANTITY" | "FRACTIONAL_PACKAGE" | "DUPLICATE_UNIT" | "INVALID_UNIT" | "NOT_SELLABLE"
  | "PRICE_MISSING" | "EXCEEDS_INFERRED" | "BASE_NOT_SELLABLE" | "NOT_CALCULATED";

export interface SellableUnit {
  id: string;
  name: string;
  /** Base units in ONE of this unit (1 box = 20 pieces -> "20"). */
  multiplier: string;
  canBeSold: boolean;
  isActive?: boolean;
  /** Price in force on the sales date, or null if there is none. */
  price: string | null;
}

export interface BreakdownInput {
  /** Inferred base units sold for the day. */
  inferred: string | null;
  /** What the owner says was sold in whole packages. Zero-quantity lines are allowed and ignored. */
  lines: { unitId: string; quantity: string }[];
  units: SellableUnit[];
  base: { name: string; sellable: boolean; price: string | null };
  /** Reject a unit that has been deactivated (true when recording; false when re-checking an old record). */
  requireActive?: boolean;
}

export interface BreakdownLine {
  /** null = the base unit. */
  unitId: string | null;
  isBaseUnit: boolean;
  name: string;
  quantity: string;
  baseUnits: string;
  unitPrice: string;
  amount: string;
}

export type BreakdownResult =
  | { ok: true; amount: string; packaged: string; remainder: string; lines: BreakdownLine[] }
  | { ok: false; error: BreakdownError; unitId?: string };

const money = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const fail = (error: BreakdownError, unitId?: string): BreakdownResult => ({ ok: false, error, unitId });

/** The same checks, in the same order, as the database function. The first problem found is returned. */
export function computeBreakdown(input: BreakdownInput): BreakdownResult {
  if (input.inferred === null || input.inferred === "" || new Decimal(input.inferred).isNegative()) return fail("NOT_CALCULATED");
  const inferred = new Decimal(input.inferred);

  let packaged = new Decimal(0);
  let amount = new Decimal(0);
  const lines: BreakdownLine[] = [];
  const seen = new Set<string>();

  for (const l of input.lines) {
    let qty: Decimal;
    try { qty = new Decimal(String(l.quantity).trim()); } catch { return fail("INVALID_LINE", l.unitId); }
    if (!l.unitId || !qty.isFinite()) return fail("INVALID_LINE", l.unitId);
    if (qty.isNegative()) return fail("NEGATIVE_QUANTITY", l.unitId);
    if (!qty.isInteger()) return fail("FRACTIONAL_PACKAGE", l.unitId);
    if (seen.has(l.unitId)) return fail("DUPLICATE_UNIT", l.unitId);
    seen.add(l.unitId);

    const unit = input.units.find((u) => u.id === l.unitId);
    if (!unit) return fail("INVALID_UNIT", l.unitId);
    if (!unit.canBeSold) return fail("NOT_SELLABLE", l.unitId);
    if (input.requireActive && unit.isActive === false) return fail("INVALID_UNIT", l.unitId);
    if (qty.isZero()) continue;
    if (unit.price === null) return fail("PRICE_MISSING", l.unitId);

    const baseUnits = qty.times(unit.multiplier);
    const lineAmount = money(qty.times(unit.price));
    packaged = packaged.plus(baseUnits);
    amount = amount.plus(lineAmount);
    lines.push({ unitId: unit.id, isBaseUnit: false, name: unit.name, quantity: qty.toString(), baseUnits: baseUnits.toString(), unitPrice: unit.price, amount: lineAmount.toFixed(2) });
  }

  if (packaged.greaterThan(inferred)) return fail("EXCEEDS_INFERRED");
  const remainder = inferred.minus(packaged);
  if (remainder.greaterThan(0)) {
    if (!input.base.sellable) return fail("BASE_NOT_SELLABLE");
    if (input.base.price === null) return fail("PRICE_MISSING");
    const lineAmount = money(remainder.times(input.base.price));
    amount = amount.plus(lineAmount);
    lines.push({ unitId: null, isBaseUnit: true, name: input.base.name, quantity: remainder.toString(), baseUnits: remainder.toString(), unitPrice: input.base.price, amount: lineAmount.toFixed(2) });
  }
  return { ok: true, amount: amount.toFixed(2), packaged: packaged.toString(), remainder: remainder.toString(), lines };
}

/**
 * What the day is worth when NO breakdown is known: the whole inferred quantity at the base-unit price. This is today's behaviour
 * and stays the figure whenever the owner does not know the box sales. Null if there is no price.
 */
export function estimateWithoutBreakdown(inferred: string | null, basePrice: string | null): string | null {
  if (inferred === null || basePrice === null) return null;
  return money(new Decimal(inferred).times(basePrice)).toFixed(2);
}

/** Individual base units sold = total inferred sold - (packages sold x base units per package). Null when the numbers do not fit. */
export function individualUnitsSold(inferred: string, packages: { quantity: string; multiplier: string }[]): string | null {
  const packaged = packages.reduce((sum, p) => sum.plus(new Decimal(p.quantity).times(p.multiplier)), new Decimal(0));
  const rest = new Decimal(inferred).minus(packaged);
  return rest.isNegative() ? null : rest.toString();
}

/** Translation key of a rejection, shared by the web and the phone. */
export const breakdownErrorKey = (code: BreakdownError) => `sb.err.${code}` as const;
