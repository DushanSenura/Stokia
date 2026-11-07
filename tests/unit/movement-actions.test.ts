// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const SHOP = "11111111-1111-4111-8111-111111111111";
const V1 = "00000000-0000-4000-8000-000000000001";
const V2 = "00000000-0000-4000-8000-000000000002";
const BUNDLE = "00000000-0000-4000-8000-0000000000b1";
const KEY = "key-12345678";

const rpc = vi.fn();
let countedAt: string | null = null;
const variants: Record<string, unknown> = {
  [V1]: { base_inventory_unit: "packet", packaging_units: [{ id: BUNDLE, variant_id: V1, name: "Bundle", parent_unit_id: null, conversion_factor: "12", base_unit_multiplier: "12", is_active: true }] },
  [V2]: { base_inventory_unit: "bottle", packaging_units: [] },
};

const fakeSupabase = {
  from(table: string) {
    let id: string | null = null;
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = (col: string, val: string) => { if (col === "id") id = val; return chain; };
    chain.maybeSingle = async () => table === "product_variants" ? { data: id ? variants[id] ?? null : null, error: null } : { data: countedAt ? { counted_at: countedAt } : null, error: null };
    return chain;
  },
  rpc: (...a: unknown[]) => rpc(...a),
};
const guard = vi.fn();
vi.mock("@/server/services/guard", () => ({ requireRole: (...a: unknown[]) => guard(...a) }));
vi.mock("@/server/services/session", () => ({ getSessionContext: async () => ({ user: { id: "u" }, membership: { shopId: SHOP, timezone: "Asia/Colombo", role: "stock_manager" } }) }));

import { recordMovementAction, recordRepackingAction, reverseMovementAction } from "@/server/actions/movements";

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const base = { variant_id: V1, type: "stock_received", quantity: "2", unit_id: BUNDLE, when: "now", reason: "Supplier delivery", key: KEY };
const call = (over: Record<string, string> = {}) => recordMovementAction({}, fd({ ...base, ...over }));

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: { id: "m1", duplicate: false }, error: null });
  guard.mockReset().mockResolvedValue({ ok: true, userId: "u", shopId: SHOP, role: "stock_manager", supabase: fakeSupabase });
  countedAt = null;
});

describe("recordMovementAction", () => {
  it("computes the SIGNED base effect on the server from stored packaging (2 bundles x 12 = +24)", async () => {
    expect(await call()).toEqual({ success: "mv.recorded" });
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe("record_movement");
    expect(args).toMatchObject({ p_shop: SHOP, p_variant: V1, p_type: "stock_received", p_input_quantity: 2, p_input_unit: BUNDLE, p_effect: 24, p_key: KEY, p_reason: "Supplier delivery" });
  });

  it("applies the fixed sign of each type: damaged is negative, manual adjustments follow the chosen direction", async () => {
    await call({ type: "damaged", unit_id: "", quantity: "3" });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_type: "damaged", p_effect: -3, p_input_unit: null });
    await call({ type: "manual_adjustment", direction: "out", unit_id: "", quantity: "4", key: "key-22222222" });
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_effect: -4 });
    await call({ type: "manual_adjustment", direction: "in", unit_id: "", quantity: "4", key: "key-33333333" });
    expect(rpc.mock.calls[2][1]).toMatchObject({ p_effect: 4 });
  });

  it("requires a direction for manual adjustments, a reason or reference, and valid quantities", async () => {
    expect(await call({ type: "manual_adjustment", unit_id: "" })).toMatchObject({ fieldErrors: { direction: "mv.err.direction" } });
    expect(await call({ reason: "" })).toMatchObject({ fieldErrors: { reason: "mv.err.reason" } });
    expect(await call({ reference: "INV-7", reason: "" })).toEqual({ success: "mv.recorded" });
    for (const q of ["0", "-2", "abc", "1.2345", ""]) expect(await call({ quantity: q, unit_id: "" })).toMatchObject({ fieldErrors: { quantity: "mv.err.quantity" } });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects fractional packages before reaching the database", async () => {
    expect(await call({ quantity: "2.5" })).toMatchObject({ fieldErrors: { quantity: "mv.err.quantity" } });
  });

  it("rejects a product that is not in the caller's shop, and requires an idempotency key", async () => {
    expect(await call({ variant_id: "00000000-0000-4000-8000-0000000000ee" })).toMatchObject({ fieldErrors: { variant_id: "mv.err.INVALID_VARIANT" } });
    expect(await call({ key: "x" })).toMatchObject({ fieldErrors: { key: "auth.error.generic" } });
    expect(rpc).not.toHaveBeenCalled();
  });

  describe("timing (which counting interval the movement belongs to)", () => {
    it("'now' uses the current time", async () => {
      const before = Date.now();
      await call();
      const at = new Date(rpc.mock.calls[0][1].p_effective_at).getTime();
      expect(at).toBeGreaterThanOrEqual(before - 1000);
      expect(at).toBeLessThanOrEqual(Date.now() + 1000);
    });
    it("'before_count' is stamped just BEFORE today's count started, so it is part of that count", async () => {
      countedAt = "2026-11-06T02:30:00.000Z";
      await call({ when: "before_count" });
      expect(rpc.mock.calls[0][1].p_effective_at).toBe("2026-11-06T02:29:00.000Z");
    });
    it("'before_count' without a count today is refused with guidance", async () => {
      expect(await call({ when: "before_count" })).toMatchObject({ fieldErrors: { when: "mv.err.noCountToday" } });
      expect(rpc).not.toHaveBeenCalled();
    });
    it("'custom' is read in the SHOP timezone (08:15 Colombo = 02:45 UTC)", async () => {
      await call({ when: "custom", effective_local: "2026-11-05T08:15" });
      expect(rpc.mock.calls[0][1].p_effective_at).toBe("2026-11-05T02:45:00.000Z");
      expect(await call({ when: "custom", effective_local: "garbage" })).toMatchObject({ fieldErrors: { effective_local: "mv.err.time" } });
      expect(await call({ when: "custom" })).toMatchObject({ fieldErrors: { effective_local: "mv.err.time" } });
    });
  });

  it("a retry that the database recognises as a duplicate reports it, and never double-applies", async () => {
    rpc.mockResolvedValue({ data: { id: "m1", duplicate: true }, error: null });
    expect(await call()).toEqual({ success: "mv.duplicate" });
  });

  it("maps database refusals to friendly messages without leaking internals", async () => {
    for (const [msg, key] of [["FUTURE_TIME", "mv.err.FUTURE_TIME"], ["IDEMPOTENCY_MISMATCH", "mv.err.IDEMPOTENCY_MISMATCH"], ["FORBIDDEN", "error.forbidden"], ["syntax error at or near select", "auth.error.generic"]] as const) {
      rpc.mockResolvedValueOnce({ data: null, error: { message: msg } });
      expect(await call()).toEqual({ error: key });
    }
  });

  it("is denied for viewers", async () => {
    guard.mockResolvedValue({ ok: false, error: "error.forbidden" });
    expect(await call()).toEqual({ error: "error.forbidden" });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("recordRepackingAction", () => {
  const rb = { from_variant: V1, from_quantity: "1", from_unit: BUNDLE, to_variant: V2, to_quantity: "12", when: "now", reason: "Split bundle", key: KEY };
  it("converts both sides to base units on the server (1 bundle = 12 packets out, 12 bottles in)", async () => {
    rpc.mockResolvedValue({ data: { group_id: "g", duplicate: false }, error: null });
    expect(await recordRepackingAction({}, fd(rb))).toEqual({ success: "mv.recorded" });
    expect(rpc.mock.calls[0]).toEqual(["record_repacking", expect.objectContaining({ p_from_variant: V1, p_from_qty: 12, p_to_variant: V2, p_to_qty: 12, p_key: KEY, p_reason: "Split bundle" })]);
  });
  it("needs two different products and a reason", async () => {
    expect(await recordRepackingAction({}, fd({ ...rb, to_variant: V1 }))).toMatchObject({ fieldErrors: { to_variant: "mv.err.sameVariant" } });
    expect(await recordRepackingAction({}, fd({ ...rb, reason: "" }))).toMatchObject({ fieldErrors: { reason: "mv.err.reason" } });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("reverseMovementAction", () => {
  it("requires a reason and passes the idempotency key", async () => {
    expect(await reverseMovementAction("m1", {}, fd({ reason: "", key: KEY }))).toMatchObject({ fieldErrors: { reason: "mv.err.reason" } });
    rpc.mockResolvedValue({ data: { id: "r1", duplicate: false }, error: null });
    expect(await reverseMovementAction("m1", {}, fd({ reason: "Typo", key: KEY }))).toEqual({ success: "mv.reversed" });
    expect(rpc).toHaveBeenCalledWith("reverse_movement", { p_movement: "m1", p_reason: "Typo", p_key: KEY });
  });
  it("surfaces 'cannot reverse a reversal'", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "IS_REVERSAL" } });
    expect(await reverseMovementAction("m1", {}, fd({ reason: "x", key: KEY }))).toEqual({ error: "mv.err.IS_REVERSAL" });
  });
});
