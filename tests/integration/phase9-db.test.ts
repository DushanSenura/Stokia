// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates/business";
import { addUser, asUser, createDb } from "./db-harness";

let db: PGlite;
let owner: string, manager: string, viewer: string, outsider: string;
let shop: string, otherShop: string;
let T: string, d1: string, d2: string, d3: string;
let v1: string, v2: string;
const sessions: Record<string, string> = {};

const q = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<R>(sql, params);
const rejects = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toThrow(re);

interface Check { key: string; severity: "error" | "warning"; count: number; sample: string[] }
interface Health { errors: number; warnings: number; checks: Check[] }
const health = (user = owner, s = shop, days = 90) =>
  asUser(db, user, async () => (await q<{ r: Health }>("select data_health_check($1,$2) r", [s, days])).rows[0].r);
const repair = (user = owner, s = shop, days = 90) =>
  asUser(db, user, async () => (await q<{ r: { changed: number } }>("select repair_sales($1,$2) r", [s, days])).rows[0].r);
const check = (h: Health, key: string) => h.checks.find((c) => c.key === key)!;
const failing = (h: Health) => h.checks.filter((c) => c.count > 0).map((c) => c.key).sort();

async function countDay(s: string, user: string, date: string, hoursAgo: number, entries: [string, number][]) {
  const lines = JSON.stringify(entries.map(([variant_id, n]) => ({ variant_id, normalized_base_quantity: n })));
  const r = await asUser(db, user, async () => (await q<{ r: { session_id: string; revision: number } }>("select save_count_draft($1,$2::date,$3::jsonb,null) r", [s, date, lines])).rows[0].r);
  await q("update stock_count_sessions set counted_at = now() - ($2 || ' hours')::interval where id=$1", [r.session_id, String(hoursAgo)]);
  await asUser(db, user, () => q("select confirm_count($1,$2,true)", [r.session_id, r.revision]));
  sessions[date] = r.session_id;
}
const sale = async (variant: string, date: string) =>
  (await q<{ id: string; units: string | null; status: string }>("select id, inferred_base_units_sold::float8::text units, calculation_status::text status from daily_sales where shop_id=$1 and variant_id=$2 and sales_date=$3", [shop, variant, date])).rows[0];
const revisions = async () => Number((await q<{ n: string }>("select count(*) n from daily_sales_revisions where shop_id=$1", [shop])).rows[0].n);

beforeAll(async () => {
  db = await createDb();
  [owner, manager, viewer, outsider] = await Promise.all(["o", "m", "v", "x"].map((n) => addUser(db, `${n}@shop.lk`)));
  shop = await asUser(db, owner, async () => (await q<{ s: string }>("select create_shop('Perera Stores') s")).rows[0].s);
  otherShop = await asUser(db, outsider, async () => (await q<{ s: string }>("select create_shop('Other') s")).rows[0].s);
  await q("insert into shop_memberships (shop_id,user_id,role) values ($1,$2,'stock_manager'),($1,$3,'viewer')", [shop, manager, viewer]);

  const t = (await q<{ t: string }>("select (now() at time zone 'Asia/Colombo')::date::text t")).rows[0].t;
  [T, d1, d2, d3] = [t, addDays(t, -1), addDays(t, -2), addDays(t, -3)];
  const mk = (s: string, user: string, name: string) => asUser(db, user, async () => {
    const p = (await q<{ id: string }>("insert into products (shop_id,name,product_code) values ($1,$2,$2) returning id", [s, name])).rows[0].id;
    const v = (await q<{ id: string }>("insert into product_variants (product_id,shop_id,sku) values ($1,$2,$3) returning id", [p, s, `${name}-1`])).rows[0].id;
    await q("select set_variant_price($1,'selling',150,now() - interval '100 days')", [v]);
    return v;
  });
  v1 = await mk(shop, owner, "Oil");
  v2 = await mk(shop, owner, "Rice");
  const o1 = await mk(otherShop, outsider, "Soap");

  // three consecutive mornings: T-3 (100/50), T-2 (90/45), T-1 (70/45), and a second, independent shop
  await countDay(shop, owner, d3, 72, [[v1, 100], [v2, 50]]);
  await countDay(shop, owner, d2, 48, [[v1, 90], [v2, 45]]);
  await countDay(shop, owner, d1, 24, [[v1, 70], [v2, 45]]);
  await countDay(otherShop, outsider, d2, 48, [[o1, 10]]);
  await countDay(otherShop, outsider, d1, 24, [[o1, 4]]);
});

describe("Phase 9: data health check", () => {
  it("a consistent shop reports no errors and leaves the stored sales untouched", async () => {
    const before = await revisions();
    const h = await health();
    expect(h.errors).toBe(0);
    expect(failing(h).filter((k) => !["active_products_without_selling_price"].includes(k))).toEqual([]);
    expect(check(h, "stored_sales_differ_from_recalculation").count).toBe(0);
    expect(await revisions()).toBe(before);
    expect((await sale(v1, d3)).units).toBe("10");
    expect((await sale(v1, d2)).units).toBe("20");
  });

  it("the dry run is rolled back: a deliberately wrong figure is detected but NOT fixed by the check", async () => {
    await q("update daily_sales set inferred_base_units_sold = 999 where id = $1", [(await sale(v1, d3)).id]);
    const h = await health();
    expect(check(h, "stored_sales_differ_from_recalculation").count).toBe(1);
    expect(h.errors).toBeGreaterThan(0);
    expect((await sale(v1, d3)).units).toBe("999"); // still wrong: a check only looks
  });

  it("repair recalculates from the confirmed counts, keeps history, and the next check is clean", async () => {
    const before = await revisions();
    const r = await repair();
    expect(r.changed).toBe(1);
    expect((await sale(v1, d3)).units).toBe("10");
    expect(await revisions()).toBe(before + 1); // the wrong figure is preserved as a superseded revision
    const h = await health();
    expect(check(h, "stored_sales_differ_from_recalculation").count).toBe(0);
    expect(h.errors).toBe(0);
    const audit = await q<{ after_data: { rows_changed: number } }>("select after_data from audit_logs where shop_id=$1 and action='repair_sales'", [shop]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].after_data.rows_changed).toBe(1);
  });

  it("repair is idempotent: running it again changes nothing", async () => {
    const before = await revisions();
    expect((await repair()).changed).toBe(0);
    expect(await revisions()).toBe(before);
  });

  it("detects a calculated sale with an impossible (negative) figure", async () => {
    const s = await sale(v2, d2);
    await q("update daily_sales set inferred_base_units_sold = -3 where id = $1", [s.id]);
    expect(check(await health(), "calculated_sale_without_valid_figure").count).toBe(1);
    await repair();
    expect(check(await health(), "calculated_sale_without_valid_figure").count).toBe(0);
  });

  it("detects a sale pointing at the wrong day's count, and repair re-links it", async () => {
    const s = await sale(v1, d2);
    const wrong = (await q<{ id: string }>("select id from stock_count_lines where session_id=$1 and variant_id=$2", [sessions[d3], v1])).rows[0].id;
    await q("update daily_sales set opening_count_id = $2 where id = $1", [s.id, wrong]);
    const h = await health();
    expect(check(h, "sales_linked_to_wrong_count").count).toBe(1);
    expect(check(h, "sales_linked_to_wrong_count").sample).toContain(s.id);
    await repair();
    expect(check(await health(), "sales_linked_to_wrong_count").count).toBe(0);
  });

  it("detects confirmed mornings whose sales rows are missing, and repair rebuilds them", async () => {
    await q("delete from daily_sales where shop_id=$1 and sales_date=$2", [shop, d3]);
    const h = await health();
    expect(check(h, "confirmed_days_without_sales_rows").count).toBe(1);
    expect(check(h, "stored_sales_differ_from_recalculation").count).toBe(2); // both products' rows would be re-created
    await repair();
    expect((await sale(v1, d3)).units).toBe("10");
    expect((await sale(v2, d3)).units).toBe("5");
    expect((await health()).errors).toBe(0);
  });

  it("detects a confirmed count with no lines and one with no confirmer", async () => {
    const empty = (await q<{ id: string }>(
      `insert into stock_count_sessions (shop_id, business_date, status, created_by, confirmed_by, confirmed_at)
       values ($1, $2::date - 20, 'confirmed', $3, $3, now()) returning id`, [shop, T, owner])).rows[0].id;
    const anon = (await q<{ id: string }>(
      `insert into stock_count_sessions (shop_id, business_date, status, created_by)
       values ($1, $2::date - 22, 'confirmed', $3) returning id`, [shop, T, owner])).rows[0].id;
    const h = await health(owner, shop, 120);
    expect(check(h, "confirmed_count_without_lines").sample).toContain(empty);
    expect(check(h, "confirmed_count_missing_confirmer").sample).toContain(anon);
    await q("delete from stock_count_sessions where id in ($1,$2)", [empty, anon]);
    expect((await health(owner, shop, 120)).errors).toBe(0);
  });

  it("detects rows that cross shops (a variant of another shop used in this shop)", async () => {
    const foreign = (await q<{ id: string }>("select id from product_variants where shop_id=$1", [otherShop])).rows[0].id;
    await q("alter table stock_movements disable trigger user");
    const m = (await q<{ id: string }>(
      `insert into stock_movements (shop_id, variant_id, type, input_quantity, normalized_base_quantity, effective_at, idempotency_key, created_by, reason)
       values ($1,$2,'stock_received',1,1,now() - interval '30 hours','x-1',$3,'test') returning id`, [shop, foreign, owner])).rows[0].id;
    expect(check(await health(), "movement_for_other_shop_variant").sample).toContain(m);
    await q("delete from stock_movements where id=$1", [m]);
    await q("alter table stock_movements enable trigger user");
  });

  it("warns (not errors) about active products that have no selling price, and about stale drafts", async () => {
    await asUser(db, owner, async () => {
      const p = (await q<{ id: string }>("insert into products (shop_id,name,product_code) values ($1,'NoPrice','NP') returning id", [shop])).rows[0].id;
      await q("insert into product_variants (product_id,shop_id,sku) values ($1,$2,'NP-1')", [p, shop]);
    });
    const stale = await asUser(db, owner, async () => (await q<{ r: { session_id: string } }>("select save_count_draft($1,$2::date,'[]'::jsonb,null) r", [shop, T])).rows[0].r.session_id);
    await q("update stock_count_sessions set counted_at = now() - interval '5 days' where id=$1", [stale]);
    const h = await health();
    expect(check(h, "active_products_without_selling_price").severity).toBe("warning");
    expect(check(h, "active_products_without_selling_price").count).toBe(1);
    expect(check(h, "old_unconfirmed_drafts").count).toBe(1);
    expect(h.errors).toBe(0);
    expect(h.warnings).toBe(2);
  });

  it("reports only this shop's problems, never another shop's", async () => {
    await q("update daily_sales set inferred_base_units_sold = 777 where shop_id=$1 and sales_date=$2", [otherShop, d2]);
    expect(check(await health(), "stored_sales_differ_from_recalculation").count).toBe(0);
    expect(check(await health(outsider, otherShop), "stored_sales_differ_from_recalculation").count).toBe(1);
  });
});

describe("Phase 9: who may run it", () => {
  it("owners only: managers, viewers and outsiders are refused for check, repair and backup audit", async () => {
    for (const u of [manager, viewer, outsider]) {
      await rejects(health(u), /FORBIDDEN/);
      await rejects(repair(u), /FORBIDDEN/);
      await rejects(asUser(db, u, () => q("select record_backup_export($1,'{}'::jsonb,'abc')", [shop])), /FORBIDDEN/);
    }
  });
  it("an owner of one shop cannot check or repair another shop", async () => {
    await rejects(health(owner, otherShop), /FORBIDDEN/);
    await rejects(repair(owner, otherShop), /FORBIDDEN/);
  });
  it("signed-out callers cannot reach any of them", async () => {
    for (const sql of ["select data_health_check($1,90)", "select repair_sales($1,90)", "select record_backup_export($1,'{}'::jsonb,'x')"]) {
      await rejects(asUser(db, null, () => q(sql, [shop])), /permission denied|FORBIDDEN/);
    }
  });
  it("internal helpers are not callable by signed-in users", async () => {
    await rejects(asUser(db, owner, () => q("select _sales_fingerprint($1, current_date)", [shop])), /permission denied/);
    await rejects(asUser(db, owner, () => q("select _sales_changed_since($1, current_date, '{}'::jsonb)", [shop])), /permission denied/);
  });
  it("rejects absurd ranges", async () => {
    await rejects(health(owner, shop, 0), /INVALID_RANGE/);
    await rejects(health(owner, shop, 5000), /INVALID_RANGE/);
    await rejects(repair(owner, shop, -1), /INVALID_RANGE/);
  });
  it("a backup download is recorded in the audit log with its row counts and checksum", async () => {
    await asUser(db, owner, () => q("select record_backup_export($1,$2::jsonb,'deadbeef')", [shop, JSON.stringify({ products: 3 })]));
    const a = await q<{ after_data: { rows: { products: number }; checksum: string } }>("select after_data from audit_logs where shop_id=$1 and action='export_backup'", [shop]);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0].after_data).toEqual({ rows: { products: 3 }, checksum: "deadbeef" });
  });
});
