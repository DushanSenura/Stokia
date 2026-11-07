// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates/business";
import { CAPABILITIES, can, ROLES, type Capability, type Role } from "@/server/permissions";
import { addUser, asUser, createDb } from "./db-harness";

let db: PGlite;
let users: Record<Role, string>;
let outsider: string;
let shopA: string, shopB: string;
let sessionA: string, variantA: string;
let T: string;

const q = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<R>(sql, params);

/** true if the statement ran; false if the database refused it (RLS, permission denied, role check). */
const allowed = async (run: () => Promise<unknown>) => { try { await run(); return true; } catch { return false; } };
/** true if the (RLS-filtered) statement actually touched a row. */
const touched = async (sql: string, params: unknown[]) => { try { return (await q(sql, params)).rows.length > 0; } catch { return false; } };

beforeAll(async () => {
  db = await createDb();
  const [o, m, v, x] = await Promise.all(["o", "m", "v", "x"].map((n) => addUser(db, `${n}@shop.lk`)));
  users = { owner: o, stock_manager: m, viewer: v };
  outsider = x;
  shopA = await asUser(db, o, async () => (await q<{ s: string }>("select create_shop('Shop A') s")).rows[0].s);
  shopB = await asUser(db, x, async () => (await q<{ s: string }>("select create_shop('Shop B') s")).rows[0].s);
  await q("insert into shop_memberships (shop_id,user_id,role) values ($1,$2,'stock_manager'),($1,$3,'viewer')", [shopA, m, v]);

  T = (await q<{ t: string }>("select (now() at time zone 'Asia/Colombo')::date::text t")).rows[0].t;
  variantA = await asUser(db, o, async () => {
    const p = (await q<{ id: string }>("insert into products (shop_id,name,product_code) values ($1,'P','P') returning id", [shopA])).rows[0].id;
    return (await q<{ id: string }>("insert into product_variants (product_id,shop_id,sku) values ($1,$2,'P-1') returning id", [p, shopA])).rows[0].id;
  });
  const saved = await asUser(db, o, async () => (await q<{ r: { session_id: string; revision: number } }>("select save_count_draft($1,$2::date,$3::jsonb,null) r", [shopA, addDays(T, -5), JSON.stringify([{ variant_id: variantA, normalized_base_quantity: 10 }])])).rows[0].r);
  await asUser(db, o, () => q("select confirm_count($1,$2,true)", [saved.session_id, saved.revision]));
  sessionA = saved.session_id;
}, 90_000);
afterAll(() => db.close());

/** Put the shared count back exactly as it was after an attempt that succeeded. */
async function reset() {
  await q("delete from stock_count_corrections");
  await q("update stock_count_lines set normalized_base_quantity = 10, entry_details = '{}'::jsonb where session_id=$1", [sessionA]);
  await q("update stock_count_sessions set status='confirmed' where id=$1", [sessionA]);
  await q("delete from stock_count_sessions where shop_id=$1 and status='draft'", [shopA]);
  await q("delete from report_exports");
}

/** One real attempt per capability, against the real database, as the given user. */
const attempt: Record<Capability, (u: string | null) => Promise<boolean>> = {
  "catalog.write": (u) => asUser(db, u, () => allowed(() => q("insert into categories (shop_id,name) values ($1,$2)", [shopA, `cat-${Math.random()}`]))),
  "inventory.write": (u) => asUser(db, u, () => allowed(() => q("select save_count_draft($1,$2::date,'[]',null)", [shopA, addDays(T, -4)]))),
  "corrections.request": (u) => asUser(db, u, () => allowed(() => q("select request_count_correction($1,$2,7,null,'recount')", [sessionA, variantA]))),
  "corrections.decide": async (u) => {
    await q("insert into stock_count_corrections (session_id,variant_id,old_quantity,new_quantity,reason,created_by,status) values ($1,$2,10,7,'x',$3,'pending')", [sessionA, variantA, users.stock_manager]);
    const id = (await q<{ id: string }>("select id from stock_count_corrections where status='pending'")).rows[0].id;
    return asUser(db, u, () => allowed(() => q("select decide_count_correction($1,false,'no')", [id])));
  },
  "team.manage": (u) => asUser(db, u, () => touched("update shop_memberships set status = status where shop_id=$1 returning id", [shopA])),
  "settings.write": (u) => asUser(db, u, () => touched("update shops set name = name where id=$1 returning id", [shopA])),
  "data.manage": (u) => asUser(db, u, () => allowed(() => q("select data_health_check($1, 7)", [shopA]))),
  "audit.read": (u) => asUser(db, u, () => touched("select id from audit_logs where shop_id=$1 limit 1", [shopA])),
  "data.read": (u) => asUser(db, u, () => touched("select id from products where shop_id=$1", [shopA])),
  "reports.export": (u) => asUser(db, u, () => allowed(() => q("select record_report_export($1,'2026-10','csv','fp',null)", [shopA]))),
};

describe("permission matrix == database behaviour", () => {
  for (const cap of Object.keys(CAPABILITIES) as Capability[]) {
    for (const role of ROLES) {
      it(`${role} ${can(role, cap) ? "CAN" : "cannot"} ${cap}`, async () => {
        await reset();
        expect(await attempt[cap](users[role])).toBe(can(role, cap));
        await reset();
      });
    }
    it(`someone from another shop cannot ${cap}, and neither can an anonymous caller`, async () => {
      await reset();
      expect(await attempt[cap](outsider)).toBe(false);
      await reset();
      expect(await attempt[cap](null)).toBe(false);
      await reset();
    });
  }
});

describe("security verification script (supabase/tests/rls_verify.sql)", () => {
  it("returns ZERO rows against the real migrations", async () => {
    const sql = fs.readFileSync(path.resolve(__dirname, "../../supabase/tests/rls_verify.sql"), "utf8");
    const rows = (await q<{ problem: string; detail: string }>(sql)).rows as unknown as Record<string, string>[];
    const found = rows.map((r) => Object.values(r).join(" · "));
    expect(found).toEqual([]);
  });

  it("actually detects problems (the checks are not vacuous)", async () => {
    const sql = fs.readFileSync(path.resolve(__dirname, "../../supabase/tests/rls_verify.sql"), "utf8");
    const run = async () => (await q(sql)).rows.map((r) => Object.values(r as Record<string, string>).join(" · "));
    // each deliberate hole must show up, then be repaired
    await db.exec("alter table public.categories disable row level security");
    expect(await run()).toContain("RLS_DISABLED · categories");
    await db.exec("alter table public.categories enable row level security");

    await db.exec("grant select on public.categories to anon");
    expect((await run()).some((r) => r.startsWith("ANON_TABLE_PRIVILEGE"))).toBe(true);
    await db.exec("revoke select on public.categories from anon");

    await db.exec("create function public.leaky() returns int language sql as $$ select 1 $$; grant execute on function public.leaky() to public");
    expect(await run()).toContain("ANON_CAN_EXECUTE · leaky");
    await db.exec("drop function public.leaky()");

    await db.exec("create policy sneaky on public.categories for select using (true)");
    expect((await run()).some((r) => r.startsWith("POLICY_ALWAYS_TRUE"))).toBe(true);
    await db.exec("drop policy sneaky on public.categories");

    await db.exec("create function public.definer_no_path() returns int language sql security definer as $$ select 1 $$; revoke execute on function public.definer_no_path() from public, anon, authenticated");
    expect(await run()).toContain("DEFINER_WITHOUT_SEARCH_PATH · definer_no_path");
    await db.exec("drop function public.definer_no_path()");

    await db.exec("grant update on public.audit_logs to authenticated");
    expect((await run()).some((r) => r.startsWith("CLIENT_CAN_WRITE_PROTECTED_TABLE · audit_logs"))).toBe(true);
    await db.exec("revoke update on public.audit_logs from authenticated");
    expect(await run()).toEqual([]);
  });
});

describe("cross-shop isolation (every shop-owned table)", () => {
  it("another shop's member sees no rows from any table that holds shop data", async () => {
    const tables = (await q<{ t: string }>("select c.relname t from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by 1")).rows.map((r) => r.t);
    const leaks: string[] = [];
    for (const t of tables) {
      if (t === "shops" || t === "user_profiles") continue; // checked separately (own shop / co-members)
      // Tables only SECURITY DEFINER functions touch (e.g. idempotency_records) grant signed-in users nothing at all.
      if (!(await q<{ ok: boolean }>("select has_table_privilege('authenticated', $1, 'select') ok", [`public.${t}`])).rows[0].ok) continue;
      const n =await asUser(db, outsider, async () => (await q<{ n: number }>(`select count(*)::int n from public.${t}`)).rows[0].n);
      const total = (await q<{ n: number }>(`select count(*)::int n from public.${t}`)).rows[0].n;
      // the outsider owns shop B, which has its own (small) data in a few tables; anything beyond that would be shop A's
      const scoped = await hasShopColumn(t);
      const own = scoped ? (await q<{ n: number }>(`select count(*)::int n from public.${t} x where x.shop_id = $1`, [shopB])).rows[0].n : 0;
      if (n > own) leaks.push(`${t}: sees ${n}, owns ${own} (of ${total})`);
    }
    expect(leaks).toEqual([]);
  });
  it("shops and profiles are visible only to their own members", async () => {
    await asUser(db, outsider, async () => {
      expect((await q<{ id: string }>("select id from shops")).rows.map((r) => r.id)).toEqual([shopB]);
      expect((await q("select * from user_profiles where id=$1", [users.owner])).rows).toHaveLength(0);
    });
  });
});

async function hasShopColumn(table: string) {
  return (await q("select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name='shop_id'", [table])).rows.length > 0;
}
