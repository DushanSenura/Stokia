/**
 * Core Stokia business rule (pure, UI-independent, decimal-safe).
 *
 *   Units sold = opening + received + returnsToStock
 *                - damaged - otherNonSaleOut + adjustments - closing
 *
 * IMPORTANT semantics:
 *  - `opening` is the PREVIOUS morning's count; `closing` is the CURRENT
 *    morning's count. The result belongs to the PREVIOUS day (the sales date),
 *    never to the day the closing count was entered.
 *  - A missing count is `null`/`undefined` and is NEVER treated as zero.
 *    A real zero must be passed explicitly as 0.
 *  - A negative result is not clamped to zero: it is "needs_review".
 *  - All quantities must already be normalized to the variant's base unit.
 *
 * This is the Phase 1 core; the full interval/packaging engine builds on it.
 */
import Decimal from "decimal.js";

export type Qty = Decimal.Value;

export interface StockIntervalInput {
  /** Previous morning count, base units. null = not counted. */
  opening: Qty | null | undefined;
  /** Current morning count, base units. null = not counted. */
  closing: Qty | null | undefined;
  /** Positive movements inside the interval. */
  received?: Qty;
  returnsToStock?: Qty;
  /** Non-sale outflows (positive numbers): damaged, expired, discarded, supplier returns. */
  damaged?: Qty;
  otherNonSaleOut?: Qty;
  /** Signed manual adjustments (+ adds stock, - removes stock). */
  adjustments?: Qty;
}

export type InferredSalesResult =
  | { status: "pending"; reason: "missing_opening" | "missing_closing" }
  | { status: "needs_review"; reason: "negative_sales" | "invalid_quantity"; unitsSold: null; available: string; difference: string }
  | { status: "calculated"; unitsSold: string; available: string };

const isMissing = (v: Qty | null | undefined): v is null | undefined =>
  v === null || v === undefined || v === "";

function dec(v: Qty | undefined): Decimal {
  return new Decimal(v ?? 0);
}

/** Stock that should have been on the shelf if nothing was sold. */
export function calculateAvailableStock(i: Omit<StockIntervalInput, "closing">): Decimal {
  return dec(i.opening ?? 0)
    .plus(dec(i.received))
    .plus(dec(i.returnsToStock))
    .minus(dec(i.damaged))
    .minus(dec(i.otherNonSaleOut))
    .plus(dec(i.adjustments));
}

export function calculateInferredUnitsSold(i: StockIntervalInput): InferredSalesResult {
  if (isMissing(i.opening)) return { status: "pending", reason: "missing_opening" };
  if (isMissing(i.closing)) return { status: "pending", reason: "missing_closing" };

  const parts = [i.opening, i.closing, i.received, i.returnsToStock, i.damaged, i.otherNonSaleOut];
  for (const p of parts) {
    if (p === undefined) continue;
    let d: Decimal;
    try {
      d = new Decimal(p as Decimal.Value);
    } catch {
      return { status: "needs_review", reason: "invalid_quantity", unitsSold: null, available: "0", difference: "0" };
    }
    // Counts and non-sale quantities can never be negative or NaN.
    if (!d.isFinite() || d.isNegative()) {
      return { status: "needs_review", reason: "invalid_quantity", unitsSold: null, available: "0", difference: "0" };
    }
  }

  const available = calculateAvailableStock(i);
  const sold = available.minus(dec(i.closing));

  if (sold.isNegative()) {
    return {
      status: "needs_review",
      reason: "negative_sales",
      unitsSold: null,
      available: available.toString(),
      difference: sold.toString(),
    };
  }
  return { status: "calculated", unitsSold: sold.toString(), available: available.toString() };
}

/** Estimated (never confirmed) sales value. Money stays decimal: LKR, 2 dp. */
export function calculateEstimatedSalesValue(unitsSold: Qty, unitPriceLkr: Qty): string {
  return new Decimal(unitsSold).times(new Decimal(unitPriceLkr)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}
