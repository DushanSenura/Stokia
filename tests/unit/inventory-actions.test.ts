// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { revalidatePath } from "next/cache";

const SHOP = "11111111-1111-4111-8111-111111111111";
const V1 = "00000000-0000-4000-8000-000000000001";
const V2 = "00000000-0000-4000-8000-000000000002";
const BUNDLE = "00000000-0000-4000-8000-0000000000b1";

const rpc = vi.fn();
let sessionRow: { id: string; revision: number } | null = null;

/** Minimal chainable stand-in for the Supabase client used by the actions. */
const fakeSupabase = {
  from(table: string) {
    const chain: Record<string, unknown> = {};
    const result = () =>
      table === "product_variants"
        ? { data: [{ id: V1, base_inventory_unit: "packet", packaging_units: [{ id: BUNDLE, variant_id: V1, name: "Bundle", parent_unit_id: null, conversion_factor: "12", base_unit_multiplier: "12", is_active: true }] }], error: null }
        : { data: sessionRow, error: null };
    for (const m of ["select", "eq", "in"]) chain[m] = () => chain;
    chain.maybeSingle = async () => result();
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res);
    return chain;
  },
  rpc: (...a: unknown[]) => rpc(...a),
};

const guard = vi.fn();
vi.mock("@/server/services/guard", () => ({ requireRole: (...a: unknown[]) => guard(...a), mapDbError: () => "auth.error.generic" }));

import { confirmCountAction, saveDraftAction } from "@/server/actions/inventory";

const input = (over = {}) => ({ businessDate: "2026-11-02", revision: null, items: [{ variantId: V1, entries: [{ unitId: BUNDLE, quantity: "7" }, { unitId: null, quantity: "5" }] }], ...over });

beforeEach(() => {
  vi.mocked(revalidatePath).mockClear();
  rpc.mockReset();
  guard.mockReset().mockResolvedValue({ ok: true, userId: "u", shopId: SHOP, role: "stock_manager", supabase: fakeSupabase });
  sessionRow = null;
});

describe("saveDraftAction", () => {
  it("recomputes the base quantity on the server from stored packaging and snapshots the multipliers", async () => {
    rpc.mockResolvedValue({ data: { session_id: "s1", revision: 2, counted: 1 }, error: null });
    const r = await saveDraftAction(input());
    expect(r).toEqual({ ok: true, sessionId: "s1", revision: 2, counted: 1 });
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe("save_count_draft");
    expect(args).toMatchObject({ p_shop: SHOP, p_date: "2026-11-02", p_revision: null });
    expect(args.p_lines).toEqual([{
      variant_id: V1, normalized_base_quantity: "89",
      entry_details: { version: 1, base_unit: "packet", entries: [{ unit_id: BUNDLE, unit_name: "Bundle", quantity: "7", multiplier: "12" }, { unit_id: null, unit_name: "packet", quantity: "5", multiplier: "1" }] },
    }]);
  });

  it("rejects invalid quantities with per-product errors and writes nothing", async () => {
    const r = await saveDraftAction(input({ items: [{ variantId: V1, entries: [{ unitId: BUNDLE, quantity: "2.5" }] }] }));
    expect(r).toEqual({ ok: false, error: "ms.err.INVALID_ITEMS", itemErrors: { [V1]: "fractional_package" } });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a product that is not in the caller's shop (not returned by the shop-scoped query)", async () => {
    const r = await saveDraftAction(input({ items: [{ variantId: V2, entries: [{ unitId: null, quantity: "1" }] }] }));
    expect(r).toMatchObject({ ok: false, itemErrors: { [V2]: "unknown_unit" } });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a packaging unit id that belongs to another variant", async () => {
    const r = await saveDraftAction(input({ items: [{ variantId: V1, entries: [{ unitId: "00000000-0000-4000-8000-0000000000ff", quantity: "1" }] }] }));
    expect(r).toMatchObject({ ok: false, itemErrors: { [V1]: "unknown_unit" } });
  });

  it("omits blank rows (not counted) from what is stored", async () => {
    rpc.mockResolvedValue({ data: { session_id: "s1", revision: 3, counted: 0 }, error: null });
    await saveDraftAction(input({ revision: 2, items: [{ variantId: V1, entries: [{ unitId: BUNDLE, quantity: "" }, { unitId: null, quantity: "  " }] }] }));
    expect(rpc.mock.calls[0][1].p_lines).toEqual([]);
  });

  it("maps a revision conflict so the UI can ask for a reload", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "REVISION_CONFLICT" } });
    expect(await saveDraftAction(input({ revision: 1 }))).toEqual({ ok: false, error: "ms.conflict", conflict: true });
  });

  it("maps database rule violations to friendly messages", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "COUNT_OUT_OF_ORDER" } });
    expect(await saveDraftAction(input())).toEqual({ ok: false, error: "ms.err.COUNT_OUT_OF_ORDER" });
    rpc.mockResolvedValue({ data: null, error: { message: "FUTURE_DATE" } });
    expect(await saveDraftAction(input())).toEqual({ ok: false, error: "ms.err.FUTURE_DATE" });
  });

  it("validates the payload shape (dates, ids, sizes)", async () => {
    for (const bad of [{ businessDate: "2026-02-31" }, { businessDate: "tomorrow" }, { revision: -1 }, { items: [{ variantId: "nope", entries: [] }] }, { items: [{ variantId: V1, entries: [{ unitId: null, quantity: "1".repeat(30) }] }] }]) {
      expect(await saveDraftAction(input(bad))).toEqual({ ok: false, error: "ms.err.INVALID_PAYLOAD" });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("is denied for users without permission (viewers/outsiders)", async () => {
    guard.mockResolvedValue({ ok: false, error: "error.forbidden" });
    expect(await saveDraftAction(input())).toEqual({ ok: false, error: "error.forbidden" });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("confirmCountAction", () => {
  const KEY = "key-0123456789";

  it("saves and confirms in ONE database call, sending the idempotency key and the revision the device last saw", async () => {
    rpc.mockResolvedValueOnce({ data: { status: "confirmed", session_id: "s1", revision: 6, counted: 1, replayed: false }, error: null });
    const r = await confirmCountAction(input({ revision: 4 }), true, KEY);
    expect(r).toMatchObject({ ok: true, confirmed: true, sessionId: "s1", revision: 6, alreadyConfirmed: false });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe("submit_count");
    expect(args).toMatchObject({ p_shop: SHOP, p_date: "2026-11-02", p_base_revision: 4, p_key: KEY, p_confirm: true, p_ack_missing: true, p_device: null });
    expect(args.p_lines).toHaveLength(1);
  });

  it("passes the missing-count acknowledgement through and surfaces MISSING_COUNTS", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "MISSING_COUNTS" } });
    expect(await confirmCountAction(input(), false, KEY)).toEqual({ ok: false, error: "ms.err.MISSING_COUNTS" });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_ack_missing: false });
  });

  it("never revalidates a path: inside a Server Action that re-renders the page the person is on, which replaces the form's success screen with the static 'confirmed' page", async () => {
    rpc.mockResolvedValueOnce({ data: { status: "confirmed", session_id: "s1", revision: 6, counted: 1, replayed: false }, error: null });
    await confirmCountAction(input(), true, KEY);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("a retry whose first answer was lost gets the original result and is reported as already confirmed", async () => {
    rpc.mockResolvedValueOnce({ data: { status: "confirmed", session_id: "s1", revision: 7, counted: 1, replayed: true }, error: null });
    expect(await confirmCountAction(input(), true, KEY)).toMatchObject({ ok: true, confirmed: true, alreadyConfirmed: true, sessionId: "s1", revision: 7 });
  });

  it("another device confirmed first: a conflict carrying the server's copy, never a success", async () => {
    rpc.mockResolvedValueOnce({ data: {
      status: "conflict", reason: "already_confirmed",
      server: { session_id: "s9", revision: 3, status: "confirmed", by: "Nimal", confirmed_at: "2026-11-02T03:00:00Z", lines: [{ variant_id: V1, quantity: "70.000" }] },
    }, error: null });
    const r = await confirmCountAction(input(), true, KEY);
    expect(r).toEqual({
      ok: false, error: "ms.conflictConfirmed", conflict: true,
      conflictInfo: { reason: "already_confirmed", server: { sessionId: "s9", revision: 3, status: "confirmed", by: "Nimal", confirmedAt: "2026-11-02T03:00:00Z", lines: [{ variantId: V1, quantity: "70.000" }] } },
    });
  });

  it("a stale revision is a conflict too (with a different message)", async () => {
    rpc.mockResolvedValueOnce({ data: { status: "conflict", reason: "revision", server: null }, error: null });
    expect(await confirmCountAction(input(), true, KEY)).toMatchObject({ ok: false, error: "ms.conflict", conflict: true, conflictInfo: { reason: "revision", server: null } });
  });

  it("refuses a missing or malformed idempotency key without touching the database", async () => {
    for (const bad of ["", "short", "x".repeat(101)]) {
      expect(await confirmCountAction(input(), true, bad)).toEqual({ ok: false, error: "ms.err.INVALID_PAYLOAD" });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not submit when the entries fail validation", async () => {
    const r = await confirmCountAction(input({ items: [{ variantId: V1, entries: [{ unitId: null, quantity: "-1" }] }] }), true, KEY);
    expect(r).toMatchObject({ ok: false, error: "ms.err.INVALID_ITEMS" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a key reused for different data (a client bug) is reported as a generic failure, not success", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "IDEMPOTENCY_KEY_REUSED" } });
    expect(await confirmCountAction(input(), true, KEY)).toEqual({ ok: false, error: "auth.error.generic" });
  });
});
