import { describe, expect, it } from "vitest";
import {
  classifyMovements, movementsInInterval, reconcileStockInterval, signedEffect, type IntervalInput, type MovementEffect,
} from "@/lib/calculations/reconcile";

const OPEN = "2026-11-01T02:30:00Z"; // 08:00 Colombo
const CLOSE = "2026-11-02T02:30:00Z";
const mv = (type: MovementEffect["type"], effect: number, at = "2026-11-01T08:00:00Z"): MovementEffect => ({ type, effect, effectiveAt: at });
const run = (over: Partial<IntervalInput> = {}) => reconcileStockInterval({
  opening: 100, closing: { counted: true, quantity: 72, countedAt: CLOSE }, hasLaterCount: false, openedAt: OPEN, movements: [], sellingPrice: "150", ...over,
});

describe("reconcileStockInterval — the spec's test cases", () => {
  it("Test A: 100 -> 72 = 28 units, Rs. 4200.00 (estimate)", () => {
    expect(run()).toMatchObject({ status: "calculated", unitsSold: "28", estimatedAmount: "4200.00" });
  });
  it("Test B: +20 received -> 48", () => {
    expect(run({ movements: [mv("stock_received", 20)] })).toMatchObject({ unitsSold: "48", estimatedAmount: "7200.00" });
  });
  it("Test C: +20 received, 2 damaged -> 46", () => {
    expect(run({ movements: [mv("stock_received", 20), mv("damaged", -2)] })).toMatchObject({ unitsSold: "46" });
  });
  it("Test E: missing closing count is pending, never '100 sold'", () => {
    expect(run({ closing: null })).toEqual({ status: "pending", reason: "awaiting_next_count" });
  });
  it("Test F: unexplained increase needs review, with no units and no money", () => {
    const r = run({ opening: 50, closing: { counted: true, quantity: 80, countedAt: CLOSE } });
    expect(r).toMatchObject({ status: "needs_review", reason: "stock_increase_unexplained" });
    expect(r).not.toHaveProperty("unitsSold");
    expect(r).not.toHaveProperty("estimatedAmount");
  });
  it("Test F variant: the same increase explained by a recorded delivery is fine", () => {
    expect(run({ opening: 50, closing: { counted: true, quantity: 80, countedAt: CLOSE }, movements: [mv("stock_received", 40)] })).toMatchObject({ status: "calculated", unitsSold: "10" });
  });
  it("Test G: the last day of a month stays pending until the next month's first count", () => {
    // Nov 30 opening exists; Dec 1 count not entered yet.
    expect(run({ closing: null, openedAt: "2026-11-30T02:30:00Z" })).toEqual({ status: "pending", reason: "awaiting_next_count" });
  });
  it("a skipped day is 'missing_count', not 'awaiting'", () => {
    expect(run({ closing: null, hasLaterCount: true })).toEqual({ status: "pending", reason: "missing_count" });
  });
  it("Test I: money uses the price handed in (the price on the sales date), not any 'latest' price", () => {
    expect(run({ sellingPrice: "150" })).toMatchObject({ estimatedAmount: "4200.00" });
    expect(run({ sellingPrice: "165" })).toMatchObject({ estimatedAmount: "4620.00" });
  });
});

describe("pending, zero and prices", () => {
  it("product not counted on either morning is pending with the right reason", () => {
    expect(run({ opening: null })).toEqual({ status: "pending", reason: "opening_not_counted" });
    expect(run({ closing: { counted: false, quantity: null, countedAt: CLOSE } })).toEqual({ status: "pending", reason: "closing_not_counted" });
  });
  it("an explicit zero closing count means everything sold", () => {
    expect(run({ closing: { counted: true, quantity: 0, countedAt: CLOSE } })).toMatchObject({ status: "calculated", unitsSold: "100" });
  });
  it("no price -> units but no money", () => {
    expect(run({ sellingPrice: null })).toMatchObject({ status: "calculated", unitsSold: "28", estimatedAmount: null });
  });
  it("returns add stock; supplier returns and expired/discarded remove it; adjustments are signed", () => {
    expect(run({ movements: [mv("customer_return", 3), mv("supplier_return", -5), mv("expired", -2), mv("discarded", -1), mv("manual_adjustment", -4), mv("repacking", 6)] }))
      .toMatchObject({ unitsSold: "25", breakdown: { returns: "3", otherOut: "5", damaged: "3", adjustments: "2" } }); // 100 +3 -5 -3 +2 = 97 available; 97 - 72 = 25
  });
});

describe("which movements belong to the interval (early-morning deliveries)", () => {
  it("a delivery BEFORE the closing count is in this interval; one AFTER it is not", () => {
    const early = mv("stock_received", 20, "2026-11-02T00:30:00Z"); // 06:00 Colombo: on the shelf when counted at 08:00
    const late = mv("stock_received", 50, "2026-11-02T05:00:00Z");  // 10:30: belongs to the next interval
    expect(run({ movements: [early, late] })).toMatchObject({ unitsSold: "48" });
  });
  it("boundaries are (open, close]: at the opening time = previous interval, at the closing time = this one", () => {
    expect(movementsInInterval([mv("stock_received", 1, OPEN), mv("stock_received", 2, CLOSE), mv("stock_received", 4, "2026-11-01T10:00:00Z")], OPEN, CLOSE).map((m) => m.effect)).toEqual([2, 4]);
  });
  it("movements outside the interval are ignored", () => {
    expect(run({ movements: [mv("stock_received", 999, "2026-10-01T00:00:00Z")] })).toMatchObject({ unitsSold: "28" });
  });
});

describe("signedEffect / classifyMovements", () => {
  it("applies the fixed sign of each type", () => {
    expect(signedEffect("stock_received", 5)).toBe("5");
    expect(signedEffect("damaged", "2.5")).toBe("-2.5");
    expect(signedEffect("manual_adjustment", 3, "out")).toBe("-3");
    expect(signedEffect("repacking", 3, "in")).toBe("3");
  });
  it("rejects contradictions and bad quantities", () => {
    expect(() => signedEffect("stock_received", 5, "out")).toThrow("DIRECTION_CONFLICT");
    expect(() => signedEffect("damaged", 5, "in")).toThrow("DIRECTION_CONFLICT");
    expect(() => signedEffect("manual_adjustment", 5)).toThrow("DIRECTION_REQUIRED");
    for (const bad of [0, -1, "abc", Infinity]) expect(() => signedEffect("stock_received", bad as number)).toThrow();
  });
  it("classifies without float drift", () => {
    expect(classifyMovements([{ type: "stock_received", effect: "0.1" }, { type: "stock_received", effect: "0.2" }]).received).toBe("0.3");
  });
});
