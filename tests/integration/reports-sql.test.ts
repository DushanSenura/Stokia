// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, addMonths, daysInMonth, monthOf } from "@/lib/dates/business";
import { addUser, asUser, createDb } from "./db-harness";

let db: PGlite;
let owner: string, viewer: string, outsider: string;
let shop: string, otherShop: string;
let T: string, CUR: string, M: string, FIRST: string, NEXT: string, N: number;
let A: string, B: string, C: string, E: string, F: string, foreign: string;
let catSpices: string, catOils: string;

const q = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<R>(sql, params);
const rejects = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toThrow(re);
const num = (v: unknown) => Number(v);

interface Row {
  variant_id: string; product_name: string; category_name: string | null; base_unit: string;
  opening: string | null; closing: string | null; received: string; returned_in: string; damaged_out: string; other_out: string; adjustments: string;
  units_sold: string; estimated_amount: string; days_calculated: number; days_review: number; days_pending: number; max_revision: number;
  closing_cost: string | null; closing_value: string | null;
}
const report = (month: string, user = owner, shopId = shop) => asUser(db, user, async () =>
  (await q<Row>("select * from monthly_report_variants($1,$2)", [shopId, month])).rows);
const fingerprint = (month: string) => asUser(db, owner, async () => (await q<{ f: string }>("select monthly_report_fingerprint($1,$2) f", [shop, month])).rows[0].f);
const by = (rows: Row[], id: string) => rows.find((r) => r.variant_id === id)!;
/** opening + received + returns - damaged - other + adjustments - closing: equals units sold when EVERY day of the month was calculated */
const unreconciled = (r: Row) => num(r.opening) + num(r.received) + num(r.returned_in) - num(r.damaged_out) - num(r.other_out) + num(r.adjustments) - num(r.closing) - num(r.units_sold);

async function countDay(date: string, entries: [string, number | null][]) {
  const lines = JSON.stringify(entries.filter(([, n]) => n !== null).map(([variant_id, n]) => ({ variant_id, normalized_base_quantity: n })));
  const r = await asUser(db, owner, async () => (await q<{ r: { session_id: string; revision: number } }>("select save_count_draft($1,$2::date,$3::jsonb,null) r", [shop, date, lines])).rows[0].r);
  // counting started at 08:00 shop time on that date
  await q("update stock_count_sessions set counted_at = ($2::date::timestamp + interval '8 hours') at time zone 'Asia/Colombo' where id=$1", [r.session_id, date]);
  await asUser(db, owner, () => q("select confirm_count($1,$2,true)", [r.session_id, r.revision]));
}
const move = (variant: string, type: string, qty: number, effect: number, atIso: string, key: string, reason = "test") =>
  asUser(db, owner, async () => (await q<{ r: { id: string } }>("select record_movement($1,$2,$3::movement_type,$4,null,$5,$6::timestamptz,$7,null,null,null,$8) r", [shop, variant, type, qty, effect, atIso, reason, key])).rows[0].r);

beforeAll(async () => {
  db = await createDb();
  [owner, viewer, outsider] = await Promise.all(["o", "v", "x"].map((n) => addUser(db, `${n}@shop.lk`)));
  shop = await asUser(db, owner, async () => (await q<{ s: string }>("select create_shop('Perera Stores') s")).rows[0].s);
  otherShop = await asUser(db, outsider, async () => (await q<{ s: string }>("select create_shop('Other') s")).rows[0].s);
  await q("insert into shop_memberships (shop_id,user_id,role) values ($1,$2,'viewer')", [shop, viewer]);

  T = (await q<{ t: string }>("select (now() at time zone 'Asia/Colombo')::date::text t")).rows[0].t;
  CUR = monthOf(T); M = addMonths(CUR, -1); FIRST = `${M}-01`; NEXT = `${CUR}-01`; N = daysInMonth(M);

  await asUser(db, owner, async () => {
    catSpices = (await q<{ id: string }>("insert into categories (shop_id,name) values ($1,'Spices') returning id", [shop])).rows[0].id;
    catOils = (await q<{ id: string }>("insert into categories (shop_id,name) values ($1,'Oils') returning id", [shop])).rows[0].id;
  });
  const mk = (shopId: string, user: string, name: string, o: { cat?: string; unit?: string; price?: number; cost?: number }) => asUser(db, user, async () => {
    const p = (await q<{ id: string }>("insert into products (shop_id,name,product_code,category_id) values ($1,$2,$2,$3) returning id", [shopId, name, o.cat ?? null])).rows[0].id;
    const v = (await q<{ id: string }>("insert into product_variants (product_id,shop_id,sku,base_inventory_unit) values ($1,$2,$3,$4) returning id", [p, shopId, `${name}-1`, o.unit ?? "packet"])).rows[0].id;
    const old = new Date(Date.now() - 300 * 86400_000).toISOString();
    if (o.price) await q("select set_variant_price($1,'selling',$2,$3::timestamptz)", [v, o.price, old]);
    if (o.cost) await q("select set_variant_price($1,'purchase_cost',$2,$3::timestamptz)", [v, o.cost, old]);
    return v;
  });
  A = await mk(shop, owner, "Alpha", { cat: catSpices, price: 150, cost: 100 });
  B = await mk(shop, owner, "Oil", { cat: catOils, unit: "bottle", price: 300, cost: 250 });
  C = await mk(shop, owner, "Gamma", { cat: catSpices, price: 50 });                 // no purchase cost
  E = await mk(shop, owner, "Epsilon", { cat: catSpices, price: 80, cost: 20 });     // never sells
  F = await mk(shop, owner, "Foxtrot", {});                                          // never counted, one movement
  foreign = await mk(otherShop, outsider, "Zulu", { price: 10 });

  // ---- a whole month of mornings, then the 1st of the next month (the closing count) ----
  let a = 1000, b = 400, c = 500;
  for (let i = 0; i <= N; i++) {
    const d = addDays(FIRST, i);
    if (i > 0) {
      a -= 10; b -= 4; c -= 5;
      if (i === 10) { await move(A, "stock_received", 100, 100, `${d}T00:30:00Z`, "a-delivery", "Early delivery, on the shelf before the 08:00 count"); a += 100; }
      if (i === 6) { await move(B, "damaged", 2, -2, `${addDays(d, -1)}T08:30:00Z`, "b-damage", "Leaking bottles"); b -= 2; }
      if (i === 5) c += 30; // unexplained increase, nothing recorded
    }
    await countDay(d, [[A, a], [B, b], [C, c], [E, 50]]);
  }
  // Foxtrot: a movement at 20:00 UTC = 01:30 the NEXT day in Colombo
  await move(F, "stock_received", 7, 7, `${addDays(FIRST, 11)}T20:00:00Z`, "f-late");
}, 180_000);
afterAll(() => db.close());

describe("monthly_report_variants: a closed month", () => {
  it("uses the opening count (1st) and the closing count (1st of next month), not a sum of mornings", async () => {
    const rows = await report(M);
    const a = by(rows, A);
    expect(num(a.opening)).toBe(1000);
    expect(num(a.received)).toBe(100);
    expect(num(a.closing)).toBe(1000 - 10 * N + 100);
  });

  it("units sold = opening + movements - closing, exactly, when every day was calculated (A, B, E)", async () => {
    const rows = await report(M);
    for (const id of [A, B, E]) {
      const r = by(rows, id);
      expect(r.days_calculated, r.product_name).toBe(N);
      expect(unreconciled(r), r.product_name).toBe(0);
    }
    expect(num(by(rows, A).units_sold)).toBe(10 * N);
    expect(num(by(rows, A).estimated_amount)).toBe(1500 * N);
    expect(num(by(rows, B).units_sold)).toBe(4 * N);            // the damaged bottles are NOT counted as sold
    expect(num(by(rows, B).damaged_out)).toBe(2);
    expect(num(by(rows, B).estimated_amount)).toBe(1200 * N);
  });

  it("an unexplained increase leaves a visible gap instead of being hidden or zeroed (C: -25)", async () => {
    const c = by(await report(M), C);
    expect([c.days_review, c.days_calculated]).toEqual([1, N - 1]);
    expect(num(c.units_sold)).toBe(5 * (N - 1));
    expect(unreconciled(c)).toBe(-25);
  });

  it("a product that never sold still appears, with zero (not missing) sales", async () => {
    const e = by(await report(M), E);
    expect([num(e.units_sold), num(e.estimated_amount)]).toEqual([0, 0]);
  });

  it("values closing stock at the purchase cost in force at the closing count; uncosted products are flagged, not guessed", async () => {
    const rows = await report(M);
    const a = by(rows, A);
    expect([num(a.closing_cost), num(a.closing_value)]).toEqual([100, 100 * num(a.closing)]);
    expect(num(by(rows, E).closing_value)).toBe(50 * 20);
    const c = by(rows, C);
    expect([c.closing_cost, c.closing_value]).toEqual([null, null]);
    expect(c.closing).not.toBeNull();
  });

  it("carries category names (and null for uncategorised) and per-unit base units", async () => {
    const rows = await report(M);
    expect([by(rows, A).category_name, by(rows, B).category_name, by(rows, F)?.category_name]).toEqual(["Spices", "Oils", null]);
    expect([by(rows, A).base_unit, by(rows, B).base_unit]).toEqual(["packet", "bottle"]);
  });

  it("a movement recorded in the month for a never-counted product is reported (opening/closing stay null, never zero)", async () => {
    const f = by(await report(M), F);
    expect([f.opening, f.closing]).toEqual([null, null]);
    expect(num(f.received)).toBe(7);
  });

  it("is scoped to the shop (RLS); viewers may read; other shops see nothing; bad input is refused", async () => {
    expect((await report(M, viewer)).length).toBeGreaterThan(0);
    expect(await report(M, outsider, shop)).toEqual([]);
    await asUser(db, owner, () => rejects(q("select * from monthly_report_variants($1,'2026-13')", [shop]), /INVALID_MONTH/));
    await asUser(db, null, () => rejects(q("select * from monthly_report_variants($1,$2)", [shop, M]), /permission denied/));
  });
});

describe("monthly_report_variants: the open month (month boundary rule)", () => {
  it("the current month has an opening count (the 1st) but NO closing count yet, so closing stock is null, not zero", async () => {
    const rows = await report(CUR);
    const a = by(rows, A);
    expect(a.opening).not.toBeNull();
    expect(a.closing).toBeNull();
    expect([a.closing_value, a.days_calculated]).toEqual([null, 0]);   // nothing is calculated until later mornings are counted
    expect(a.days_pending).toBeGreaterThan(0);
  });
  it("the previous month's closing count IS this month's opening count (continuity)", async () => {
    expect(num(by(await report(CUR), A).opening)).toBe(num(by(await report(M), A).closing));
  });
});

describe("fingerprint: detects that a report changed after it was exported", () => {
  it("is stable for unchanged data and different for different months", async () => {
    expect(await fingerprint(M)).toBe(await fingerprint(M));
    expect(await fingerprint(M)).not.toBe(await fingerprint(CUR));
  });
  it("changes when a late movement recalculates a day of the month (and the totals follow)", async () => {
    const before = await fingerprint(M);
    const unitsBefore = num(by(await report(M), A).units_sold);
    await move(A, "stock_received", 5, 5, `${addDays(FIRST, 2)}T06:00:00Z`, "late-recv", "Forgotten delivery");
    expect(await fingerprint(M)).not.toBe(before);
    const a = by(await report(M), A);
    expect(num(a.units_sold)).toBe(unitsBefore + 5);                    // 5 more units were sold that day than first calculated
    expect(a.max_revision).toBeGreaterThan(1);                           // the report can say "recalculated"
    expect(unreconciled(a)).toBe(0);                                     // and the identity still holds
  });
  it("a corrected count across the month boundary updates BOTH months", async () => {
    // the 1st of the next month is the closing count of M and the opening count of CUR
    const closingBefore = num(by(await report(M), B).closing);
    await q("update stock_count_lines set normalized_base_quantity = normalized_base_quantity - 6 where variant_id=$1 and session_id=(select id from stock_count_sessions where shop_id=$2 and business_date=$3)", [B, shop, NEXT]);
    await q("select _recalc_range($1,$2::date,$3::date,'count_corrected')", [shop, addDays(NEXT, -1), NEXT]);
    const m = by(await report(M), B), c = by(await report(CUR), B);
    expect(num(m.closing)).toBe(closingBefore - 6);
    expect(num(c.opening)).toBe(closingBefore - 6);
    expect(num(m.units_sold)).toBe(4 * N + 6);                            // the last day of M sold 6 more than first thought
    expect(unreconciled(m)).toBe(0);
  });
});

describe("report_exports", () => {
  it("any member may record an export; the record is an audit trail; clients cannot write the table", async () => {
    const fp = await fingerprint(M);
    const id = await asUser(db, viewer, async () => (await q<{ r: string }>("select record_report_export($1,$2,'pdf',$3,'{\"estimated\":1}'::jsonb) r", [shop, M, fp])).rows[0].r);
    expect(id).toBeTruthy();
    await asUser(db, owner, async () => {
      const rows = (await q<{ format: string; report_month: string; fingerprint: string }>("select format, report_month, fingerprint from report_exports")).rows;
      expect(rows).toEqual([{ format: "pdf", report_month: M, fingerprint: fp }]);
    });
    await asUser(db, outsider, () => rejects(q("select record_report_export($1,$2,'csv','x',null)", [shop, M]), /FORBIDDEN/));
    await asUser(db, viewer, () => rejects(q("insert into report_exports (shop_id,report_month,format,fingerprint,exported_by) values ($1,$2,'csv','x',$3)", [shop, M, viewer]), /permission denied/));
    await asUser(db, viewer, () => rejects(q("delete from report_exports"), /permission denied/));
    expect((await q("select 1 from audit_logs where action='export_report'")).rows).toHaveLength(1);
  });
  it("rejects unknown formats and malformed months at the table level", async () => {
    await expect(q("insert into report_exports (shop_id,report_month,format,fingerprint,exported_by) values ($1,'2026-11','docx','x',$2)", [shop, owner])).rejects.toThrow(/check/);
    await expect(q("insert into report_exports (shop_id,report_month,format,fingerprint,exported_by) values ($1,'Nov','pdf','x',$2)", [shop, owner])).rejects.toThrow(/check/);
  });
  it("other shops cannot see this shop's export history", async () => {
    await asUser(db, outsider, async () => expect((await q("select * from report_exports")).rows).toHaveLength(0));
  });
});

describe("analytics functions", () => {
  const from = () => FIRST, to = () => addDays(NEXT, -1);
  const variants = (u: string, f: string, t: string, cat: string | null = null, prod: string | null = null, vr: string | null = null, shopId = shop) => asUser(db, u, async () =>
    (await q<{ variant_id: string; product_name: string; units_sold: string; estimated_amount: string; days_calculated: number; days_review: number; category_name: string | null }>(
      "select variant_id, product_name, units_sold::text, estimated_amount::text, days_calculated, days_review, category_name from analytics_variant_summary($1,$2::date,$3::date,$4,$5,$6)", [shopId, f, t, cat, prod, vr])).rows);

  it("lists every active variant with its sales over the range, ranked by Estimated Sales; zero-sales variants included", async () => {
    const rows = await variants(owner, from(), to());
    expect(rows.map((r) => r.product_name).slice(0, 3)).toEqual(["Alpha", "Oil", "Gamma"]); // 1,500/day, 1,200/day, 250/day
    expect(rows.find((r) => r.product_name === "Epsilon")).toMatchObject({ units_sold: "0.000", estimated_amount: "0.00" });
    expect(rows.find((r) => r.product_name === "Gamma")).toMatchObject({ days_review: 1 });
  });
  it("filters by category, product and variant (and combinations)", async () => {
    const spices = await variants(owner, from(), to(), catSpices);
    expect(spices.map((r) => r.product_name).sort()).toEqual(["Alpha", "Epsilon", "Gamma"]);
    expect((await variants(owner, from(), to(), catOils)).map((r) => r.product_name)).toEqual(["Oil"]);
    const prod = (await q<{ id: string }>("select product_id id from product_variants where id=$1", [A])).rows[0].id;
    expect((await variants(owner, from(), to(), null, prod)).map((r) => r.product_name)).toEqual(["Alpha"]);
    expect((await variants(owner, from(), to(), null, null, B)).map((r) => r.product_name)).toEqual(["Oil"]);
    expect(await variants(owner, from(), to(), catOils, null, A)).toEqual([]); // contradictory filters match nothing
  });
  it("a narrower date range only counts those days", async () => {
    const one = await variants(owner, from(), from(), null, null, A);
    expect(one[0]).toMatchObject({ units_sold: "10.000", days_calculated: 1 });
  });
  it("an archived product that sold in the range still appears (history is not hidden)", async () => {
    await q("update products set is_active=false where product_code='Gamma'");
    expect((await variants(owner, from(), to())).some((r) => r.product_name === "Gamma")).toBe(true);
    await q("update products set is_active=true where product_code='Gamma'");
  });

  it("analytics_daily: per day and per base unit, honouring filters; money additive, units separate", async () => {
    const rows = await asUser(db, owner, async () => (await q<{ sales_date: string; base_unit: string; units_sold: string; estimated_amount: string; needs_review_count: number }>(
      "select sales_date::text, base_unit, units_sold::text, estimated_amount::text, needs_review_count from analytics_daily($1,$2::date,$3::date)", [shop, FIRST, FIRST])).rows);
    // day 1: A sold 10, C sold 5, E 0 (packets) ; B sold 4 (bottles)
    expect(rows.find((r) => r.base_unit === "packet")).toMatchObject({ units_sold: "15.000", estimated_amount: "1750.00" });
    expect(rows.find((r) => r.base_unit === "bottle")).toMatchObject({ units_sold: "4.000", estimated_amount: "1200.00" });
    const filtered = await asUser(db, owner, async () => (await q<{ base_unit: string }>("select base_unit from analytics_daily($1,$2::date,$3::date,$4)", [shop, FIRST, FIRST, catOils])).rows);
    expect(filtered.map((r) => r.base_unit)).toEqual(["bottle"]);
    const review = await asUser(db, owner, async () => (await q<{ n: number }>("select needs_review_count n from analytics_daily($1,$2::date,$3::date) where base_unit='packet'", [shop, addDays(FIRST, 4), addDays(FIRST, 4)])).rows[0]);
    expect(review.n).toBe(1);   // the day BEFORE the count that showed the unexplained +30 (count on day 5 -> sales day 4)
  });

  it("analytics_movement_trend groups by SHOP-LOCAL day and base unit; outflows are positive numbers", async () => {
    const rows = await asUser(db, owner, async () => (await q<{ day: string; base_unit: string; received: string; damaged_out: string; movement_count: number }>(
      "select day::text, base_unit, received::text, damaged_out::text, movement_count from analytics_movement_trend($1,$2::date,$3::date)", [shop, FIRST, NEXT])).rows);
    expect(rows.find((r) => r.day === addDays(FIRST, 10) && r.base_unit === "packet")).toMatchObject({ received: "100.000" }); // 06:00 on the 11th
    expect(rows.find((r) => r.base_unit === "bottle" && Number(r.damaged_out) > 0)).toMatchObject({ day: addDays(FIRST, 5), damaged_out: "2.000" }); // 14:00 on the 6th
    // Foxtrot's movement at 20:00 UTC belongs to the NEXT shop-local day (01:30 in Colombo)
    expect(rows.find((r) => r.day === addDays(FIRST, 12) && Number(r.received) === 7)).toBeTruthy();
    expect(rows.find((r) => r.day === addDays(FIRST, 11) && Number(r.received) === 7)).toBeUndefined();
  });

  it("RLS and limits: other shops get nothing, huge ranges are refused, anonymous users are denied", async () => {
    expect(await variants(outsider, from(), to(), null, null, null, shop)).toEqual([]);
    expect((await variants(outsider, from(), to(), null, null, null, otherShop)).map((r) => r.product_name)).toEqual(["Zulu"]);
    await asUser(db, owner, () => rejects(q("select * from analytics_variant_summary($1,$2::date,$3::date)", [shop, addDays(T, -500), T]), /RANGE_TOO_LARGE/));
    await asUser(db, owner, () => rejects(q("select * from analytics_daily($1,$2::date,$3::date)", [shop, addDays(T, -500), T]), /RANGE_TOO_LARGE/));
    await asUser(db, owner, () => rejects(q("select * from analytics_movement_trend($1,$2::date,$3::date)", [shop, addDays(T, -500), T]), /RANGE_TOO_LARGE/));
    await asUser(db, null, () => rejects(q("select * from analytics_daily($1,$2::date,$3::date)", [shop, from(), to()]), /permission denied/));
    void foreign;
  });
});
