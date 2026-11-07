// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUser, asUser, createDb } from "./db-harness";

let db: PGlite;
let owner: string, manager: string, viewer: string, outsider: string;
let shop: string, otherShop: string;
let v1: string, v2: string, v3: string, foreignVariant: string;
let today: string, d1: string, d2: string;

const q = <T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(sql, params);
const rejects = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toThrow(re);
const lines = (vs: [string, number][]) => JSON.stringify(vs.map(([variant_id, n]) => ({ variant_id, normalized_base_quantity: n, entry_details: { version: 1 } })));
const save = (u: string, date: string, ls: string, rev: number | null) =>
  asUser(db, u, async () => (await q<{ r: { session_id: string; revision: number; counted: number } }>("select save_count_draft($1,$2::date,$3::jsonb,$4) r", [shop, date, ls, rev])).rows[0].r);
const confirm = (u: string, session: string, rev: number, ack = false) =>
  asUser(db, u, async () => (await q<{ r: Record<string, unknown> }>("select confirm_count($1,$2,$3) r", [session, rev, ack])).rows[0].r);
const stateOf = async (session: string) => (await q<{ status: string; revision: number }>("select status::text, revision from stock_count_sessions where id=$1", [session])).rows[0];

beforeAll(async () => {
  db = await createDb();
  [owner, manager, viewer, outsider] = await Promise.all(["o", "m", "v", "x"].map((n) => addUser(db, `${n}@shop.lk`)));
  shop = await asUser(db, owner, async () => (await q<{ s: string }>("select create_shop('Perera Stores') s")).rows[0].s);
  otherShop = await asUser(db, outsider, async () => (await q<{ s: string }>("select create_shop('Other') s")).rows[0].s);
  await q("insert into shop_memberships (shop_id,user_id,role) values ($1,$2,'stock_manager'),($1,$3,'viewer')", [shop, manager, viewer]);

  const mk = async (shopId: string, user: string, code: string, sku: string) =>
    asUser(db, user, async () => {
      const p = (await q<{ id: string }>("insert into products (shop_id,name,product_code) values ($1,$2,$2) returning id", [shopId, code])).rows[0].id;
      return (await q<{ id: string }>("insert into product_variants (product_id,shop_id,sku) values ($1,$2,$3) returning id", [p, shopId, sku])).rows[0].id;
    });
  v1 = await mk(shop, owner, "A", "A-1"); v2 = await mk(shop, owner, "B", "B-1"); v3 = await mk(shop, owner, "C", "C-1");
  foreignVariant = await mk(otherShop, outsider, "Z", "Z-1");

  const t = (await q<{ t: string; y: string; y2: string }>("select (now() at time zone 'Asia/Colombo')::date::text t, ((now() at time zone 'Asia/Colombo')::date - 1)::text y, ((now() at time zone 'Asia/Colombo')::date - 2)::text y2")).rows[0];
  [today, d1, d2] = [t.t, t.y, t.y2];
}, 60_000);
afterAll(() => db.close());

describe("save_count_draft", () => {
  let session: string;
  it("creates a draft at revision 2 after first save (insert=1, then +1)", async () => {
    const r = await save(manager, d2, lines([[v1, 100], [v2, 0]]), null);
    session = r.session_id;
    expect(r).toMatchObject({ revision: 2, counted: 2 });
    expect(await stateOf(session)).toEqual({ status: "draft", revision: 2 });
  });
  it("keeps an explicit zero as a counted 0 (distinct from not counted)", async () => {
    const r = (await q<{ n: string | null; s: string }>("select normalized_base_quantity::text n, count_status::text s from stock_count_lines where session_id=$1 and variant_id=$2", [session, v2])).rows[0];
    expect(r).toEqual({ n: "0.000", s: "counted" });
  });
  it("resaves with the current revision; clearing a field removes the line (blank = not counted)", async () => {
    const r = await save(owner, d2, lines([[v1, 100]]), 2);
    expect(r.revision).toBe(3);
    expect((await q("select 1 from stock_count_lines where session_id=$1", [session])).rows).toHaveLength(1);
  });
  it("detects stale revisions (two phones editing the same count)", async () => {
    await asUser(db, manager, () => rejects(q("select save_count_draft($1,$2::date,$3::jsonb,$4)", [shop, d2, lines([[v1, 1]]), 2]), /REVISION_CONFLICT/));
    await asUser(db, manager, () => rejects(q("select save_count_draft($1,$2::date,$3::jsonb,null)", [shop, d2, lines([[v1, 1]])]), /REVISION_CONFLICT/));
  });
  it("only owners/stock managers may save; other shops are blocked", async () => {
    await asUser(db, viewer, () => rejects(q("select save_count_draft($1,$2::date,'[]',null)", [shop, d1]), /FORBIDDEN/));
    await asUser(db, outsider, () => rejects(q("select save_count_draft($1,$2::date,'[]',null)", [shop, d1]), /FORBIDDEN/));
  });
  it("rejects variants of another shop, duplicate lines, negative quantities, future dates", async () => {
    await asUser(db, manager, () => rejects(q("select save_count_draft($1,$2::date,$3::jsonb,null)", [shop, d1, lines([[foreignVariant, 5]])]), /INVALID_VARIANT/));
    await asUser(db, manager, () => rejects(q("select save_count_draft($1,$2::date,$3::jsonb,null)", [shop, d1, lines([[v1, 5], [v1, 6]])]), /DUPLICATE_LINE/));
    await asUser(db, manager, () => rejects(q("select save_count_draft($1,$2::date,$3::jsonb,null)", [shop, d1, lines([[v1, -5]])]), /check/));
    await asUser(db, manager, () => rejects(q("select save_count_draft($1,(current_date + 5),'[]',null)", [shop]), /FUTURE_DATE/));
    expect((await q("select 1 from stock_count_sessions where business_date=$1", [d1])).rows).toHaveLength(0); // failed saves leave nothing behind (rollback)
  });
  it("clients cannot write count tables directly", async () => {
    await asUser(db, owner, () => rejects(q("insert into stock_count_sessions (shop_id,business_date,created_by) values ($1,$2,$3)", [shop, today, owner]), /permission denied/));
    await asUser(db, owner, () => rejects(q("update stock_count_lines set normalized_base_quantity=1"), /permission denied/));
  });
});

describe("confirm_count", () => {
  let session: string, rev: number;
  beforeAll(async () => {
    const r = await save(owner, d2, lines([[v1, 100]]), 3); // d2 draft exists at rev 3 -> 4
    session = r.session_id; rev = r.revision;
  });
  it("refuses a stale revision", async () => {
    await rejects(confirm(owner, session, rev - 1), /REVISION_CONFLICT/);
  });
  it("refuses to confirm with uncounted products unless acknowledged", async () => {
    await rejects(confirm(owner, session, rev), /MISSING_COUNTS/);
    expect((await stateOf(session)).status).toBe("draft");
  });
  it("viewers cannot confirm", async () => {
    await rejects(confirm(viewer, session, rev, true), /FORBIDDEN/);
  });
  it("confirms with acknowledgement and records uncounted products as NULL (never zero)", async () => {
    const r = await confirm(manager, session, rev, true);
    expect(r).toMatchObject({ already_confirmed: false, counted: 1, not_counted: 2 });
    const rows = (await q<{ variant_id: string; n: string | null; s: string }>("select variant_id, normalized_base_quantity::text n, count_status::text s from stock_count_lines where session_id=$1 order by s", [session])).rows;
    expect(rows.filter((x) => x.s === "not_counted").map((x) => x.n)).toEqual([null, null]);
    expect(rows.find((x) => x.s === "counted")?.n).toBe("100.000");
    const st = (await q<{ status: string; confirmed_by: string; confirmed_at: Date | null }>("select status::text, confirmed_by, confirmed_at from stock_count_sessions where id=$1", [session])).rows[0];
    expect(st).toMatchObject({ status: "confirmed", confirmed_by: manager });
    expect(st.confirmed_at).not.toBeNull();
  });
  it("is idempotent: a retry succeeds without changing anything or double-auditing", async () => {
    const before = (await q<{ n: number }>("select count(*)::int n from audit_logs where action='confirm_count' and entity_id=$1", [session])).rows[0].n;
    const again = await confirm(manager, session, 1 /* stale on purpose */, true);
    expect(again).toMatchObject({ already_confirmed: true });
    expect((await q<{ n: number }>("select count(*)::int n from audit_logs where action='confirm_count' and entity_id=$1", [session])).rows[0].n).toBe(before);
    expect((await q("select 1 from stock_count_lines where session_id=$1", [session])).rows).toHaveLength(3);
  });
  it("a confirmed count is immutable: no draft saves, no discard", async () => {
    await asUser(db, owner, () => rejects(q("select save_count_draft($1,$2::date,'[]',$3)", [shop, d2, rev + 1]), /ALREADY_CONFIRMED/));
    await asUser(db, owner, () => rejects(q("select discard_count_draft($1,$2)", [session, rev + 1]), /ALREADY_CONFIRMED/));
  });
  it("enforces chronological order: nothing may be counted on or before a confirmed date", async () => {
    await asUser(db, owner, () => rejects(q("select save_count_draft($1,$2::date,$3::jsonb,null)", [shop, addDaysSql(d2, -1), lines([[v1, 5]])]), /COUNT_OUT_OF_ORDER/));
  });
  it("audits the confirmation with who/what", async () => {
    const a = (await q<{ user_id: string; after_data: { counted: number; not_counted: number } }>("select user_id, after_data from audit_logs where action='confirm_count' and entity_id=$1", [session])).rows[0];
    expect(a.user_id).toBe(manager);
    expect(a.after_data).toMatchObject({ counted: 1, not_counted: 2 });
  });
});

describe("next-morning flow, no-count and discard", () => {
  it("cannot confirm a draft with zero counted products", async () => {
    const r = await save(owner, d1, "[]", null);
    await rejects(confirm(owner, r.session_id, r.revision, true), /NO_COUNTS/);
  });
  it("a full count confirms without acknowledgement", async () => {
    const r = await save(owner, d1, lines([[v1, 72], [v2, 10], [v3, 0]]), 2);
    const c = await confirm(owner, r.session_id, r.revision);
    expect(c).toMatchObject({ already_confirmed: false, counted: 3, not_counted: 0 });
    expect((await stateOf(r.session_id)).status).toBe("confirmed");
  });
  it("archived variants/products are not required for completeness", async () => {
    const p = (await q<{ id: string }>("select product_id id from product_variants where id=$1", [v3])).rows[0].id;
    await q("update products set is_active=false where id=$1", [p]);
    const r = await save(owner, today, lines([[v1, 60]]), null);
    await asUser(db, owner, () => rejects(q("select confirm_count($1,$2,false)", [r.session_id, r.revision]), /MISSING_COUNTS/)); // v2 still missing
    await q("update products set is_active=true where id=$1", [p]);
  });
  it("discards a draft (and a repeat is harmless)", async () => {
    const s = (await q<{ id: string; revision: number }>("select id, revision from stock_count_sessions where business_date=$1", [today])).rows[0];
    await asUser(db, owner, async () => { await q("select discard_count_draft($1,$2)", [s.id, s.revision]); await q("select discard_count_draft($1,$2)", [s.id, s.revision]); });
    expect((await q("select 1 from stock_count_sessions where business_date=$1", [today])).rows).toHaveLength(0);
  });
  it("draft saves do not flood the audit log (only status changes are logged)", async () => {
    const n = (await q<{ n: number }>("select count(*)::int n from audit_logs where entity_type='stock_count_sessions' and action='update'")).rows[0].n;
    expect(n).toBeLessThanOrEqual(3); // confirmations only
  });
  it("shop isolation for counts", async () => {
    await asUser(db, outsider, async () => expect((await q("select * from stock_count_sessions where shop_id=$1", [shop])).rows).toHaveLength(0));
    await asUser(db, viewer, async () => expect((await q("select * from stock_count_sessions where shop_id=$1", [shop])).rows.length).toBeGreaterThan(0)); // viewers can read
  });
});

function addDaysSql(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
