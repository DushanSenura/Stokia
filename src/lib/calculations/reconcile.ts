/**
 * Stock interval reconciliation (pure, UI/DB independent).
 *
 * This file is the SPECIFICATION for the SQL function `_recalc_sales_day` (migration 6), which runs the
 * same rule atomically inside the database. tests/integration/sales-engine.test.ts compares the two on
 * randomised data so they cannot drift apart.
 *
 * The arithmetic itself lives in `calculateInferredUnitsSold` (one formula, one place); this module adds
 * what surrounds it: which movements belong to the interval, what "pending" means, and the price rule.
 */
import Decimal from "decimal.js";
import {
  calculateEstimatedSalesValue, calculateInferredUnitsSold, type Qty,
} from "./inferred-sales";

export type MovementType =
  | "stock_received" | "supplier_return" | "customer_return" | "damaged"
  | "expired" | "discarded" | "manual_adjustment" | "repacking";

export const MOVEMENT_TYPES: readonly MovementType[] = [
  "stock_received", "customer_return", "supplier_return", "damaged", "expired", "discarded", "manual_adjustment", "repacking",
];

/** `+` always adds stock, `-` always removes it, `any` is a signed adjustment chosen by the user. */
export const MOVEMENT_SIGN: Record<MovementType, "+" | "-" | "any"> = {
  stock_received: "+", customer_return: "+",
  supplier_return: "-", damaged: "-", expired: "-", discarded: "-",
  manual_adjustment: "any", repacking: "any",
};

/**
 * Signed effect on stock for a movement. `direction` is only used by types whose sign is chosen by the
 * user (manual adjustment). A fixed-sign type with a contradicting direction is a programming/UI error.
 */
export function signedEffect(type: MovementType, magnitude: Qty, direction?: "in" | "out"): string {
  const m = new Decimal(magnitude);
  if (!m.isFinite() || m.lte(0)) throw new Error("INVALID_QUANTITY");
  const sign = MOVEMENT_SIGN[type];
  if (sign === "+") { if (direction === "out") throw new Error("DIRECTION_CONFLICT"); return m.toString(); }
  if (sign === "-") { if (direction === "in") throw new Error("DIRECTION_CONFLICT"); return m.negated().toString(); }
  if (!direction) throw new Error("DIRECTION_REQUIRED");
  return (direction === "in" ? m : m.negated()).toString();
}

export interface MovementEffect {
  type: MovementType;
  /** SIGNED base-unit effect (as stored in stock_movements.normalized_base_quantity). */
  effect: Qty;
  effectiveAt: Date | string;
}

export interface MovementTotals {
  received: string;
  returns: string;
  /** Positive numbers (stock that left for reasons other than sale). */
  damaged: string;
  otherOut: string;
  /** Signed. */
  adjustments: string;
}

export function classifyMovements(ms: Pick<MovementEffect, "type" | "effect">[]): MovementTotals {
  let received = new Decimal(0), returns = new Decimal(0), damaged = new Decimal(0), otherOut = new Decimal(0), adjustments = new Decimal(0);
  for (const m of ms) {
    const e = new Decimal(m.effect);
    switch (m.type) {
      case "stock_received": received = received.plus(e); break;
      case "customer_return": returns = returns.plus(e); break;
      case "damaged": case "expired": case "discarded": damaged = damaged.minus(e); break;
      case "supplier_return": otherOut = otherOut.minus(e); break;
      case "manual_adjustment": case "repacking": adjustments = adjustments.plus(e); break;
    }
  }
  return {
    received: received.toString(), returns: returns.toString(), damaged: damaged.toString(),
    otherOut: otherOut.toString(), adjustments: adjustments.toString(),
  };
}

/**
 * Movements belong to the interval (openedAt, closedAt]: stock that arrived before the closing count is
 * physically included in the closing count, so it must be added to what was available. A movement
 * exactly at the opening count time belongs to the PREVIOUS interval.
 */
export function movementsInInterval<T extends Pick<MovementEffect, "effectiveAt">>(ms: T[], openedAt: Date | string, closedAt: Date | string): T[] {
  const lo = new Date(openedAt).getTime(), hi = new Date(closedAt).getTime();
  return ms.filter((m) => { const t = new Date(m.effectiveAt).getTime(); return t > lo && t <= hi; });
}

export type PendingReason =
  | "awaiting_next_count"   // the closing count has not been entered yet
  | "missing_count"         // a later count exists, but not the one for the next morning (a day was skipped)
  | "opening_not_counted"   // this product was not counted on the opening morning
  | "closing_not_counted";  // this product was not counted on the closing morning

export interface IntervalInput {
  /** Opening count in base units; null = product not counted in the opening count. */
  opening: Qty | null;
  /** null = there is no confirmed count for the next morning. */
  closing: { counted: boolean; quantity: Qty | null; countedAt: Date | string } | null;
  /** Is there any confirmed count after the closing day? Distinguishes "awaiting" from "skipped". */
  hasLaterCount: boolean;
  /** When the opening count was taken. */
  openedAt: Date | string;
  /** All movements for this variant; the ones outside the interval are ignored here. */
  movements: MovementEffect[];
  /** Selling price in force at noon on the sales date, or null. */
  sellingPrice: string | null;
}

export interface Breakdown extends MovementTotals { opening: string; closing: string }

export type IntervalResult =
  | { status: "pending"; reason: PendingReason }
  | { status: "needs_review"; reason: "stock_increase_unexplained"; breakdown: Breakdown }
  | { status: "calculated"; unitsSold: string; estimatedAmount: string | null; breakdown: Breakdown };

export function reconcileStockInterval(i: IntervalInput): IntervalResult {
  if (i.closing === null) return { status: "pending", reason: i.hasLaterCount ? "missing_count" : "awaiting_next_count" };
  if (i.opening === null) return { status: "pending", reason: "opening_not_counted" };
  if (!i.closing.counted || i.closing.quantity === null) return { status: "pending", reason: "closing_not_counted" };

  const totals = classifyMovements(movementsInInterval(i.movements, i.openedAt, i.closing.countedAt));
  const r = calculateInferredUnitsSold({
    opening: i.opening, closing: i.closing.quantity,
    received: totals.received, returnsToStock: totals.returns, damaged: totals.damaged,
    otherNonSaleOut: totals.otherOut, adjustments: totals.adjustments,
  });
  const breakdown: Breakdown = { opening: new Decimal(i.opening).toString(), closing: new Decimal(i.closing.quantity).toString(), ...totals };

  // calculateInferredUnitsSold only returns pending for missing inputs, which were handled above.
  if (r.status !== "calculated") return { status: "needs_review", reason: "stock_increase_unexplained", breakdown };
  return {
    status: "calculated",
    unitsSold: r.unitsSold,
    // Never fabricate money: no price -> units only. Always labelled "Estimated" in the UI.
    estimatedAmount: i.sellingPrice === null ? null : calculateEstimatedSalesValue(r.unitsSold, i.sellingPrice),
    breakdown,
  };
}
