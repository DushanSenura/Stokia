// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import type { MovementListRow } from "@/server/repositories/movements";
import { toPhoneMovement } from "@/server/services/movement-list";

const row = (over: Partial<MovementListRow> = {}): MovementListRow => ({
  id: "m1", type: "stock_received", input_quantity: "3.000", normalized_base_quantity: "36.000", effective_at: "2026-11-07T04:00:00Z", created_at: "2026-11-07T04:00:05Z",
  reason: "Weekly delivery", reference: null, supplier: "Perera Traders", purchase_cost_lkr: null, created_by: "u1", reversed_movement_id: null, group_id: null,
  packaging_units: { name: "Bundle" },
  product_variants: { sku: "CHL-250", size_value: "250", size_unit: "g", base_inventory_unit: "packet", products: { name: "Chilli Powder" } }, ...over,
});
const none = new Set<string>();
const people = new Map([["u1", "Nimal"]]);

describe("toPhoneMovement", () => {
  it("shows the product and size, what was entered, the signed effect in the base unit, and who did it", () => {
    expect(toPhoneMovement(row(), none, people)).toMatchObject({
      id: "m1", type: "stock_received", label: "Chilli Powder 250 g", sku: "CHL-250", baseUnit: "packet", entered: "3 Bundle", effect: "36", by: "Nimal", supplier: "Perera Traders",
    });
  });
  it("a removal keeps its minus sign, and loose items are described in the base unit", () => {
    const m = toPhoneMovement(row({ type: "damaged", input_quantity: "5.000", normalized_base_quantity: "-5.000", packaging_units: null }), none, people);
    expect(m).toMatchObject({ effect: "-5", entered: "5 packet" });
  });
  it("an unknown person is null, never a made-up name", () => {
    expect(toPhoneMovement(row({ created_by: "ghost" }), none, people).by).toBeNull();
  });

  describe("which movements may be reversed", () => {
    it("an ordinary movement can be", () => expect(toPhoneMovement(row(), none, people).canReverse).toBe(true));
    it("one that was already reversed cannot (and says so)", () => {
      const m = toPhoneMovement(row(), new Set(["m1"]), people);
      expect(m).toMatchObject({ reversed: true, canReverse: false });
    });
    it("a reversal itself cannot be reversed", () => {
      const m = toPhoneMovement(row({ reversed_movement_id: "m0", type: "manual_adjustment" }), none, people);
      expect(m).toMatchObject({ isReversal: true, canReverse: false });
    });
    it("one half of a repacking cannot be reversed on its own (it would create or destroy stock)", () => {
      expect(toPhoneMovement(row({ type: "repacking", group_id: "g1" }), none, people).canReverse).toBe(false);
    });
  });
});
