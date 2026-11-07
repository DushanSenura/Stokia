// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const SHOP = "11111111-1111-4111-8111-111111111111";
const VARIANT = "00000000-0000-4000-8000-000000000001";
const UNIT = "00000000-0000-4000-8000-0000000000b1";

const rpc = vi.fn();
const update = vi.fn();
const updates: { table: string; row: Record<string, unknown>; eq: [string, unknown][] }[] = [];
const fakeSupabase = {
  from(table: string) {
    const rec = { table, row: {} as Record<string, unknown>, eq: [] as [string, unknown][] };
    const chain: Record<string, unknown> = {};
    chain.update = (row: Record<string, unknown>) => { rec.row = row; updates.push(rec); update(table, row); return chain; };
    chain.eq = (c: string, v: unknown) => { rec.eq.push([c, v]); return chain; };
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(update.mock.results.at(-1)?.value ?? { error: null }).then(res);
    return chain;
  },
  rpc: (...a: unknown[]) => rpc(...a),
};
const guard = vi.fn();
vi.mock("@/server/services/guard", async () => ({
  requireRole: (...a: unknown[]) => guard(...a),
  mapDbError: (e: { message?: string } | null) => (/FORBIDDEN/.test(e?.message ?? "") ? "error.forbidden" : "auth.error.generic"),
}));
vi.mock("@/server/services/session", () => ({ getSessionContext: async () => ({ user: { id: "u" }, membership: { shopId: SHOP, timezone: "Asia/Colombo", role: "owner" } }) }));
vi.mock("@/server/repositories/packaging", () => ({ getVariantPackaging: vi.fn(), toPackUnit: vi.fn() }));

import { setBaseUnitSellableAction, setPackagingPriceAction, updatePackagingUseAction } from "@/server/actions/packaging";

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: "price-id", error: null });
  update.mockReset().mockReturnValue({ error: null });
  updates.length = 0;
  guard.mockReset().mockResolvedValue({ ok: true, userId: "u", shopId: SHOP, role: "owner", supabase: fakeSupabase });
});

describe("what a unit is for (sold / counted)", () => {
  it("Carton: stock only (counted, not sold)", async () => {
    expect(await updatePackagingUseAction(VARIANT, UNIT, {}, fd({ can_be_counted: "on" }))).toEqual({ success: "common.saved" });
    expect(updates[0]).toMatchObject({ table: "packaging_units", row: { can_be_sold: false, can_be_counted: true }, eq: [["id", UNIT], ["variant_id", VARIANT]] });
  });

  it("Box: stock and sales", async () => {
    await updatePackagingUseAction(VARIANT, UNIT, {}, fd({ can_be_sold: "on", can_be_counted: "on" }));
    expect(updates[0].row).toEqual({ can_be_sold: true, can_be_counted: true });
  });

  it("a unit that is neither counted nor sold is refused (deactivate it instead), and nothing is written", async () => {
    expect(await updatePackagingUseAction(VARIANT, UNIT, {}, fd({}))).toEqual({ error: "pk.err.useNone" });
    expect(updates).toHaveLength(0);
  });

  it("only owners (who may change the catalog) can do it", async () => {
    guard.mockResolvedValue({ ok: false, error: "error.forbidden" });
    expect(await updatePackagingUseAction(VARIANT, UNIT, {}, fd({ can_be_sold: "on" }))).toEqual({ error: "error.forbidden" });
    expect(guard).toHaveBeenCalledWith(["owner"]);
    expect(updates).toHaveLength(0);
  });

  it("a database refusal becomes a message, not raw text", async () => {
    update.mockReturnValue({ error: { message: "FORBIDDEN" } });
    expect(await updatePackagingUseAction(VARIANT, UNIT, {}, fd({ can_be_sold: "on" }))).toEqual({ error: "error.forbidden" });
  });

  it("the base unit's own identity: sold or not", async () => {
    await setBaseUnitSellableAction(VARIANT, {}, fd({ base_unit_sellable: "on" }));
    expect(updates[0]).toMatchObject({ table: "product_variants", row: { base_unit_sellable: true }, eq: [["id", VARIANT]] });
    await setBaseUnitSellableAction(VARIANT, {}, fd({}));
    expect(updates[1].row).toEqual({ base_unit_sellable: false });
  });
});

describe("packaging-level selling prices", () => {
  const price = (o: Record<string, string>) => setPackagingPriceAction(VARIANT, UNIT, {}, fd(o));

  it("Box Rs. 550 from now: goes to the database function (which closes the previous period, never edits it)", async () => {
    const before = Date.now();
    expect(await price({ amount: "550" })).toEqual({ success: "pk.price.saved" });
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe("set_packaging_price");
    expect(args).toMatchObject({ p_unit: UNIT, p_amount: 550 });
    expect(new Date(args.p_effective_from).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("a chosen start date is the START of that day in the shop's time zone (00:00 Colombo = 18:30 UTC the day before)", async () => {
    await price({ amount: "550.50", effective_from: "2026-10-01" });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_amount: 550.5, p_effective_from: "2026-09-30T18:30:00.000Z" });
  });

  it("refuses amounts that are not money, before asking the database", async () => {
    for (const bad of ["", "abc", "-5", "5.555", "1e3", "99999999999"]) expect(await price({ amount: bad }), bad).toEqual({ fieldErrors: { amount: "pk.err.priceAmount" } });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a malformed date", async () => {
    expect(await price({ amount: "550", effective_from: "tomorrow" })).toEqual({ fieldErrors: { effective_from: "pk.err.priceDate" } });
    expect(await price({ amount: "550", effective_from: "2026-13-45" })).toEqual({ fieldErrors: { effective_from: "pk.err.priceDate" } });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a zero price is allowed (a free item), a unit that is not sold is told to turn selling on first", async () => {
    expect(await price({ amount: "0" })).toEqual({ success: "pk.price.saved" });
    rpc.mockResolvedValue({ data: null, error: { message: "NOT_SELLABLE" } });
    expect(await price({ amount: "550" })).toEqual({ error: "pk.price.needsSold" });
  });

  it("a new price that starts before the latest one began is refused, on the date field", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "PRICE_PERIOD_CONFLICT" } });
    expect(await price({ amount: "550", effective_from: "2026-01-01" })).toEqual({ fieldErrors: { effective_from: "pk.price.conflict" } });
  });

  it("only owners set prices", async () => {
    guard.mockResolvedValue({ ok: false, error: "error.forbidden" });
    expect(await price({ amount: "550" })).toEqual({ error: "error.forbidden" });
    expect(rpc).not.toHaveBeenCalled();
  });
});
