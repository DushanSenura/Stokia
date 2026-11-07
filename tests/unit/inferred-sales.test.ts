import { describe, expect, it } from "vitest";
import {
  calculateEstimatedSalesValue,
  calculateInferredUnitsSold,
} from "@/lib/calculations/inferred-sales";

describe("calculateInferredUnitsSold", () => {
  it("A: basic sales (100 -> 72 = 28)", () => {
    expect(calculateInferredUnitsSold({ opening: 100, closing: 72 })).toMatchObject({
      status: "calculated",
      unitsSold: "28",
    });
  });
  it("B: stock received (100 + 20 - 72 = 48)", () => {
    expect(calculateInferredUnitsSold({ opening: 100, received: 20, closing: 72 })).toMatchObject({
      status: "calculated",
      unitsSold: "48",
    });
  });
  it("C: damaged stock (100 + 20 - 2 - 72 = 46)", () => {
    expect(
      calculateInferredUnitsSold({ opening: 100, received: 20, damaged: 2, closing: 72 }),
    ).toMatchObject({ status: "calculated", unitsSold: "46" });
  });
  it("D: bundles already normalized (120 -> 89 = 31)", () => {
    expect(calculateInferredUnitsSold({ opening: 10 * 12, closing: 7 * 12 + 5 })).toMatchObject({
      status: "calculated",
      unitsSold: "31",
    });
  });
  it("E: missing count is pending, not everything sold", () => {
    expect(calculateInferredUnitsSold({ opening: 100, closing: null })).toEqual({
      status: "pending",
      reason: "missing_closing",
    });
    expect(calculateInferredUnitsSold({ opening: undefined, closing: 5 })).toMatchObject({
      status: "pending",
    });
  });
  it("an explicit zero count is a real count", () => {
    expect(calculateInferredUnitsSold({ opening: 10, closing: 0 })).toMatchObject({
      status: "calculated",
      unitsSold: "10",
    });
  });
  it("F: unexpected increase needs review, with no sales value", () => {
    const r = calculateInferredUnitsSold({ opening: 50, closing: 80 });
    expect(r).toMatchObject({ status: "needs_review", reason: "negative_sales", unitsSold: null });
  });
  it("increase explained by a receipt is fine", () => {
    expect(calculateInferredUnitsSold({ opening: 50, received: 40, closing: 80 })).toMatchObject({
      status: "calculated",
      unitsSold: "10",
    });
  });
  it("signed adjustments are applied", () => {
    expect(calculateInferredUnitsSold({ opening: 50, adjustments: -3, closing: 40 })).toMatchObject({
      unitsSold: "7",
    });
  });
  it("rejects negative counts", () => {
    expect(calculateInferredUnitsSold({ opening: -1, closing: 0 })).toMatchObject({
      status: "needs_review",
      reason: "invalid_quantity",
    });
  });
  it("is decimal-safe", () => {
    expect(calculateInferredUnitsSold({ opening: "0.3", closing: "0.1" })).toMatchObject({
      unitsSold: "0.2",
    });
  });
});

describe("calculateEstimatedSalesValue", () => {
  it("28 packets x Rs. 150 = 4200.00", () => {
    expect(calculateEstimatedSalesValue(28, 150)).toBe("4200.00");
  });
  it("rounds half up to 2dp without float drift", () => {
    expect(calculateEstimatedSalesValue("3", "0.335")).toBe("1.01");
  });
});
