// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates/business";
import { addUser, asUser, createDb } from "./db-harness";

let db: PGlite;
let owner: string, viewer: string, outsider: string;
let shop: string, otherShop: string;
let T: string, d1: string, d2: string, d3: string;
let packet1: string, packet2: string, bottle: string, uncosted: string, lowOne: string, archived: string;

const q = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<R>(sql, params);
const hoursAgo = (h: number) => `now() - interval '${h} hours'`;

async function countDay(date: string, h: number, entries: [string, number | null][]) {
  const lines = JSON.stringify(entries.filter(([, n]) => n !== null).map(([variant_id, n]) => ({ variant_id, normalized_base_quantity: n })));
  const r = await asUser(db, owner, async () => (await q<{ r: { session_id: string; revision: number } }>("select save_count_draft($1,$2::date,$3::jsonb,null) r", [shop, date, lines])).rows[0].r);
  await q(`update stock_count_sessions set counted_at = ${hoursAgo(h)} where id=$1`, [r.session_id]);
  await asUser(db, owner, () => q("select confirm_count($1,$2,true)", [r.session_id, r.revision]));
}

beforeAll(async () => {
  db = await createDb();
  [owner, viewer, outsider] = await Promise.all(["o", "v", "x"].map((n) => addUser(db, `${n}@shop.lk`)));
  shop = await asUser(db, owner, async () => (await q<{ s: string }>("select create_shop('Perera Stores') s")).rows[0].s);
  otherShop = await asUser(db, outsider, async () => (await q<{ s: string }>("select create_shop('Other') s")).rows[0].s);
  await q("insert into shop_memberships (shop_id,user_id,role) values ($1,$2,'viewer')", [shop, viewer]);
  const t = (await q<{ t: string }>("select (now() at time zone 'Asia/Colombo')::date::text t")).rows[0].t;
  [T, d1, d2, d3] = [t, addDays(t, -1), addDays(t, -2), addDays(t, -3)];

  const mk = (name: string, o: { unit?: string; price?: number; cost?: number; threshold?: number; costFrom?: string }) =>
    asUser(db, owner, async () => {
      const p = (await q<{ id: string }>("insert into products (shop_id,name,product_code) values ($1,$2,$2) returning id", [shop, name])).rows[0].id;
      const v = (await q<{ id: string }>("insert into product_variants (product_id,shop_id,sku,base_inventory_unit,low_stock_threshold) values ($1,$2,$3,$4,$5) returning id", [p, shop, `${name}-1`, o.unit ?? "packet", o.threshold ?? 0])).rows[0].id;
      if (o.price) await q("select set_variant_price($1,'selling',$2,now() - interval '100 days')", [v, o.price]);
      if (o.cost) await q("select set_variant_price($1,'purchase_cost',$2,$3::timestamptz)", [v, o.cost, o.costFrom ?? new Date(Date.now() - 100 * 86400_000).toISOString()]);
      return v;
    });
  packet1 = await mk("Alpha", { price: 150, cost: 100, threshold: 20 });
  packet2 = await mk("Beta", { price: 200, cost: 120, threshold: 10 });
  bottle = await mk("Oil", { unit: "bottle", price: 300, cost: 250, threshold: 5 });
  uncosted = await mk("Gamma", { price: 50, threshold: 10 });
  lowOne = await mk("Delta", { price: 80, cost: 60, threshold: 0 });       // threshold 0: only alerts at zero stock
  archived = await mk("Epsilon", { price: 80, cost: 60, threshold: 100 });

  // d3: opening. d2: closes d3.  d1: closes d2.  T: closes d1 (latest count).
  await countDay(d3, 72, [[packet1, 100], [packet2, 50], [bottle, 20], [uncosted, 30], [lowOne, 5], [archived, 9]]);
  await countDay(d2, 48, [[packet1, 72], [packet2, 40], [bottle, 18], [uncosted, null], [lowOne, 5], [archived, 9]]);
  await countDay(d1, 24, [[packet1, 60], [packet2, 80], [bottle, 10], [uncosted, 25], [lowOne, 5], [archived, 9]]); // packet2 40 -> 80: needs review
  await q("update products set is_active=false where product_code='Epsilon'");
  await countDay(T, 1, [[packet1, 15], [packet2, 8], [bottle, 5], [uncosted, 25], [lowOne, 0]]);
}, 90_000);
afterAll(() => db.close());

const summary = (u: string, from: string, to: string, shopId = shop) => asUser(db, u, async () =>
  (await q<{ sales_date: string; base_unit: string; units_sold: string; estimated_amount: string; calculated_count: number; needs_review_count: number; pending_count: number }>(
    "select sales_date::text, base_unit, units_sold::text, estimated_amount::text, calculated_count, needs_review_count, pending_count from sales_daily_summary($1,$2::date,$3::date)", [shopId, from, to])).rows);

describe("sales_daily_summary", () => {
  it("groups by day AND base unit: packets and bottles are never added together; money is", async () => {
    const rows = await summary(owner, d3, d3);
    const packet = rows.find((r) => r.base_unit === "packet")!, bot = rows.find((r) => r.base_unit === "bottle")!;
    // d3 (closed by d2): alpha 100->72 = 28 x150 = 4200 ; beta 50->40 = 10 x200 = 2000 ; gamma not counted at d2 -> pending ; delta 0 sold ; epsilon 0 sold
    expect(Number(packet.units_sold)).toBe(38);
    expect(Number(packet.estimated_amount)).toBe(6200);
    expect(bot).toMatchObject({ units_sold: "2.000", estimated_amount: "600.00" });  // 20 -> 18 bottles x 300
    expect(packet.pending_count).toBe(1);                                              // uncosted/Gamma
  });
  it("needs-review rows contribute no units and no money, and are counted", async () => {
    const rows = await summary(owner, d2, d2);
    const packet = rows.find((r) => r.base_unit === "packet")!;
    expect(packet.needs_review_count).toBe(1); // Beta 40 -> 80
    // alpha 72 -> 60 = 12 x150 ; delta 0 ; epsilon 0 ; Gamma opening not counted -> pending
    expect(Number(packet.units_sold)).toBe(12);
    expect(Number(packet.estimated_amount)).toBe(1800);
  });
  it("the latest count's own day is pending (awaiting the next morning)", async () => {
    const rows = await summary(owner, T, T);
    expect(rows.every((r) => Number(r.estimated_amount) === 0 && r.calculated_count === 0)).toBe(true);
    expect(rows.reduce((n, r) => n + r.pending_count, 0)).toBeGreaterThan(0);
  });
  it("returns nothing for days with no rows, and caps the range", async () => {
    expect(await summary(owner, addDays(T, -60), addDays(T, -50))).toEqual([]);
    await expect(summary(owner, addDays(T, -500), T)).rejects.toThrow(/RANGE_TOO_LARGE/);
  });
  it("RLS still applies: viewers can read; another shop's id yields nothing (no cross-shop leak)", async () => {
    expect((await summary(viewer, d3, d3)).length).toBeGreaterThan(0);
    expect(await summary(outsider, d3, d3, shop)).toEqual([]);
    expect(await summary(outsider, d3, d3, otherShop)).toEqual([]);
  });
});

describe("sales_top_products", () => {
  const top = (u: string, from: string, to: string, limit = 5, shopId = shop) => asUser(db, u, async () =>
    (await q<{ product_name: string; units_sold: string; estimated_amount: string }>("select product_name, units_sold::text, estimated_amount::text from sales_top_products($1,$2::date,$3::date,$4)", [shopId, from, to, limit])).rows);

  it("ranks by Estimated Sales (additive) across the range and excludes unsold / review / pending rows", async () => {
    const rows = await top(owner, d3, d1);
    // Delta: 5 -> 0 on d1 = 5 x80 = 400 ; Oil: 2 x300 (d3) + 8 x300 (d2: 18->10) = 3000 ; Alpha: 4200 + 1800 + (60->15 = 45 x150 = 6750 on d1) = 12750 ; Beta: 2000 (+ d2 review excluded) + d1 80->8 = 72 x200 = 14400 => 16400
    expect(rows.map((r) => r.product_name)).toEqual(["Beta", "Alpha", "Oil", "Delta"]);
    expect(Number(rows[3].estimated_amount)).toBe(400);
    expect(Number(rows[0].estimated_amount)).toBe(16400);
    expect(rows.find((r) => r.product_name === "Gamma")).toBeUndefined(); // no calculated days with units
  });
  it("respects the limit and the range; is scoped by RLS", async () => {
    expect(await top(owner, d3, d1, 1)).toHaveLength(1);
    expect(await top(owner, addDays(T, -60), addDays(T, -50))).toEqual([]);
    expect(await top(outsider, d3, d1, 5, shop)).toEqual([]);
  });
});

describe("stock_valuation (latest count, at cost)", () => {
  const val = (u = owner, shopId = shop) => asUser(db, u, async () =>
    (await q<{ as_of: string; total_cost: string; valued_count: number; uncosted_count: number; counted_total: number }>("select as_of::text, total_cost::text, valued_count, uncosted_count, counted_total from stock_valuation($1)", [shopId])).rows[0]);

  it("values only the latest confirmed count at purchase cost, and says how many products had no cost", async () => {
    // T count: alpha 15 x100 + beta 8 x120 + oil 5 x250 + delta 0 x60 = 1500 + 960 + 1250 + 0 = 3710 ; gamma 25 has no cost
    expect(await val()).toEqual({ as_of: T, total_cost: "3710.00", valued_count: 4, uncosted_count: 1, counted_total: 5 });
  });
  it("uses the cost in force when the count was taken: a later cost change does not revalue it", async () => {
    await asUser(db, owner, () => q("select set_variant_price($1,'purchase_cost',999,now())", [packet1]));
    expect((await val()).total_cost).toBe("3710.00");
  });
  it("a cost set AFTER the count leaves that product uncosted (never retro-priced)", async () => {
    await asUser(db, owner, () => q("select set_variant_price($1,'purchase_cost',70,now())", [uncosted]));
    expect(await val()).toMatchObject({ valued_count: 4, uncosted_count: 1 });
  });
  it("is read-only for viewers, and empty for other shops", async () => {
    expect((await val(viewer))?.total_cost).toBe("3710.00");
    expect(await val(outsider, shop)).toBeUndefined();
  });
});

describe("low_stock_items", () => {
  const low = (u = owner, shopId = shop, limit = 6) => asUser(db, u, async () =>
    (await q<{ product_name: string; quantity: string; threshold: string; total_low: number }>("select product_name, quantity::text, threshold::text, total_low from low_stock_items($1,$2)", [shopId, limit])).rows);

  it("flags quantity <= threshold from the latest count; out-of-stock first; threshold 0 alerts only at zero", async () => {
    const rows = await low();
    // Alpha 15 <= 20 (low), Beta 8 <= 10 (low), Oil 5 <= 5 (low), Delta 0 <= 0 (out of stock), Gamma 25 > 10 (ok), Epsilon archived
    expect(rows.map((r) => r.product_name)).toEqual(["Delta", "Alpha", "Beta", "Oil"]); // by stock-to-threshold ratio: 0.75, 0.80, 1.0
    expect(rows[0]).toMatchObject({ quantity: "0.000", total_low: 4 });
  });
  it("ignores archived products and products not counted in the latest count", async () => {
    expect((await low()).some((r) => r.product_name === "Epsilon")).toBe(false);
  });
  it("limit trims the list but total_low still reports every low product", async () => {
    const rows = await low(owner, shop, 2);
    expect(rows).toHaveLength(2);
    expect(rows[0].total_low).toBe(4);
  });
  it("is scoped to the caller's shop", async () => {
    expect(await low(outsider, shop)).toEqual([]);
  });
});

describe("access", () => {
  it("anonymous users cannot call the dashboard functions", async () => {
    await asUser(db, null, () => expect(q("select * from sales_daily_summary($1, current_date, current_date)", [shop])).rejects.toThrow(/permission denied/));
  });
});
