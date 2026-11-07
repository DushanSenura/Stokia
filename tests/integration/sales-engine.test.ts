// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates/business";
import { reconcileStockInterval, type MovementEffect, type MovementType } from "@/lib/calculations/reconcile";
import { addUser, asUser, createDb } from "./db-harness";

let db: PGlite;
let owner: string, manager: string, viewer: string, outsider: string;
let shop: string, otherShop: string;
let T: string, d1: string, d2: string, d3: string;
let v1: string, v2: string, v3: string, v4: string, v5: string, v7: string, v8: string, foreign: string;
const sessions: Record<string, string> = {};

const q = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<R>(sql, params);
const rejects = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toThrow(re);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

/** Save + confirm a count as the owner, with a deterministic "counting started" time (drives movement windows). */
async function countDay(shopId: string, user: string, date: string, h: number, entries: [string, number | null][]) {
  const lines = JSON.stringify(entries.filter(([, n]) => n !== null).map(([variant_id, n]) => ({ variant_id, normalized_base_quantity: n, entry_details: { version: 1 } })));
  const saved = await asUser(db, user, async () => (await q<{ r: { session_id: string; revision: number } }>("select save_count_draft($1,$2::date,$3::jsonb,null) r", [shopId, date, lines])).rows[0].r);
  await q("update stock_count_sessions set counted_at = now() - ($2 || ' hours')::interval where id=$1", [saved.session_id, String(h)]);
  await asUser(db, user, () => q("select confirm_count($1,$2,true)", [saved.session_id, saved.revision]));
  sessions[`${shopId}:${date}`] = saved.session_id;
  return saved.session_id;
}

type Row = { units: string | null; amount: string | null; price: string | null; status: string; reason: string | null; rev: number; breakdown: Record<string, string | number | null> | null };
const row = async (variant: string, date: string, shopId = shop): Promise<Row | undefined> =>
  (await q<Row>("select inferred_base_units_sold::text units, estimated_sales_amount::text amount, price_reference::text price, calculation_status::text status, pending_reason reason, calculation_revision rev, breakdown from daily_sales where shop_id=$1 and variant_id=$2 and sales_date=$3", [shopId, variant, date])).rows[0];
const revisions = async (variant: string, date: string) =>
  (await q<{ revision: number; units: string | null; amount: string | null; reason: string }>("select r.revision, r.inferred_base_units_sold::text units, r.estimated_sales_amount::text amount, r.superseded_reason reason from daily_sales_revisions r join daily_sales d on d.id=r.daily_sales_id where d.variant_id=$1 and d.sales_date=$2 order by r.revision", [variant, date])).rows;

const move = (user: string, variant: string, type: MovementType, qty: number, effect: number, at: string, key: string, opts: { unit?: string | null; reason?: string | null; ref?: string | null; shopId?: string } = {}) =>
  asUser(db, user, async () => (await q<{ r: { id: string; duplicate: boolean } }>(
    "select record_movement($1,$2,$3::movement_type,$4,$5,$6,$7::timestamptz,$8,$9,null,null,$10) r",
    [opts.shopId ?? shop, variant, type, qty, opts.unit ?? null, effect, at, opts.reason === undefined ? "test" : opts.reason, opts.ref ?? null, key])).rows[0].r);

beforeAll(async () => {
  db = await createDb();
  [owner, manager, viewer, outsider] = await Promise.all(["o", "m", "v", "x"].map((n) => addUser(db, `${n}@shop.lk`)));
  shop = await asUser(db, owner, async () => (await q<{ s: string }>("select create_shop('Perera Stores') s")).rows[0].s);
  otherShop = await asUser(db, outsider, async () => (await q<{ s: string }>("select create_shop('Other') s")).rows[0].s);
  await q("insert into shop_memberships (shop_id,user_id,role) values ($1,$2,'stock_manager'),($1,$3,'viewer')", [shop, manager, viewer]);

  const dates = (await q<{ t: string }>("select (now() at time zone 'Asia/Colombo')::date::text t")).rows[0].t;
  T = dates; d1 = addDays(T, -1); d2 = addDays(T, -2); d3 = addDays(T, -3);

  const mk = (shopId: string, user: string, code: string, price: number | null) => asUser(db, user, async () => {
    const p = (await q<{ id: string }>("insert into products (shop_id,name,product_code) values ($1,$2,$2) returning id", [shopId, code])).rows[0].id;
    const v = (await q<{ id: string }>("insert into product_variants (product_id,shop_id,sku) values ($1,$2,$3) returning id", [p, shopId, `${code}-1`])).rows[0].id;
    if (price !== null) await q("select set_variant_price($1,'selling',$2,now() - interval '100 days')", [v, price]);
    return v;
  });
  [v1, v2, v3, v4, v5, v8] = [await mk(shop, owner, "A", 150), await mk(shop, owner, "B", 150), await mk(shop, owner, "C", 150), await mk(shop, owner, "D", 150), await mk(shop, owner, "E", 150), await mk(shop, owner, "H", 150)];
  foreign = await mk(otherShop, outsider, "Z", 150);
}, 60_000);
afterAll(() => db.close());

describe("count confirmation reconciles the previous day, atomically", () => {
  it("first count only creates pending rows: nothing is sold on opening day", async () => {
    await countDay(shop, owner, d3, 72, [[v1, 100], [v2, 100], [v3, 100], [v4, 50], [v5, 10], [v8, null]]);
    const r = await row(v1, d3);
    expect(r).toMatchObject({ status: "pending", reason: "awaiting_next_count", units: null, amount: null });
    expect((await q("select 1 from daily_sales where sales_date=$1", [addDays(d3, -1)])).rows).toHaveLength(0); // the day BEFORE the first count: nothing
  });

  it("movements recorded before the closing count wait in the interval (v2: +20 at -60h; v5: +20 just before, +3 exactly at, the closing count)", async () => {
    await move(manager, v2, "stock_received", 20, 20, hoursAgo(60), "v2-rec");
    await move(manager, v5, "stock_received", 20, 20, hoursAgo(49), "v5-early");       // 1h before the closing count at -48h
    const row3 = await row(v2, d3);
    expect(row3).toMatchObject({ status: "pending", reason: "awaiting_next_count" }); // still no closing count
  });

  it("Test A/B/E/F: the next morning's count calculates the PREVIOUS day, never the count day", async () => {
    await countDay(shop, owner, d2, 48, [[v1, 72], [v2, 72], [v3, null], [v4, 80], [v5, 25], [v8, 5]]);
    const exact = (await q<{ t: string }>("select counted_at::text t from stock_count_sessions where id=$1", [sessions[`${shop}:${d2}`]])).rows[0].t;
    await move(manager, v5, "stock_received", 3, 3, new Date(exact.replace(" ", "T").replace(/\+00$/, "Z")).toISOString(), "v5-exact");

    // Test A: 100 -> 72 = 28 packets, Rs. 4,200.00 on d3 (NOT on d2)
    expect(await row(v1, d3)).toMatchObject({ status: "calculated", units: "28.000", amount: "4200.00", price: "150.00", reason: null, rev: 1 });
    // Test B: 100 + 20 received - 72 = 48
    expect(await row(v2, d3)).toMatchObject({ status: "calculated", units: "48.000", amount: "7200.00" });
    // Test E: not counted on the closing morning -> pending, NOT 100 sold
    expect(await row(v3, d3)).toMatchObject({ status: "pending", reason: "closing_not_counted", units: null, amount: null });
    // Test F: 50 -> 80 with nothing recorded -> needs review, no fabricated sales value
    expect(await row(v4, d3)).toMatchObject({ status: "needs_review", reason: "stock_increase_unexplained", units: null, amount: null });
    // early-morning delivery (before the count) and one stamped exactly at the count both belong to d3's interval
    // (the +3 stamped exactly at the count was recorded AFTER confirmation, so the day was recalculated: 10+20-25 = 5 -> 10+23-25 = 8)
    expect(await row(v5, d3)).toMatchObject({ status: "recalculated", units: "8.000", rev: 2, breakdown: { received: 23 } });
    expect((await revisions(v5, d3)).map((r) => r.units)).toEqual(["5.000"]);
    // never opened: variant not counted on the opening morning
    expect(await row(v8, d3)).toMatchObject({ status: "pending", reason: "opening_not_counted" });
    // the count day itself now awaits ITS next morning
    expect(await row(v1, d2)).toMatchObject({ status: "pending", reason: "awaiting_next_count" });
    // nothing was ever written for the count day's own sales
    expect((await q("select 1 from daily_sales where sales_date=$1 and calculation_status='calculated'", [d2])).rows).toHaveLength(0);
  });

  it("Test C: a damaged-stock movement recorded afterwards recalculates the interval (48 -> 46) and keeps the old figure", async () => {
    await move(manager, v2, "damaged", 2, -2, hoursAgo(55), "v2-dmg", { reason: "Leaking packets" });
    const r = await row(v2, d3);
    expect(r).toMatchObject({ units: "46.000", amount: "6900.00", status: "recalculated", rev: 2 });
    expect(await revisions(v2, d3)).toEqual([{ revision: 1, units: "48.000", amount: "7200.00", reason: "movement_recorded" }]);
  });

  it("a delivery AFTER the closing count belongs to the next interval (v5: +7 at -47h)", async () => {
    await move(manager, v5, "stock_received", 7, 7, hoursAgo(47), "v5-late");
    expect(await row(v5, d3)).toMatchObject({ units: "8.000", rev: 2 }); // d3 untouched by a movement that belongs to the next interval
  });

  it("a variant created after the opening count gets no rows for earlier days; confirming d1 fills in d2", async () => {
    v7 = await asUser(db, owner, async () => {
      const p = (await q<{ id: string }>("insert into products (shop_id,name,product_code) values ($1,'G','G') returning id", [shop])).rows[0].id;
      return (await q<{ id: string }>("insert into product_variants (product_id,shop_id,sku) values ($1,$2,'G-1') returning id", [p, shop])).rows[0].id;
    });
    await countDay(shop, owner, d1, 24, [[v1, 60], [v2, 40], [v5, 30], [v7, 9], [v3, null], [v4, null], [v8, null]]);
    expect(await row(v1, d2)).toMatchObject({ status: "calculated", units: "12.000", amount: "1800.00" });
    expect(await row(v2, d2)).toMatchObject({ units: "32.000" });          // d3's damaged movement (-55h) is NOT counted again in d2
    expect(await row(v5, d2)).toMatchObject({ units: "2.000" });           // 25 + 7 - 30
    expect(await row(v3, d2)).toMatchObject({ status: "pending", reason: "opening_not_counted" });
    expect(await row(v4, d2)).toMatchObject({ status: "pending", reason: "closing_not_counted" });
    expect(await row(v7, d3)).toBeUndefined();
    expect(await row(v7, d2)).toBeUndefined();
    expect(await row(v7, d1)).toMatchObject({ status: "pending", reason: "awaiting_next_count" });
  });

  it("zero is a real count: counting 0 means everything sold (not pending)", async () => {
    await countDay(shop, owner, T, 1, [[v1, 0], [v2, 40], [v5, 30], [v7, null]]);
    expect(await row(v1, d1)).toMatchObject({ status: "calculated", units: "60.000", amount: "9000.00" });
    expect(await row(v7, d1)).toMatchObject({ status: "pending", reason: "closing_not_counted" });
    expect(await row(v2, d1)).toMatchObject({ units: "0.000", status: "calculated" }); // 40 -> 40, a true zero-sales day
  });

  it("an unchanged re-run is a no-op: no revision churn, no history rows", async () => {
    const before = (await q<{ n: number }>("select count(*)::int n from daily_sales_revisions")).rows[0].n;
    await q("select _recalc_range($1,$2::date,$3::date,'noop')", [shop, d3, T]);
    expect((await q<{ n: number }>("select count(*)::int n from daily_sales_revisions")).rows[0].n).toBe(before);
    expect(await row(v1, d3)).toMatchObject({ rev: 1 });
  });
});

describe("movements: validation, idempotency, reversal", () => {
  const now = () => hoursAgo(0.2);
  it("retry-safe: the same key applies once; a reused key with different data is refused", async () => {
    const a = await move(manager, v1, "stock_received", 5, 5, now(), "idem-1");
    const b = await move(manager, v1, "stock_received", 5, 5, now(), "idem-1");
    expect([a.duplicate, b.duplicate, a.id === b.id]).toEqual([false, true, true]);
    expect((await q("select 1 from stock_movements where idempotency_key='idem-1'")).rows).toHaveLength(1);
    await rejects(move(manager, v1, "stock_received", 6, 6, now(), "idem-1"), /IDEMPOTENCY_MISMATCH/);
  });

  it("signs are enforced per type (a negative receipt / positive damage is impossible)", async () => {
    await rejects(move(manager, v1, "stock_received", 5, -5, now(), "s1"), /movement_sign|check/);
    await rejects(move(manager, v1, "damaged", 5, 5, now(), "s2"), /movement_sign|check/);
    await rejects(move(manager, v1, "manual_adjustment", 5, 0, now(), "s3"), /EFFECT_MISMATCH|check/);
    await move(manager, v1, "manual_adjustment", 2, -2, now(), "s4", { reason: "Count correction" }); // signed adjustments may go either way
  });

  it("the stored effect must match quantity x packaging multiplier; units must belong to the variant; packages are whole", async () => {
    const bundle = await asUser(db, owner, async () => (await q<{ id: string }>("insert into packaging_units (variant_id,name,conversion_factor,base_unit_multiplier) values ($1,'Bundle',12,1) returning id", [v1])).rows[0].id);
    const other = await asUser(db, owner, async () => (await q<{ id: string }>("insert into packaging_units (variant_id,name,conversion_factor,base_unit_multiplier) values ($1,'Bundle',6,1) returning id", [v2])).rows[0].id);
    const ok = await move(manager, v1, "stock_received", 2, 24, now(), "u1", { unit: bundle });
    expect(ok.duplicate).toBe(false);
    await rejects(move(manager, v1, "stock_received", 2, 20, now(), "u2", { unit: bundle }), /EFFECT_MISMATCH/);
    await rejects(move(manager, v1, "stock_received", 2, 12, now(), "u3", { unit: other }), /INVALID_UNIT/);
    await rejects(move(manager, v1, "stock_received", 2.5, 30, now(), "u4", { unit: bundle }), /FRACTIONAL_PACKAGE/);
  });

  it("rejects future/ancient times, missing reason, repacking via the wrong door, other shops' variants, missing key", async () => {
    await rejects(move(manager, v1, "stock_received", 1, 1, new Date(Date.now() + 3_600_000).toISOString(), "f1"), /FUTURE_TIME/);
    await rejects(move(manager, v1, "stock_received", 1, 1, hoursAgo(24 * 500), "f2"), /TOO_OLD/);
    await rejects(move(manager, v1, "stock_received", 1, 1, now(), "f3", { reason: null }), /REASON_REQUIRED/);
    await move(manager, v1, "stock_received", 1, 1, now(), "f3b", { reason: null, ref: "INV-1001" }); // a reference alone is enough
    await rejects(move(manager, v1, "repacking", 1, 1, now(), "f4"), /USE_REPACKING/);
    await rejects(move(manager, foreign, "stock_received", 1, 1, now(), "f5"), /INVALID_VARIANT/);
    await rejects(move(manager, v1, "stock_received", 1, 1, now(), "  "), /KEY_REQUIRED/);
  });

  it("only owners/stock managers may record; viewers and other shops cannot; clients cannot write tables directly", async () => {
    await rejects(move(viewer, v1, "stock_received", 1, 1, now(), "p1"), /FORBIDDEN/);
    await rejects(move(outsider, v1, "stock_received", 1, 1, now(), "p2"), /FORBIDDEN/);
    await asUser(db, manager, () => rejects(q("insert into stock_movements (shop_id,variant_id,type,input_quantity,normalized_base_quantity,effective_at,idempotency_key,reason,created_by) values ($1,$2,'stock_received',1,1,now(),'x','y',$3)", [shop, v1, manager]), /permission denied/));
    await asUser(db, manager, () => rejects(q("update daily_sales set inferred_base_units_sold=999"), /permission denied/));
    await asUser(db, manager, () => rejects(q("delete from daily_sales_revisions"), /permission denied/));
  });

  it("a late/forgotten movement recalculates a confirmed day with history; reversing it restores the figure (and is itself idempotent)", async () => {
    const before = await row(v1, d3);
    expect(before).toMatchObject({ units: "28.000", amount: "4200.00", rev: 1 });
    const m = await move(manager, v1, "stock_received", 5, 5, hoursAgo(60), "late-1", { reason: "Forgotten delivery" });
    expect(await row(v1, d3)).toMatchObject({ units: "33.000", amount: "4950.00", status: "recalculated", rev: 2 });

    const rev = await asUser(db, manager, async () => (await q<{ r: { id: string; duplicate: boolean } }>("select reverse_movement($1,'Entered by mistake','rev-1') r", [m.id])).rows[0].r);
    expect(rev.duplicate).toBe(false);
    expect(await row(v1, d3)).toMatchObject({ units: "28.000", amount: "4200.00", status: "recalculated", rev: 3 });
    expect((await revisions(v1, d3)).map((r) => [r.revision, r.units])).toEqual([[1, "28.000"], [2, "33.000"]]);

    // the original is untouched, the compensating entry points at it, and a repeat does nothing
    const orig = (await q<{ n: string }>("select normalized_base_quantity::text n from stock_movements where id=$1", [m.id])).rows[0];
    expect(orig.n).toBe("5.000");
    const again = await asUser(db, manager, async () => (await q<{ r: { id: string; duplicate: boolean } }>("select reverse_movement($1,'Entered by mistake','rev-2') r", [m.id])).rows[0].r);
    expect(again).toEqual({ id: rev.id, duplicate: true });
    await asUser(db, manager, () => rejects(q("select reverse_movement($1,'x','rev-3')", [rev.id]), /IS_REVERSAL/));
    await asUser(db, manager, () => rejects(q("select reverse_movement($1,'','rev-4')", [m.id]), /REASON_REQUIRED/));
    await asUser(db, viewer, () => rejects(q("select reverse_movement($1,'x','rev-5')", [m.id]), /FORBIDDEN/));
  });

  it("repacking moves stock between two sizes as one atomic, idempotent pair; sizes are never merged", async () => {
    const [big, small] = await asUser(db, owner, async () => {
      const mkv = async (sku: string) => {
        const p = (await q<{ id: string }>("insert into products (shop_id,name,product_code) values ($1,$2,$2) returning id", [shop, sku])).rows[0].id;
        return (await q<{ id: string }>("insert into product_variants (product_id,shop_id,sku) values ($1,$2,$3) returning id", [p, shop, sku + "-V"])).rows[0].id;
      };
      return [await mkv("KG1"), await mkv("G250")];
    });
    const call = (key: string, from = big, to = small, user = manager) => asUser(db, user, async () => (await q<{ r: { group_id: string; duplicate: boolean } }>(
      "select record_repacking($1,$2,1,$3,4,$4::timestamptz,'1 kg split into 4 x 250 g',null,$5) r", [shop, from, to, hoursAgo(0.2), key])).rows[0].r);
    const a = await call("rp-1");
    const rows = (await q<{ variant_id: string; n: string; g: string }>("select variant_id, normalized_base_quantity::text n, group_id::text g from stock_movements where group_id=$1 order by n", [a.group_id])).rows;
    expect(rows.map((r) => [r.variant_id, r.n])).toEqual([[big, "-1.000"], [small, "4.000"]]);
    expect((await call("rp-1")).duplicate).toBe(true);
    expect((await q("select 1 from stock_movements where group_id is not null")).rows.length).toBe(2);
    await rejects(call("rp-2", big, big), /SAME_VARIANT/);
    await rejects(call("rp-3", big, foreign), /INVALID_VARIANT/);
    await rejects(call("rp-4", big, small, viewer), /FORBIDDEN/);
  });
});

describe("Test H / Test I: corrections and price changes", () => {
  it("Test I: a later price change does not rewrite history (price_reference keeps the price of that sales date)", async () => {
    await asUser(db, owner, () => q("select set_variant_price($1,'selling',170,now())", [v1]));
    await q("select _recalc_range($1,$2::date,$3::date,'price_changed')", [shop, d3, T]);
    expect(await row(v1, d3)).toMatchObject({ price: "150.00", amount: "4200.00", rev: 3 }); // unchanged, no new revision
    expect(await row(v1, d2)).toMatchObject({ price: "150.00", amount: "1800.00" });
  });

  it("Test H: correcting a count recalculates BOTH intervals that use it, and keeps the audit of old values", async () => {
    // d2's count for v1 is the closing count of d3 and the opening count of d2. (Phase 8 adds the approval workflow;
    // here we apply the correction directly and run the same recalculation it will use.)
    await q("update stock_count_lines set normalized_base_quantity = 70 where session_id=$1 and variant_id=$2", [sessions[`${shop}:${d2}`], v1]);
    await q("select _recalc_range($1,$2::date,$3::date,'count_corrected')", [shop, d3, d1]);
    expect(await row(v1, d3)).toMatchObject({ units: "30.000", amount: "4500.00", status: "recalculated", rev: 4 }); // 100 - 70
    expect(await row(v1, d2)).toMatchObject({ units: "10.000", amount: "1500.00", status: "recalculated", rev: 2 }); // 70 - 60
    expect((await revisions(v1, d3)).at(-1)).toMatchObject({ revision: 3, units: "28.000", reason: "count_corrected" });
    expect((await revisions(v1, d2))[0]).toMatchObject({ revision: 1, units: "12.000", amount: "1800.00" });
    expect(await row(v1, d1)).toMatchObject({ rev: 1, units: "60.000" }); // d1 uses the d1 and T counts only: untouched
  });
});

describe("skipped days stay pending (never spread or assumed)", () => {
  it("a missing morning leaves the affected day pending with 'missing_count'; the skipped day has no figures at all", async () => {
    const [a, b] = await asUser(db, outsider, async () => {
      const p = (await q<{ id: string }>("insert into products (shop_id,name,product_code) values ($1,'S','S') returning id", [otherShop])).rows[0].id;
      const va = (await q<{ id: string }>("insert into product_variants (product_id,shop_id,sku) values ($1,$2,'S-1') returning id", [p, otherShop])).rows[0].id;
      return [va, p];
    });
    void b;
    await countDay(otherShop, outsider, d3, 72, [[a, 100]]);
    await countDay(otherShop, outsider, d1, 24, [[a, 90]]); // d2 was never counted
    expect(await row(a, d3, otherShop)).toMatchObject({ status: "pending", reason: "missing_count", units: null, amount: null });
    expect(await row(a, d2, otherShop)).toBeUndefined();
    expect(await row(a, d1, otherShop)).toMatchObject({ status: "pending", reason: "awaiting_next_count" });
  });
});

describe("access control and isolation", () => {
  it("members can read sales + history; other shops cannot", async () => {
    await asUser(db, viewer, async () => {
      expect((await q("select * from daily_sales")).rows.length).toBeGreaterThan(0);
      expect((await q("select * from daily_sales_revisions")).rows.length).toBeGreaterThan(0);
      expect((await q("select * from stock_movements")).rows.length).toBeGreaterThan(0);
    });
    await asUser(db, outsider, async () => {
      const mine = (await q<{ shop_id: string }>("select distinct shop_id from daily_sales")).rows.map((r) => r.shop_id);
      expect(mine).toEqual([otherShop]);
      expect((await q("select 1 from stock_movements")).rows).toHaveLength(0);
      expect((await q("select 1 from daily_sales_revisions where shop_id=$1", [shop])).rows).toHaveLength(0);
    });
  });
  it("internal reconciliation functions are not callable by API clients", async () => {
    await asUser(db, owner, () => rejects(q("select _recalc_range($1,$2::date,$3::date,'x')", [shop, d3, T]), /permission denied/));
    await asUser(db, owner, () => rejects(q("select _recalc_for_movement($1,now(),'x')", [shop]), /permission denied/));
  });
});

describe("parity: the SQL reconciliation equals the TypeScript engine on random data", () => {
  it("60 random variants x random counts, movements (inside/outside the window) and prices", async () => {
    // seeded PRNG so the test is deterministic
    let seed = 20261106;
    const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = <X,>(a: X[]) => a[Math.floor(rnd() * a.length)];

    // dedicated shop for this test
    const ownerC = await addUser(db, "parity@shop.lk");
    const shopC = await asUser(db, ownerC, async () => (await q<{ s: string }>("select create_shop('Parity') s")).rows[0].s);
    const ids: string[] = [];
    const prices = new Map<string, string | null>();
    await asUser(db, ownerC, async () => {
      for (let i = 0; i < 60; i++) {
        const p = (await q<{ id: string }>("insert into products (shop_id,name,product_code) values ($1,$2,$2) returning id", [shopC, `P${i}`])).rows[0].id;
        const v = (await q<{ id: string }>("insert into product_variants (product_id,shop_id,sku) values ($1,$2,$3) returning id", [p, shopC, `P${i}-1`])).rows[0].id;
        ids.push(v);
        const price = rnd() < 0.8 ? (Math.floor(rnd() * 50000) / 100).toFixed(2) : null;
        prices.set(v, price);
        if (price) await q("select set_variant_price($1,'selling',$2,now() - interval '200 days')", [v, price]);
      }
    });

    const dS = addDays(T, -9), dE = addDays(T, -8);
    const opening = new Map<string, number | null>(), closing = new Map<string, number | null>();
    for (const v of ids) {
      opening.set(v, rnd() < 0.1 ? null : Math.floor(rnd() * 200));
      closing.set(v, rnd() < 0.1 ? null : Math.floor(rnd() * 200));
    }
    const hOpen = 220, hClose = 196; // counting started at -220h and -196h
    const sS = await asUser(db, ownerC, async () => (await q<{ r: { session_id: string; revision: number } }>("select save_count_draft($1,$2::date,$3::jsonb,null) r", [shopC, dS, JSON.stringify(ids.filter((v) => opening.get(v) !== null).map((v) => ({ variant_id: v, normalized_base_quantity: opening.get(v) })))])).rows[0].r);
    await q("update stock_count_sessions set counted_at = now() - ($2 || ' hours')::interval where id=$1", [sS.session_id, String(hOpen)]);
    await asUser(db, ownerC, () => q("select confirm_count($1,$2,true)", [sS.session_id, sS.revision]));
    const sE = await asUser(db, ownerC, async () => (await q<{ r: { session_id: string; revision: number } }>("select save_count_draft($1,$2::date,$3::jsonb,null) r", [shopC, dE, JSON.stringify(ids.filter((v) => closing.get(v) !== null).map((v) => ({ variant_id: v, normalized_base_quantity: closing.get(v) })))])).rows[0].r);
    await q("update stock_count_sessions set counted_at = now() - ($2 || ' hours')::interval where id=$1", [sE.session_id, String(hClose)]);

    // random movements, some before the window, inside, exactly on the boundaries, and after
    const types: MovementType[] = ["stock_received", "customer_return", "supplier_return", "damaged", "expired", "discarded", "manual_adjustment"];
    const moves = new Map<string, MovementEffect[]>();
    const openAt = (await q<{ t: string }>("select counted_at::text t from stock_count_sessions where id=$1", [sS.session_id])).rows[0].t;
    const closeAt = (await q<{ t: string }>("select counted_at::text t from stock_count_sessions where id=$1", [sE.session_id])).rows[0].t;
    const iso = (s: string) => new Date(s.replace(" ", "T").replace(/\+00$/, "Z")).toISOString();
    let n = 0;
    for (const v of ids) {
      for (let k = 0; k < Math.floor(rnd() * 4); k++) {
        const type = pick(types);
        const mag = 1 + Math.floor(rnd() * 30);
        const sign = type === "stock_received" || type === "customer_return" ? 1 : type === "manual_adjustment" ? (rnd() < 0.5 ? 1 : -1) : -1;
        const at = rnd() < 0.15 ? iso(openAt) : rnd() < 0.15 ? iso(closeAt) : new Date(Date.now() - (hOpen + 24 - rnd() * (hOpen - hClose + 48)) * 3_600_000).toISOString();
        await q("insert into stock_movements (shop_id,variant_id,type,input_quantity,normalized_base_quantity,effective_at,idempotency_key,reason,created_by) values ($1,$2,$3::movement_type,$4,$5,$6::timestamptz,$7,'p',$8)", [shopC, v, type, mag, sign * mag, at, `par-${n++}`, ownerC]);
        moves.set(v, [...(moves.get(v) ?? []), { type, effect: sign * mag, effectiveAt: at }]);
      }
    }
    await asUser(db, ownerC, () => q("select confirm_count($1,$2,true)", [sE.session_id, sE.revision]));

    let calculated = 0, review = 0, pending = 0;
    for (const v of ids) {
      const ts = reconcileStockInterval({
        opening: opening.get(v) ?? null,
        closing: { counted: closing.get(v) !== null, quantity: closing.get(v) ?? null, countedAt: iso(closeAt) },
        hasLaterCount: false, openedAt: iso(openAt), movements: moves.get(v) ?? [], sellingPrice: prices.get(v) ?? null,
      });
      const sql = await row(v, dS, shopC);
      expect(sql, `variant ${v}`).toBeDefined();
      expect(sql!.status, `status ${v}`).toBe(ts.status);
      if (ts.status === "pending") { pending++; expect(sql!.reason).toBe(ts.reason); expect(sql!.units).toBeNull(); expect(sql!.amount).toBeNull(); }
      else if (ts.status === "needs_review") { review++; expect(sql!.reason).toBe(ts.reason); expect(sql!.units).toBeNull(); expect(sql!.amount).toBeNull(); }
      else {
        calculated++;
        expect(new Decimal(sql!.units!).eq(ts.unitsSold), `units ${v}: sql ${sql!.units} ts ${ts.unitsSold}`).toBe(true);
        if (ts.estimatedAmount === null) expect(sql!.amount).toBeNull();
        else expect(new Decimal(sql!.amount!).eq(ts.estimatedAmount), `amount ${v}`).toBe(true);
        expect(new Decimal(String(sql!.breakdown!.received)).eq(ts.breakdown.received)).toBe(true);
        expect(new Decimal(String(sql!.breakdown!.damaged)).eq(ts.breakdown.damaged)).toBe(true);
        expect(new Decimal(String(sql!.breakdown!.adjustments)).eq(ts.breakdown.adjustments)).toBe(true);
      }
    }
    // the random data must actually exercise every outcome, otherwise the comparison proves little
    expect(calculated).toBeGreaterThan(10);
    expect(review).toBeGreaterThan(0);
    expect(pending).toBeGreaterThan(0);
  });
});
