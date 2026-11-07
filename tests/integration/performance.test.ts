// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates/business";
import { addUser, asUser, createDb } from "./db-harness";

/**
 * A big shop: 3,000 products x 14 mornings = 42,000 count lines and 42,000 daily-sales rows.
 * Budgets are deliberately generous (CI machines vary); they exist to catch accidental O(n^2) behaviour or a lost index,
 * not to benchmark. Real timings are printed so regressions are visible in the log.
 */
const N = 3000;
const DAYS = 14;

let db: PGlite;
let owner: string, shop: string, T: string;
const q = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<R>(sql, params);

async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  const ms = Math.round(performance.now() - t0);
  console.log(`[perf] ${label}: ${ms} ms`);
  return { ms, value };
}

beforeAll(async () => {
  db = await createDb();
  owner = await addUser(db, "o@shop.lk");
  shop = await asUser(db, owner, async () => (await q<{ s: string }>("select create_shop('Big Mart') s")).rows[0].s);
  T = (await q<{ t: string }>("select (now() at time zone 'Asia/Colombo')::date::text t")).rows[0].t;

  await q(`insert into categories (shop_id, name) select $1, 'Cat ' || g from generate_series(1, 40) g`, [shop]);
  await q(`insert into products (shop_id, name, product_code, category_id)
           select $1, 'Product ' || g, 'P' || g, (select id from categories where shop_id = $1 order by name limit 1 offset (g % 40)) from generate_series(1, ${N}) g`, [shop]);
  await q(`insert into product_variants (product_id, shop_id, sku)
           select p.id, p.shop_id, 'SKU-' || p.product_code from products p where p.shop_id = $1`, [shop]);
  await q(`insert into product_price_history (variant_id, price_type, amount_lkr, effective_from)
           select id, 'selling', 100 + (random() * 900)::int, now() - interval '200 days' from product_variants where shop_id = $1`, [shop]);
  await q(`insert into product_price_history (variant_id, price_type, amount_lkr, effective_from)
           select id, 'purchase_cost', 60, now() - interval '200 days' from product_variants where shop_id = $1`, [shop]);

  // 14 confirmed mornings, each product falling by 1 to 5 units a day from 1000
  for (let d = DAYS; d >= 1; d--) {
    const date = addDays(T, -d);
    const s = (await q<{ id: string }>(
      `insert into stock_count_sessions (shop_id, business_date, status, created_by, confirmed_by, confirmed_at, counted_at)
       values ($1, $2::date, 'confirmed', $3, $3, now(), now() - ($4 || ' days')::interval) returning id`, [shop, date, owner, String(d)])).rows[0].id;
    await q(`insert into stock_count_lines (session_id, variant_id, normalized_base_quantity, count_status)
             select $1, v.id, 1000 - $2::int * 3 - (abs(hashtext(v.id::text)) % 3), 'counted' from product_variants v where v.shop_id = $3`, [s, DAYS - d, shop]);
  }
  await q("select _recalc_range($1, $2::date, $3::date, 'seed')", [shop, addDays(T, -DAYS), T]);
  await q("analyze");
}, 240_000);

describe(`large catalog (${N} products, ${DAYS} mornings)`, () => {
  it("seeded as expected", async () => {
    expect(Number((await q<{ n: string }>("select count(*) n from stock_count_lines")).rows[0].n)).toBe(N * DAYS);
    expect(Number((await q<{ n: string }>("select count(*) n from daily_sales where calculation_status in ('calculated','recalculated')")).rows[0].n)).toBe(N * (DAYS - 1));
  });

  it("dashboard figures come back quickly", async () => {
    const a = await timed("sales_daily_summary", () => asUser(db, owner, () => q("select * from sales_daily_summary($1, $2::date, $3::date)", [shop, addDays(T, -DAYS), T])));
    const b = await timed("low_stock_items", () => asUser(db, owner, () => q("select * from low_stock_items($1)", [shop])));
    const c = await timed("stock_valuation", () => asUser(db, owner, () => q("select * from stock_valuation($1)", [shop])));
    const d = await timed("sales_top_products", () => asUser(db, owner, () => q("select * from sales_top_products($1, $2::date, $3::date, 10)", [shop, addDays(T, -DAYS), T])));
    for (const r of [a, b, c, d]) expect(r.ms).toBeLessThan(4000);
    expect(a.value.rows.length).toBeGreaterThan(0);
  });

  it("analytics and the monthly report scale", async () => {
    const a = await timed("analytics_variant_summary (all products)", () => asUser(db, owner, () => q("select * from analytics_variant_summary($1, $2::date, $3::date)", [shop, addDays(T, -DAYS), T])));
    expect(a.value.rows).toHaveLength(N);
    expect(a.ms).toBeLessThan(6000);
    const b = await timed("analytics_daily", () => asUser(db, owner, () => q("select * from analytics_daily($1, $2::date, $3::date)", [shop, addDays(T, -DAYS), T])));
    expect(b.ms).toBeLessThan(4000);
  });

  it("confirming a morning count of all products reconciles in one go", async () => {
    const lines = JSON.stringify((await q<{ id: string }>("select id from product_variants where shop_id=$1", [shop])).rows.map((r) => ({ variant_id: r.id, normalized_base_quantity: 900 })));
    const saved = await timed("save_count_draft (3000 lines)", () => asUser(db, owner, async () => (await q<{ r: { session_id: string; revision: number } }>("select save_count_draft($1,$2::date,$3::jsonb,null) r", [shop, T, lines])).rows[0].r));
    expect(saved.ms).toBeLessThan(8000);
    const conf = await timed("confirm_count (3000 lines + reconcile yesterday)", () => asUser(db, owner, () => q("select confirm_count($1,$2,true)", [saved.value.session_id, saved.value.revision])));
    expect(conf.ms).toBeLessThan(10000);
    const row = (await q<{ n: string }>("select count(*) n from daily_sales where shop_id=$1 and sales_date=$2 and calculation_status in ('calculated','recalculated')", [shop, addDays(T, -1)])).rows[0];
    expect(Number(row.n)).toBe(N);
  });

  it("the health check over the whole window finishes, finds nothing wrong, and changes nothing", async () => {
    const before = (await q<{ n: string }>("select count(*) n from daily_sales_revisions")).rows[0].n;
    const h = await timed("data_health_check (30 days)", () => asUser(db, owner, async () => (await q<{ r: { errors: number } }>("select data_health_check($1, 30) r", [shop])).rows[0].r));
    expect(h.value.errors).toBe(0);
    expect(h.ms).toBeLessThan(30000);
    expect((await q<{ n: string }>("select count(*) n from daily_sales_revisions")).rows[0].n).toBe(before);
  });

  it("the hot queries use indexes instead of scanning whole tables", async () => {
    const plan = async (sql: string, params: unknown[]) => {
      await q("set enable_seqscan = off"); // if an index CAN serve the query, the planner must pick it
      try { return (await q<{ "QUERY PLAN": string }>(`explain ${sql}`, params)).rows.map((r) => r["QUERY PLAN"]).join("\n"); }
      finally { await q("reset enable_seqscan"); }
    };
    const v = (await q<{ id: string }>("select id from product_variants where shop_id=$1 limit 1", [shop])).rows[0].id;
    expect(await plan("select * from stock_count_lines where variant_id = $1", [v])).toMatch(/count_lines_variant_idx/);
    expect(await plan("select * from daily_sales where shop_id = $1 and variant_id = $2 and sales_date >= $3::date", [shop, v, addDays(T, -7)])).toMatch(/daily_sales_shop_id_variant_id_sales_date_key/);
    expect(await plan("select * from stock_movements where shop_id = $1 order by effective_at desc limit 20", [shop])).toMatch(/movements_shop_time_idx/);
    expect(await plan("select * from stock_count_sessions where shop_id = $1 and status in ('confirmed') order by business_date desc limit 1", [shop])).toMatch(/sessions_shop_status_date_idx|stock_count_sessions_shop_id_business_date_key/);
    expect(await plan("select * from audit_logs where shop_id = $1 and action = 'confirm_count' order by created_at desc limit 25", [shop])).toMatch(/audit_shop_action_idx|audit_logs_shop_time_idx/);
  });

  it("recalculating one day touches only that day's rows (cost does not grow with history)", async () => {
    const t1 = await timed("_recalc_sales_day (one day, 3000 products)", () => q("select _recalc_sales_day($1, $2::date, 'perf')", [shop, addDays(T, -5)]));
    expect(t1.ms).toBeLessThan(6000);
  });
});
