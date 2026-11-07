// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { breakdownDbError, clearBreakdownCore, loadBreakdownDay, loadBreakdownHistory, saveBreakdownCore } from "@/server/services/sales-breakdown";

const SHOP = "11111111-1111-4111-8111-111111111111";
const V = "00000000-0000-4000-8000-000000000001";
const BOX = "00000000-0000-4000-8000-0000000000b1";
const CARTON = "00000000-0000-4000-8000-0000000000b2";
const TRAY = "00000000-0000-4000-8000-0000000000b3";
const DATE = "2026-11-06";
const TZ = "Asia/Colombo";
const KEY = "breakdown-key-0001";

let tables: Record<string, unknown>;
const rpc = vi.fn();
const queried: { table: string; filters: unknown[][] }[] = [];

const supabase = {
  from(table: string) {
    const rec = { table, filters: [] as unknown[][] };
    queried.push(rec);
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "lte", "or", "order"]) chain[m] = (...a: unknown[]) => { rec.filters.push([m, ...a]); return chain; };
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(res);
    return chain;
  },
  rpc: (...a: unknown[]) => rpc(...a),
};
const ctx = { supabase: supabase as never, shopId: SHOP };

const sale = (over: Record<string, unknown> = {}) => ({ variant_id: V, inferred_base_units_sold: "145.000", estimated_sales_amount: "4350.00", calculation_status: "calculated", packaging_status: "unknown", ...over });
const variant = () => ({
  id: V, sku: "CHOCO-1", size_value: null, size_unit: null, base_inventory_unit: "piece", base_unit_sellable: true, products: { name: "Choco" },
  packaging_units: [
    { id: CARTON, name: "Carton", base_unit_multiplier: "200.000000", can_be_sold: false, is_active: true },
    { id: BOX, name: "Box", base_unit_multiplier: "20.000000", can_be_sold: true, is_active: true },
    { id: TRAY, name: "Tray", base_unit_multiplier: "6.000000", can_be_sold: true, is_active: true },
  ],
});

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: { duplicate: false, revision: 1, amount: 4150 }, error: null });
  queried.length = 0;
  tables = {
    daily_sales: [sale()],
    product_variants: [variant()],
    sales_breakdowns: [],
    product_price_history: [{ variant_id: V, amount_lkr: "30.00" }],
    packaging_unit_price_history: [{ unit_id: BOX, amount_lkr: "550.00" }],
  };
});

describe("loadBreakdownDay", () => {
  it("offers a product with a sellable unit: the inferred units, the day's prices, and the plain estimate it would otherwise get", async () => {
    const day = await loadBreakdownDay(ctx, TZ, DATE);
    expect(day.items).toHaveLength(1);
    const i = day.items[0];
    expect(i).toMatchObject({ variantId: V, name: "Choco", inferred: "145", packagingStatus: "unknown", amount: "4350.00", plainEstimate: "4350.00", current: null });
    expect(i.base).toEqual({ name: "piece", sellable: true, price: "30" });
    // only SELLABLE units are offered (the carton is stock only), each with the price in force that day
    expect(i.units.map((u) => [u.name, u.multiplier, u.price])).toEqual([["Box", "20", "550"], ["Tray", "6", null]]);
  });

  it("asks for the prices in force at NOON on the sales date, in the shop's time zone (never today's)", async () => {
    await loadBreakdownDay(ctx, TZ, DATE);
    const noon = "2026-11-06T06:30:00.000Z"; // 12:00 in Colombo (UTC+5:30)
    const prices = queried.filter((q) => q.table === "packaging_unit_price_history" || q.table === "product_price_history");
    expect(prices.length).toBe(2);
    for (const q of prices) expect(q.filters).toContainEqual(["lte", "effective_from", noon]);
  });

  it("shows a recorded breakdown with its lines, revision and status", async () => {
    tables.sales_breakdowns = [{
      id: "b1", variant_id: V, status: "active", revision: 2, inferred_base_units: "145.000", packaged_base_units: "80.000", remainder_base_units: "65.000", amount: "4150.00",
      note: null, updated_at: "2026-11-07T01:00:00Z",
      sales_breakdown_lines: [
        { packaging_unit_id: null, is_base_unit: true, unit_name: "piece", quantity: "65.000", base_units: "65.000", unit_price: "30.00", amount: "1950.00" },
        { packaging_unit_id: BOX, is_base_unit: false, unit_name: "Box", quantity: "4.000", base_units: "80.000", unit_price: "550.00", amount: "2200.00" },
      ],
    }];
    tables.daily_sales = [sale({ estimated_sales_amount: "4150.00", packaging_status: "known" })];
    const i = (await loadBreakdownDay(ctx, TZ, DATE)).items[0];
    expect(i.packagingStatus).toBe("known");
    expect(i.amount).toBe("4150.00");
    expect(i.plainEstimate).toBe("4350.00"); // what the day would be worth without the breakdown
    expect(i.current).toMatchObject({ revision: 2, status: "active", packaged: "80", remainder: "65", amount: "4150.00" });
    expect(i.current!.lines.map((l) => [l.name, l.quantity, l.isBaseUnit])).toEqual([["Box", "4", false], ["piece", "65", true]]); // packages first
  });

  it("carries the day's Estimated Sales across ALL products (also the ones not offered), calculated days only", async () => {
    tables.daily_sales = [
      sale({ estimated_sales_amount: "4350.00" }),
      sale({ variant_id: "plain-variant", inferred_base_units_sold: "10.000", estimated_sales_amount: "100.00" }),
      sale({ variant_id: "pending-variant", calculation_status: "pending", inferred_base_units_sold: null, estimated_sales_amount: null }),
    ];
    expect((await loadBreakdownDay(ctx, TZ, DATE)).estimatedTotal).toBe("4450.00");
  });

  it("counts, but does not offer, products whose day has no calculated figure", async () => {
    tables.daily_sales = [sale({ calculation_status: "needs_review", inferred_base_units_sold: null }), ];
    const day = await loadBreakdownDay(ctx, TZ, DATE);
    expect(day.items).toEqual([]);
    expect(day.unavailable).toBe(1);
  });

  it("leaves out products with nothing sellable in packages (and no breakdown)", async () => {
    const v = variant(); v.packaging_units = v.packaging_units.map((u) => ({ ...u, can_be_sold: false }));
    tables.product_variants = [v];
    expect((await loadBreakdownDay(ctx, TZ, DATE)).items).toEqual([]);
  });

  it("an empty day is an empty answer, not an error", async () => {
    tables.daily_sales = [];
    expect(await loadBreakdownDay(ctx, TZ, DATE)).toEqual({ date: DATE, items: [], unavailable: 0, estimatedTotal: "0.00" });
  });

  it("refuses a malformed date", async () => {
    await expect(loadBreakdownDay(ctx, TZ, "yesterday")).rejects.toThrow();
  });

  it("a product with no base price still lists, with no estimate (never a zero)", async () => {
    tables.product_price_history = [];
    const i = (await loadBreakdownDay(ctx, TZ, DATE)).items[0];
    expect(i.base.price).toBeNull();
    expect(i.plainEstimate).toBeNull();
  });
});

describe("saveBreakdownCore", () => {
  const draft = (over: Record<string, unknown> = {}) => ({ variantId: V, date: DATE, lines: [{ unitId: BOX, quantity: "4" }], ...over });

  it("validates with the shared rule, then records through the database function with whole numbers", async () => {
    const r = await saveBreakdownCore(ctx, TZ, draft(), KEY);
    expect(r).toEqual({ ok: true, duplicate: false, revision: 1, amount: "4150.00" });
    expect(rpc).toHaveBeenCalledWith("record_sales_breakdown", {
      p_shop: SHOP, p_variant: V, p_date: DATE, p_lines: [{ unit_id: BOX, quantity: 4 }], p_reason: null, p_key: KEY, p_expected_revision: null,
    });
  });

  it("passes the reason and the revision the person saw", async () => {
    await saveBreakdownCore(ctx, TZ, draft({ reason: "  Recounted the slips  ", expectedRevision: 3 }), KEY);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_reason: "Recounted the slips", p_expected_revision: 3 });
  });

  it("refuses box sales above the inferred total BEFORE asking the database", async () => {
    expect(await saveBreakdownCore(ctx, TZ, draft({ lines: [{ unitId: BOX, quantity: "8" }] }), KEY)).toEqual({ ok: false, error: "sb.err.EXCEEDS_INFERRED" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("names the line at fault, so the form can mark the right field", async () => {
    expect(await saveBreakdownCore(ctx, TZ, draft({ lines: [{ unitId: BOX, quantity: "2.5" }] }), KEY))
      .toEqual({ ok: false, error: "sb.err.FRACTIONAL_PACKAGE", fieldErrors: { [BOX]: "sb.err.FRACTIONAL_PACKAGE" } });
    expect(await saveBreakdownCore(ctx, TZ, draft({ lines: [{ unitId: CARTON, quantity: "1" }] }), KEY))
      .toEqual({ ok: false, error: "sb.err.INVALID_UNIT", fieldErrors: { [CARTON]: "sb.err.INVALID_UNIT" } }); // not offered at all: it is stock only
    expect(await saveBreakdownCore(ctx, TZ, draft({ lines: [{ unitId: TRAY, quantity: "1" }] }), KEY))
      .toEqual({ ok: false, error: "sb.err.PRICE_MISSING", fieldErrors: { [TRAY]: "sb.err.PRICE_MISSING" } });
    expect(await saveBreakdownCore(ctx, TZ, draft({ lines: [{ unitId: BOX, quantity: "-1" }] }), KEY))
      .toMatchObject({ ok: false, error: "sb.err.NEGATIVE_QUANTITY" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a day with no calculated figure, and a product that is not offered", async () => {
    tables.daily_sales = [];
    expect(await saveBreakdownCore(ctx, TZ, draft(), KEY)).toEqual({ ok: false, error: "sb.err.NOT_CALCULATED" });
  });

  it("refuses malformed input without touching the database", async () => {
    for (const bad of [
      draft({ variantId: "nope" }), draft({ date: "2026-13-45" }), draft({ lines: "x" as never }),
      draft({ lines: [{ unitId: "nope", quantity: "1" }] }), draft({ lines: [{ unitId: BOX, quantity: 4 as never }] }), draft({ lines: Array(30).fill({ unitId: BOX, quantity: "1" }) }),
    ]) expect(await saveBreakdownCore(ctx, TZ, bad as never, KEY)).toEqual({ ok: false, error: "auth.error.generic" });
    expect(await saveBreakdownCore(ctx, TZ, draft(), "short")).toEqual({ ok: false, error: "sb.err.KEY_REQUIRED" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reports a retry as a duplicate (nothing recorded twice)", async () => {
    rpc.mockResolvedValue({ data: { duplicate: true, revision: 1 }, error: null });
    expect(await saveBreakdownCore(ctx, TZ, draft(), KEY)).toEqual({ ok: true, duplicate: true, revision: 1, amount: undefined });
  });

  it("turns the database's refusals into messages, never raw errors", async () => {
    for (const [message, key] of [
      ["REASON_REQUIRED", "sb.err.REASON_REQUIRED"], ["REVISION_CONFLICT", "sb.err.REVISION_CONFLICT"], ["IDEMPOTENCY_MISMATCH", "sb.err.IDEMPOTENCY_MISMATCH"],
      ["FORBIDDEN", "error.forbidden"], ["NOT_CALCULATED", "sb.err.NOT_CALCULATED"], ["EXCEEDS_INFERRED", "sb.err.EXCEEDS_INFERRED"],
      ["password authentication failed for user postgres", "auth.error.generic"],
    ] as const) {
      rpc.mockResolvedValueOnce({ data: null, error: { message } });
      expect(await saveBreakdownCore(ctx, TZ, draft(), KEY), message).toEqual({ ok: false, error: key });
    }
  });
});

describe("clearBreakdownCore", () => {
  it("removes through the database function with the reason", async () => {
    rpc.mockResolvedValue({ data: { duplicate: false, revision: 4 }, error: null });
    expect(await clearBreakdownCore(ctx, { variantId: V, date: DATE, reason: "  Not sure  " }, KEY)).toEqual({ ok: true, duplicate: false, revision: 4 });
    expect(rpc).toHaveBeenCalledWith("clear_sales_breakdown", { p_shop: SHOP, p_variant: V, p_date: DATE, p_reason: "Not sure", p_key: KEY });
  });

  it("maps refusals and refuses malformed input", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "REASON_REQUIRED" } });
    expect(await clearBreakdownCore(ctx, { variantId: V, date: DATE, reason: "" }, KEY)).toEqual({ ok: false, error: "sb.err.REASON_REQUIRED" });
    expect(await clearBreakdownCore(ctx, { variantId: "x", date: DATE, reason: "r" }, KEY)).toEqual({ ok: false, error: "auth.error.generic" });
    expect(await clearBreakdownCore(ctx, { variantId: V, date: DATE, reason: "r" }, "k")).toEqual({ ok: false, error: "sb.err.KEY_REQUIRED" });
  });
});

describe("loadBreakdownHistory", () => {
  it("lists who changed what and why, oldest first, naming the person (or marking the automatic ones)", async () => {
    tables.sales_breakdown_revisions = [
      { revision: 1, action: "created", reason: null, created_at: "2026-11-07T01:00:00Z", created_by: "u1", snapshot: { amount: 4150, packaged: 80, lines: [{ unit_id: BOX, is_base_unit: false, name: "Box", quantity: 4, base_units: 80, unit_price: 550, amount: 2200 }] } },
      { revision: 2, action: "marked_stale", reason: "count_corrected", created_at: "2026-11-07T02:00:00Z", created_by: null, snapshot: { amount: 4150, packaged: 80, lines: [] } },
      { revision: 3, action: "cleared", reason: "Not sure", created_at: "2026-11-07T03:00:00Z", created_by: "u1", snapshot: null },
    ];
    tables.user_profiles = [{ id: "u1", display_name: "Nimal" }];
    const h = await loadBreakdownHistory(ctx, V, DATE);
    expect(h.map((x) => [x.revision, x.action, x.by, x.amount])).toEqual([[1, "created", "Nimal", "4150.00"], [2, "marked_stale", null, "4150.00"], [3, "cleared", "Nimal", null]]);
    expect(h[0].lines).toEqual([{ unitId: BOX, isBaseUnit: false, name: "Box", quantity: "4", baseUnits: "80", unitPrice: "550", amount: "2200.00" }]);
    expect(h[2].reason).toBe("Not sure");
  });

  it("refuses a malformed request", async () => {
    await expect(loadBreakdownHistory(ctx, "x", DATE)).rejects.toThrow();
    await expect(loadBreakdownHistory(ctx, V, "x")).rejects.toThrow();
  });
});

describe("breakdownDbError", () => {
  it("never passes raw database text through", () => {
    expect(breakdownDbError({ message: "relation \"sales_breakdowns\" does not exist" })).toBe("auth.error.generic");
    expect(breakdownDbError(null)).toBe("auth.error.generic");
    expect(breakdownDbError({ message: "NOT_SELLABLE" })).toBe("sb.err.NOT_SELLABLE");
  });
});
