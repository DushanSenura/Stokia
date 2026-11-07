// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { recordMovementCore, reverseMovementCore } from "@/server/services/movement-submit";

const SHOP = "11111111-1111-4111-8111-111111111111";
const V = "00000000-0000-4000-8000-000000000001";
const BUNDLE = "00000000-0000-4000-8000-0000000000b1";
const OTHER_UNIT = "00000000-0000-4000-8000-0000000000b2";
const KEY = "movement-key-0001";
const MOVEMENT = "00000000-0000-4000-8000-0000000000aa";

const rpc = vi.fn();
let variant: unknown;
let session: unknown;
let eqs: [string, string, unknown][] = [];

const supabase = {
  from(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = (col: string, val: unknown) => { eqs.push([table, col, val]); return chain; };
    chain.maybeSingle = async () => ({ data: table === "product_variants" ? variant : session, error: null });
    return chain;
  },
  rpc: (...a: unknown[]) => rpc(...a),
};
const ctx = { supabase: supabase as never, shopId: SHOP };

const base = (over: Record<string, unknown> = {}) => ({ variant_id: V, type: "stock_received", unit_id: BUNDLE, quantity: "3", when: "now", reason: "Weekly delivery", key: KEY, ...over });

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: { id: "m1", duplicate: false }, error: null });
  session = null;
  eqs = [];
  variant = { base_inventory_unit: "packet", packaging_units: [{ id: BUNDLE, variant_id: V, name: "Bundle", parent_unit_id: null, conversion_factor: "12", base_unit_multiplier: "12", is_active: true }] };
});

describe("recording a movement", () => {
  it("converts bundles to the base unit on the server and sends the signed effect (3 bundles of 12 = +36 packets)", async () => {
    expect(await recordMovementCore(ctx, "Asia/Colombo", base())).toEqual({ ok: true, id: "m1", duplicate: false });
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe("record_movement");
    expect(args).toMatchObject({ p_shop: SHOP, p_variant: V, p_type: "stock_received", p_input_quantity: 3, p_input_unit: BUNDLE, p_effect: 36, p_reason: "Weekly delivery", p_key: KEY });
  });

  it("loose items in the base unit need no packaging unit", async () => {
    await recordMovementCore(ctx, "Asia/Colombo", base({ unit_id: undefined, quantity: "5" }));
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_input_unit: null, p_effect: 5 });
  });

  it("stock leaving for another reason than a sale is NEGATIVE (damaged, expired, discarded, supplier return)", async () => {
    for (const type of ["damaged", "expired", "discarded", "supplier_return"]) {
      rpc.mockClear();
      await recordMovementCore(ctx, "Asia/Colombo", base({ type, unit_id: undefined, quantity: "5" }));
      expect(rpc.mock.calls[0][1].p_effect, type).toBe(-5);
    }
  });

  it("a customer return and stock received are positive", async () => {
    await recordMovementCore(ctx, "Asia/Colombo", base({ type: "customer_return", unit_id: undefined, quantity: "2" }));
    expect(rpc.mock.calls[0][1].p_effect).toBe(2);
  });

  it("a manual adjustment takes its sign from the chosen direction, and refuses to guess", async () => {
    await recordMovementCore(ctx, "Asia/Colombo", base({ type: "manual_adjustment", direction: "out", unit_id: undefined, quantity: "4" }));
    expect(rpc.mock.calls[0][1].p_effect).toBe(-4);
    await recordMovementCore(ctx, "Asia/Colombo", base({ type: "manual_adjustment", direction: "in", unit_id: undefined, quantity: "4" }));
    expect(rpc.mock.calls[1][1].p_effect).toBe(4);
    rpc.mockClear();
    const r = await recordMovementCore(ctx, "Asia/Colombo", base({ type: "manual_adjustment", unit_id: undefined, quantity: "4" }));
    expect(r).toEqual({ ok: false, fieldErrors: { direction: "mv.err.direction" } });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a fixed-sign type contradicted by a direction is refused, not silently flipped", async () => {
    const r = await recordMovementCore(ctx, "Asia/Colombo", base({ type: "damaged", direction: "in", unit_id: undefined }));
    expect(r).toEqual({ ok: false, fieldErrors: { direction: "mv.err.direction" } });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("carries the optional supplier and cost", async () => {
    await recordMovementCore(ctx, "Asia/Colombo", base({ supplier: "Perera Traders", cost: "120.50", reference: "INV-77" }));
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_supplier: "Perera Traders", p_cost: 120.5, p_reference: "INV-77" });
  });
});

describe("what is refused before the database is touched", () => {
  const refused = async (over: Record<string, unknown>) => {
    const r = await recordMovementCore(ctx, "Asia/Colombo", base(over));
    expect(rpc).not.toHaveBeenCalled();
    return r;
  };

  it("needs a reason or a reference", async () => {
    expect(await refused({ reason: undefined })).toEqual({ ok: false, fieldErrors: { reason: "mv.err.reason" } });
    expect(await refused({ reason: "   " })).toMatchObject({ ok: false });
  });
  it("accepts a reference instead of a reason", async () => {
    await recordMovementCore(ctx, "Asia/Colombo", base({ reason: undefined, reference: "INV-1" }));
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("needs a positive quantity with at most three decimals", async () => {
    for (const quantity of ["", "0", "-3", "abc", "1.2345", "1e9"]) expect(await refused({ quantity }), quantity).toMatchObject({ ok: false, fieldErrors: { quantity: "mv.err.quantity" } });
  });
  it("needs an idempotency key", async () => {
    expect((await refused({ key: undefined })).ok).toBe(false);
    expect((await refused({ key: "short" })).ok).toBe(false);
  });
  it("refuses an unknown type, including repacking (it touches two products)", async () => {
    expect(await refused({ type: "repacking" })).toMatchObject({ ok: false, fieldErrors: { type: "mv.err.type" } });
    expect(await refused({ type: "free_stock" })).toMatchObject({ ok: false });
  });
  it("refuses a fractional number of bundles (a bundle is whole)", async () => {
    expect(await refused({ quantity: "2.5" })).toEqual({ ok: false, fieldErrors: { quantity: "mv.err.quantity" } });
  });
  it("refuses a packaging unit that does not belong to the product", async () => {
    expect(await refused({ unit_id: OTHER_UNIT })).toEqual({ ok: false, fieldErrors: { quantity: "mv.err.quantity" } });
  });
  it("refuses a product that is not in this shop", async () => {
    variant = null;
    expect(await refused({})).toEqual({ ok: false, fieldErrors: { variant_id: "mv.err.INVALID_VARIANT" } });
  });
  it("a custom time needs a time", async () => {
    expect(await refused({ when: "custom" })).toMatchObject({ ok: false, fieldErrors: { effective_local: "mv.err.time" } });
  });
});

describe("when the stock moved", () => {
  it("'now' is now", async () => {
    const before = Date.now();
    await recordMovementCore(ctx, "Asia/Colombo", base());
    const at = new Date(rpc.mock.calls[0][1].p_effective_at).getTime();
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("'before today's count' is one minute before that count started, so it belongs to the interval that count closes", async () => {
    session = { counted_at: "2026-11-07T03:30:00.000Z" };
    await recordMovementCore(ctx, "Asia/Colombo", base({ when: "before_count" }));
    expect(rpc.mock.calls[0][1].p_effective_at).toBe("2026-11-07T03:29:00.000Z");
  });

  describe("a movement the phone saved offline and sent later", () => {
    it("'before the count' uses the morning it was ENTERED, not the morning it arrives", async () => {
      session = { counted_at: "2026-11-05T03:30:00.000Z" };
      await recordMovementCore(ctx, "Asia/Colombo", base({ when: "before_count", count_date: "2026-11-05" }));
      expect(eqs).toContainEqual(["stock_count_sessions", "business_date", "2026-11-05"]);
      expect(rpc.mock.calls[0][1].p_effective_at).toBe("2026-11-05T03:29:00.000Z");
    });

    it("a morning in the future is refused", async () => {
      const r = await recordMovementCore(ctx, "Asia/Colombo", base({ when: "before_count", count_date: "2999-01-01" }));
      expect(r).toEqual({ ok: false, fieldErrors: { when: "mv.err.time" } });
      expect(rpc).not.toHaveBeenCalled();
    });

    it("a malformed morning is refused before anything else happens", async () => {
      const r = await recordMovementCore(ctx, "Asia/Colombo", base({ when: "before_count", count_date: "yesterday" }));
      expect(r).toMatchObject({ ok: false, fieldErrors: { count_date: "mv.err.time" } });
      expect(rpc).not.toHaveBeenCalled();
    });

    it("'now' saved offline arrives as the entered time (shop time), not the time of sending", async () => {
      await recordMovementCore(ctx, "Asia/Colombo", base({ when: "custom", effective_local: "2026-11-06T18:45" }));
      expect(rpc.mock.calls[0][1].p_effective_at).toBe("2026-11-06T13:15:00.000Z"); // 18:45 in Colombo (UTC+5:30)
    });
  });

  it("'before today's count' with no count today is refused with an explanation, never guessed", async () => {
    session = null;
    const r = await recordMovementCore(ctx, "Asia/Colombo", base({ when: "before_count" }));
    expect(r).toEqual({ ok: false, fieldErrors: { when: "mv.err.noCountToday" } });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("what the database says", () => {
  const dbError = (message: string) => rpc.mockResolvedValue({ data: null, error: { message } });

  it("a retry with the same key is reported as a duplicate (nothing added twice)", async () => {
    rpc.mockResolvedValue({ data: { id: "m1", duplicate: true }, error: null });
    expect(await recordMovementCore(ctx, "Asia/Colombo", base())).toEqual({ ok: true, id: "m1", duplicate: true });
  });

  it("maps database errors to the web app's own messages and never leaks the raw text", async () => {
    for (const [raw, key] of [["FORBIDDEN", "error.forbidden"], ["FUTURE_TIME", "mv.err.FUTURE_TIME"], ["TOO_OLD", "mv.err.TOO_OLD"], ["IDEMPOTENCY_MISMATCH", "mv.err.IDEMPOTENCY_MISMATCH"], ["REASON_REQUIRED", "mv.err.REASON_REQUIRED"]] as const) {
      dbError(`${raw}: secret detail at /srv/db.sql:12`);
      expect(await recordMovementCore(ctx, "Asia/Colombo", base()), raw).toEqual({ ok: false, error: key });
    }
    dbError("relation \"stock_movements\" does not exist");
    expect(await recordMovementCore(ctx, "Asia/Colombo", base())).toEqual({ ok: false, error: "auth.error.generic" });
  });
});

describe("reversing a movement", () => {
  it("reverses with a reason and a key", async () => {
    rpc.mockResolvedValue({ data: { id: "rev1", duplicate: false }, error: null });
    expect(await reverseMovementCore(ctx, MOVEMENT, { reason: "Typed 30 instead of 3", key: "reverse-key-0001" })).toEqual({ ok: true, id: "rev1", duplicate: false });
    expect(rpc).toHaveBeenCalledWith("reverse_movement", { p_movement: MOVEMENT, p_reason: "Typed 30 instead of 3", p_key: "reverse-key-0001" });
  });
  it("needs a reason and a key, and does not call the database without them", async () => {
    expect(await reverseMovementCore(ctx, MOVEMENT, { reason: "", key: "reverse-key-0001" })).toMatchObject({ ok: false, fieldErrors: { reason: "mv.err.reason" } });
    expect((await reverseMovementCore(ctx, MOVEMENT, { reason: "x", key: "k" })).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("a reversal cannot be reversed, and an unknown movement is not found (mapped, not leaked)", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "IS_REVERSAL" } });
    expect(await reverseMovementCore(ctx, MOVEMENT, { reason: "x", key: "reverse-key-0001" })).toEqual({ ok: false, error: "mv.err.IS_REVERSAL" });
    rpc.mockResolvedValue({ data: null, error: { message: "NOT_FOUND" } });
    expect(await reverseMovementCore(ctx, MOVEMENT, { reason: "x", key: "reverse-key-0001" })).toEqual({ ok: false, error: "mv.err.NOT_FOUND" });
  });
  it("a retry is reported as a duplicate", async () => {
    rpc.mockResolvedValue({ data: { id: "rev1", duplicate: true }, error: null });
    expect(await reverseMovementCore(ctx, MOVEMENT, { reason: "x", key: "reverse-key-0001" })).toMatchObject({ ok: true, duplicate: true });
  });
});
