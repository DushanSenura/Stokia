// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { buildCountLines } from "@/server/services/count-submit";

const SHOP = "11111111-1111-4111-8111-111111111111";
const V = "00000000-0000-4000-8000-000000000001";
const BOX = "00000000-0000-4000-8000-0000000000b1";
const CARTON = "00000000-0000-4000-8000-0000000000b2";

const supabase = {
  from() {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) chain[m] = () => chain;
    chain.in = async () => ({ error: null, data: [{
      id: V, base_inventory_unit: "piece",
      packaging_units: [
        { id: BOX, variant_id: V, name: "Box", parent_unit_id: null, conversion_factor: "20", base_unit_multiplier: "20", is_active: true, can_be_counted: false },
        { id: CARTON, variant_id: V, name: "Carton", parent_unit_id: BOX, conversion_factor: "10", base_unit_multiplier: "200", is_active: true, can_be_counted: true },
      ],
    }] });
    return chain;
  },
};
const ctx = { supabase: supabase as never, shopId: SHOP };

describe("the server and units that are not used in counts", () => {
  it("accepts a carton (counted) even though the box it is made of is not counted: 2 cartons + 8 pieces = 408", async () => {
    const r = await buildCountLines(ctx, [{ variantId: V, entries: [{ unitId: CARTON, quantity: "2" }, { unitId: null, quantity: "8" }] }]);
    expect(r.itemErrors).toEqual({});
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ variant_id: V, normalized_base_quantity: "408" });
  });

  it("refuses an entry in the box, even from an old draft or a modified client (it is sold, not counted)", async () => {
    const r = await buildCountLines(ctx, [{ variantId: V, entries: [{ unitId: BOX, quantity: "3" }] }]);
    expect(r.itemErrors).toEqual({ [V]: "unknown_unit" });
    expect(r.lines).toEqual([]);
  });

  it("loose pieces are always fine, and blank still means not counted", async () => {
    expect((await buildCountLines(ctx, [{ variantId: V, entries: [{ unitId: null, quantity: "5" }] }])).lines[0]).toMatchObject({ normalized_base_quantity: "5" });
    const blank = await buildCountLines(ctx, [{ variantId: V, entries: [{ unitId: null, quantity: "" }] }]);
    expect(blank.lines).toEqual([]);
    expect(blank.itemErrors).toEqual({});
  });
});
