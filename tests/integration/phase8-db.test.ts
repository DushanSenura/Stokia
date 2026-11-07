// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, addMonths, monthOf } from "@/lib/dates/business";
import { addUser, asUser, createDb } from "./db-harness";

let db: PGlite;
let owner: string, owner2: string, manager: string, manager2: string, viewer: string, outsider: string, invitee: string;
let shop: string, otherShop: string;
let T: string, d1: string, d2: string, d3: string;
let v1: string, v2: string, v3: string;
const sessions: Record<string, string> = {};

const q = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<R>(sql, params);
const rejects = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toThrow(re);

async function countDay(date: string, h: number, entries: [string, number | null][]) {
  const lines = JSON.stringify(entries.filter(([, n]) => n !== null).map(([variant_id, n]) => ({ variant_id, normalized_base_quantity: n })));
  const r = await asUser(db, owner, async () => (await q<{ r: { session_id: string; revision: number } }>("select save_count_draft($1,$2::date,$3::jsonb,null) r", [shop, date, lines])).rows[0].r);
  await q("update stock_count_sessions set counted_at = now() - ($2 || ' hours')::interval where id=$1", [r.session_id, String(h)]);
  await asUser(db, owner, () => q("select confirm_count($1,$2,true)", [r.session_id, r.revision]));
  sessions[date] = r.session_id;
}
const request = (user: string, date: string, variant: string, qty: number | null, reason: string | null = "Miscounted the shelf", details: object | null = null) =>
  asUser(db, user, async () => (await q<{ r: { id: string; applied: boolean } }>("select request_count_correction($1,$2,$3,$4::jsonb,$5) r", [sessions[date], variant, qty, details ? JSON.stringify(details) : null, reason])).rows[0].r);
const decide = (user: string, id: string, approve: boolean, note: string | null = null) =>
  asUser(db, user, async () => (await q<{ r: { status: string } }>("select decide_count_correction($1,$2,$3) r", [id, approve, note])).rows[0].r);
const sale = async (variant: string, date: string) =>
  (await q<{ units: string | null; amount: string | null; status: string; rev: number }>("select inferred_base_units_sold::text units, estimated_sales_amount::text amount, calculation_status::text status, calculation_revision rev from daily_sales where shop_id=$1 and variant_id=$2 and sales_date=$3", [shop, variant, date])).rows[0];
const line = async (date: string, variant: string) =>
  (await q<{ n: string | null; s: string; d: { corrected?: boolean; previous?: { quantity: number | null } } }>("select normalized_base_quantity::text n, count_status::text s, entry_details d from stock_count_lines where session_id=$1 and variant_id=$2", [sessions[date], variant])).rows[0];
const sessionStatus = async (date: string) => (await q<{ s: string; r: number }>("select status::text s, revision r from stock_count_sessions where id=$1", [sessions[date]])).rows[0];

beforeAll(async () => {
  db = await createDb();
  [owner, owner2, manager, manager2, viewer, outsider, invitee] = await Promise.all(["o", "o2", "m", "m2", "v", "x", "i"].map((n) => addUser(db, `${n}@shop.lk`)));
  shop = await asUser(db, owner, async () => (await q<{ s: string }>("select create_shop('Perera Stores') s")).rows[0].s);
  otherShop = await asUser(db, outsider, async () => (await q<{ s: string }>("select create_shop('Other') s")).rows[0].s);
  await q("insert into shop_memberships (shop_id,user_id,role) values ($1,$2,'stock_manager'),($1,$3,'stock_manager'),($1,$4,'viewer')", [shop, manager, manager2, viewer]);
  await q("insert into shop_memberships (shop_id,user_id,role,status) values ($1,$2,'viewer','invited')", [shop, invitee]);

  const t = (await q<{ t: string }>("select (now() at time zone 'Asia/Colombo')::date::text t")).rows[0].t;
  [T, d1, d2, d3] = [t, addDays(t, -1), addDays(t, -2), addDays(t, -3)];
  const mk = (name: string) => asUser(db, owner, async () => {
    const p = (await q<{ id: string }>("insert into products (shop_id,name,product_code) values ($1,$2,$2) returning id", [shop, name])).rows[0].id;
    const v = (await q<{ id: string }>("insert into product_variants (product_id,shop_id,sku) values ($1,$2,$3) returning id", [p, shop, `${name}-1`])).rows[0].id;
    await q("select set_variant_price($1,'selling',150,now() - interval '100 days')", [v]);
    await q("select set_variant_price($1,'purchase_cost',100,now() - interval '100 days')", [v]);
    return v;
  });
  [v1, v2, v3] = [await mk("A"), await mk("B"), await mk("C")];
  await countDay(d3, 72, [[v1, 100], [v2, 50], [v3, 10]]);
  await countDay(d2, 48, [[v1, 72], [v2, 40], [v3, null]]);   // C not counted on d2
  await countDay(d1, 24, [[v1, 60], [v2, 30], [v3, 8]]);
  await countDay(T, 1, [[v1, 50], [v2, 25], [v3, 6]]);
}, 120_000);
afterAll(() => db.close());

describe("count corrections: request -> approval -> recalculation", () => {
  let pending: string;
  it("a stock manager can only REQUEST: nothing changes until the owner approves", async () => {
    const r = await request(manager, d2, v1, 70);
    pending = r.id;
    expect(r.applied).toBe(false);
    expect((await line(d2, v1)).n).toBe("72.000");
    expect(await sale(v1, d3)).toMatchObject({ units: "28.000", rev: 1 });
    expect((await sessionStatus(d2)).s).toBe("confirmed");
    const c = (await q<{ status: string; old_quantity: string; new_quantity: string; created_by: string; reason: string }>("select status, old_quantity::text, new_quantity::text, created_by, reason from stock_count_corrections where id=$1", [pending])).rows[0];
    expect(c).toEqual({ status: "pending", old_quantity: "72.000", new_quantity: "70.000", created_by: manager, reason: "Miscounted the shelf" });
  });

  it("only one pending request per product per count; reason, quantity and change are validated", async () => {
    await rejects(request(manager2, d2, v1, 69), /ALREADY_PENDING/);
    await rejects(request(manager, d2, v2, 41, ""), /REASON_REQUIRED/);
    await rejects(request(manager, d2, v2, 41, "   "), /REASON_REQUIRED/);
    await rejects(request(manager, d2, v2, -1), /INVALID_QUANTITY/);
    await rejects(request(manager, d2, v2, 40), /NO_CHANGE/);
    await rejects(request(manager, d2, v2, null), /INVALID_QUANTITY/);
  });

  it("viewers and other shops cannot request; managers cannot approve; drafts cannot be 'corrected'", async () => {
    await rejects(request(viewer, d1, v1, 59), /FORBIDDEN/);
    await rejects(request(outsider, d1, v1, 59), /FORBIDDEN/);
    await rejects(decide(manager, pending, true), /FORBIDDEN/);
    await rejects(decide(viewer, pending, true), /FORBIDDEN/);
  });

  it("approval applies the correction, marks the count 'corrected', and recalculates BOTH adjacent days with history", async () => {
    expect(await decide(owner, pending, true, "Checked against the shelf photo")).toMatchObject({ status: "approved" });
    expect((await line(d2, v1)).n).toBe("70.000");
    expect((await sessionStatus(d2)).s).toBe("corrected");
    // d2's count closes d3 (100 - 70) and opens d2 (70 - 60)
    expect(await sale(v1, d3)).toMatchObject({ units: "30.000", amount: "4500.00", status: "recalculated", rev: 2 });
    expect(await sale(v1, d2)).toMatchObject({ units: "10.000", amount: "1500.00", status: "recalculated", rev: 2 });
    expect(await sale(v1, d1)).toMatchObject({ units: "10.000", rev: 1 });   // d1 does not use d2's count: untouched
    const hist = (await q<{ revision: number; units: string; reason: string }>("select r.revision, r.inferred_base_units_sold::text units, r.superseded_reason reason from daily_sales_revisions r join daily_sales d on d.id=r.daily_sales_id where d.variant_id=$1 and d.sales_date=$2", [v1, d3])).rows;
    expect(hist).toEqual([{ revision: 1, units: "28.000", reason: "count_corrected" }]);
  });

  it("the previous value is preserved on the count line, and who/when/why is recorded", async () => {
    const l = await line(d2, v1);
    expect(l.d).toMatchObject({ corrected: true, previous: { quantity: 72 } });
    const c = (await q<{ status: string; decided_by: string; decided_at: Date | null; decision_note: string }>("select status, decided_by, decided_at, decision_note from stock_count_corrections where id=$1", [pending])).rows[0];
    expect(c).toMatchObject({ status: "approved", decided_by: owner, decision_note: "Checked against the shelf photo" });
    expect(c.decided_at).not.toBeNull();
    const audit = (await q<{ action: string; user_id: string }>("select action, user_id from audit_logs where action in ('request_correction','apply_correction') order by created_at")).rows;
    expect(audit.map((a) => a.action)).toEqual(["request_correction", "apply_correction"]);
    expect(audit.map((a) => a.user_id)).toEqual([manager, owner]);
  });

  it("an approved request cannot be decided twice", async () => {
    await rejects(decide(owner, pending, true), /NOT_PENDING/);
    await rejects(decide(owner, pending, false, "late"), /NOT_PENDING/);
  });

  it("the owner's own request is approved and applied in one step (still recorded as a correction)", async () => {
    const r = await request(owner, d1, v2, 28, "Recount in the afternoon");
    expect(r.applied).toBe(true);
    expect((await line(d1, v2)).n).toBe("28.000");
    expect(await sale(v2, d2)).toMatchObject({ units: "12.000" });   // 40 - 28
    expect(await sale(v2, d1)).toMatchObject({ units: "3.000" });    // 28 - 25
    expect((await q<{ n: number }>("select count(*)::int n from stock_count_corrections where status='approved'")).rows[0].n).toBe(2);
  });

  it("rejection needs a note, changes nothing, and keeps the request on record", async () => {
    const r = await request(manager, T, v1, 55);
    await rejects(decide(owner, r.id, false, ""), /NOTE_REQUIRED/);
    expect(await decide(owner, r.id, false, "Photo shows 50")).toMatchObject({ status: "rejected" });
    expect((await line(T, v1)).n).toBe("50.000");
    expect((await q<{ status: string; decision_note: string }>("select status, decision_note from stock_count_corrections where id=$1", [r.id])).rows[0]).toEqual({ status: "rejected", decision_note: "Photo shows 50" });
    await request(manager, T, v1, 55); // a new request is allowed after a rejection
  });

  it("requesters can cancel their own pending request; other managers cannot; owners can", async () => {
    const p = (await q<{ id: string }>("select id from stock_count_corrections where status='pending' and session_id=$1", [sessions[T]])).rows[0].id;
    await asUser(db, manager2, () => rejects(q("select cancel_count_correction($1)", [p]), /FORBIDDEN/));
    await asUser(db, viewer, () => rejects(q("select cancel_count_correction($1)", [p]), /FORBIDDEN/));
    await asUser(db, manager, () => q("select cancel_count_correction($1)", [p]));
    expect((await q<{ status: string }>("select status from stock_count_corrections where id=$1", [p])).rows[0].status).toBe("cancelled");
    await asUser(db, manager, () => rejects(q("select cancel_count_correction($1)", [p]), /NOT_PENDING/));
  });

  it("a product that was NOT counted can be corrected to a real count; its day goes from pending to calculated", async () => {
    expect(await sale(v3, d3)).toMatchObject({ status: "pending" });                 // C was not counted on d2
    const r = await request(owner, d2, v3, 9, "Found the missing count sheet");
    expect(r.applied).toBe(true);
    expect((await line(d2, v3))).toMatchObject({ n: "9.000", s: "counted" });
    expect((await line(d2, v3)).d.previous?.quantity).toBeNull();
    expect(await sale(v3, d3)).toMatchObject({ units: "1.000", status: "calculated" });   // 10 - 9
    expect(await sale(v3, d2)).toMatchObject({ units: "1.000" });                         // 9 - 8
  });

  it("the change is detected if the line moved after the request (stale request)", async () => {
    const r = await request(manager, d3, v2, 51);
    await q("update stock_count_lines set normalized_base_quantity = 52 where session_id=$1 and variant_id=$2", [sessions[d3], v2]);
    await rejects(decide(owner, r.id, true), /STALE_CORRECTION/);
    await decide(owner, r.id, false, "Superseded");
  });

  it("drafts cannot be corrected (they are simply edited), and clients still cannot write count lines directly", async () => {
    const fresh = (await q<{ id: string }>("insert into stock_count_sessions (shop_id,business_date,created_by) values ($1,$2,$3) returning id", [shop, addDays(T, 1), owner])).rows[0].id;
    await asUser(db, owner, () => rejects(q("select request_count_correction($1,$2,5,null,'x')", [fresh, v1]), /NOT_CONFIRMED/));
    await asUser(db, owner, () => rejects(q("update stock_count_lines set normalized_base_quantity=1", []), /permission denied/));
    await asUser(db, owner, () => rejects(q("insert into stock_count_corrections (session_id,variant_id,new_quantity,reason,created_by) values ($1,$2,1,'x',$3)", [sessions[T], v1, owner]), /permission denied/));
    await asUser(db, owner, () => rejects(q("select _apply_correction($1,$2,'x')", [sessions[T], owner]), /permission denied/));
  });

  it("other shops cannot see corrections; members can read them", async () => {
    await asUser(db, outsider, async () => expect((await q("select * from stock_count_corrections")).rows).toHaveLength(0));
    await asUser(db, viewer, async () => expect((await q("select * from stock_count_corrections")).rows.length).toBeGreaterThan(0));
  });

  it("corrections flow into the monthly figures through the same recalculation (cross-month safe)", async () => {
    // the correction of d2 changed daily rows; the report view of that month reflects the corrected quantity
    const month = monthOf(d2);
    const rows = await asUser(db, owner, async () => (await q<{ product_name: string; max_revision: number }>("select product_name, max_revision from monthly_report_variants($1,$2) where product_name='A'", [shop, month])).rows);
    expect(rows[0].max_revision).toBeGreaterThanOrEqual(2);
  });
});

describe("memberships: owners, invitations, suspension", () => {
  const upd = (user: string, sql: string, params: unknown[]) => asUser(db, user, () => q(sql, params));

  it("the last active owner can never be demoted, suspended or removed", async () => {
    await upd(owner, "select 1", []);
    await rejects(upd(owner, "update shop_memberships set role='viewer' where shop_id=$1 and user_id=$2", [shop, owner]), /LAST_OWNER/);
    await rejects(upd(owner, "update shop_memberships set status='suspended' where shop_id=$1 and user_id=$2", [shop, owner]), /LAST_OWNER/);
    await rejects(upd(owner, "delete from shop_memberships where shop_id=$1 and user_id=$2", [shop, owner]), /LAST_OWNER/);
  });
  it("with a second owner, the first may step down", async () => {
    await q("insert into shop_memberships (shop_id,user_id,role) values ($1,$2,'owner')", [shop, owner2]);
    await upd(owner, "update shop_memberships set role='stock_manager' where shop_id=$1 and user_id=$2", [shop, owner]);
    await rejects(upd(owner2, "update shop_memberships set role='viewer' where shop_id=$1 and user_id=$2", [shop, owner2]), /LAST_OWNER/);
    await upd(owner2, "update shop_memberships set role='owner' where shop_id=$1 and user_id=$2", [shop, owner]); // restore
  });
  it("shop and user of a membership are immutable; only owners manage memberships", async () => {
    await rejects(upd(owner, "update shop_memberships set user_id=$2 where shop_id=$1 and user_id=$3", [shop, viewer, manager]), /MEMBERSHIP_IMMUTABLE|duplicate/);
    expect((await upd(manager, "update shop_memberships set role='owner' where user_id=$1 returning id", [manager])).rows).toHaveLength(0);
    await asUser(db, manager, () => rejects(q("insert into shop_memberships (shop_id,user_id,role) values ($1,$2,'viewer')", [shop, outsider]), /row-level security/));
    await asUser(db, viewer, () => rejects(q("delete from shop_memberships where shop_id=$1", [shop]).then(async (r) => { if (r.affectedRows === 0) throw new Error("row-level security (0 rows)"); }), /row-level security/));
  });
  it("an invited user sees nothing until they accept; accepting activates exactly their own invitation", async () => {
    await asUser(db, invitee, async () => expect((await q("select * from products")).rows).toHaveLength(0));
    await asUser(db, outsider, async () => expect((await q<{ n: number }>("select accept_invitation() n")).rows[0].n).toBe(0));
    const n = await asUser(db, invitee, async () => (await q<{ n: number }>("select accept_invitation() n")).rows[0].n);
    expect(n).toBe(1);
    await asUser(db, invitee, async () => expect((await q("select * from products")).rows.length).toBeGreaterThan(0));
    await asUser(db, invitee, async () => expect((await q<{ n: number }>("select accept_invitation() n")).rows[0].n).toBe(0)); // idempotent
    await asUser(db, null, () => rejects(q("select accept_invitation()"), /permission denied/));
  });
  it("a suspended member loses all access immediately (reads and writes)", async () => {
    await upd(owner, "update shop_memberships set status='suspended' where shop_id=$1 and user_id=$2", [shop, manager2]);
    await asUser(db, manager2, async () => expect((await q("select * from products")).rows).toHaveLength(0));
    await asUser(db, manager2, () => rejects(q("select save_count_draft($1,$2::date,'[]',null)", [shop, addDays(T, 1)]), /FORBIDDEN/));
    await asUser(db, manager2, () => rejects(q("select request_count_correction($1,$2,1,null,'x')", [sessions[T], v1]), /FORBIDDEN/));
    await upd(owner, "update shop_memberships set status='active' where shop_id=$1 and user_id=$2", [shop, manager2]);
    await asUser(db, manager2, async () => expect((await q("select * from products")).rows.length).toBeGreaterThan(0));
  });
  it("role and status changes are audited", async () => {
    const a = (await q<{ n: number }>("select count(*)::int n from audit_logs where entity_type='shop_memberships' and action='update'")).rows[0].n;
    expect(a).toBeGreaterThanOrEqual(4);
  });
});

describe("profiles", () => {
  it("users may change their display name and language, but not their email (spoofing teammates) or create profiles", async () => {
    await asUser(db, manager, () => q("update user_profiles set display_name='Kamala', preferred_language='si' where id=$1", [manager]));
    expect((await q<{ d: string; l: string }>("select display_name d, preferred_language l from user_profiles where id=$1", [manager])).rows[0]).toEqual({ d: "Kamala", l: "si" });
    await asUser(db, manager, () => rejects(q("update user_profiles set email='boss@evil.com' where id=$1", [manager]), /permission denied/));
    await asUser(db, manager, () => rejects(q("insert into user_profiles (id,display_name) values (gen_random_uuid(),'x')"), /permission denied/));
    await asUser(db, manager, async () => expect((await q("update user_profiles set display_name='Hacked' where id=$1 returning id", [owner])).rows).toHaveLength(0));
  });
  it("teammates' emails are visible to the shop, not to outsiders", async () => {
    await asUser(db, viewer, async () => expect((await q<{ email: string }>("select email from user_profiles where id=$1", [owner])).rows[0].email).toBe("o@shop.lk"));
    await asUser(db, outsider, async () => expect((await q("select email from user_profiles where id=$1", [owner])).rows).toHaveLength(0));
  });
  it("find_user_by_email is for the server only (service role)", async () => {
    await asUser(db, owner, () => rejects(q("select find_user_by_email('o@shop.lk')"), /permission denied/));
    await asUser(db, null, () => rejects(q("select find_user_by_email('o@shop.lk')"), /permission denied/));
    await db.exec("set role service_role");
    expect((await q<{ id: string }>("select find_user_by_email('O@SHOP.LK') id")).rows[0].id).toBe(owner);
    await db.exec("reset role");
  });
});

describe("shop settings", () => {
  const set = (user: string, sql: string, params: unknown[] = []) => asUser(db, user, () => q(sql, params));
  it("only owners update the shop, and only name / timezone / settings", async () => {
    await set(owner, "update shops set name='Perera & Sons' where id=$1", [shop]);
    expect((await q<{ name: string }>("select name from shops where id=$1", [shop])).rows[0].name).toBe("Perera & Sons");
    expect((await set(manager, "update shops set name='Hijack' where id=$1 returning id", [shop])).rows).toHaveLength(0);
    await rejects(set(owner, "update shops set created_by=$2 where id=$1", [shop, manager]), /permission denied/);
    await rejects(set(owner, "update shops set currency='USD' where id=$1", [shop]), /permission denied/);
    await rejects(set(owner, "update shops set name='A' where id=$1", [shop]), /INVALID_NAME|check/);
  });
  it("settings are validated: only known keys and valid values", async () => {
    await set(owner, `update shops set settings='{"valuation_policy":"latest_cost"}' where id=$1`, [shop]);
    await rejects(set(owner, `update shops set settings='{"valuation_policy":"made_up"}' where id=$1`, [shop]), /INVALID_SETTING/);
    await rejects(set(owner, `update shops set settings='{"evil":true}' where id=$1`, [shop]), /INVALID_SETTING/);
    await set(owner, `update shops set settings='{"valuation_policy":"cost_at_count"}' where id=$1`, [shop]);
  });
  it("the timezone is locked once counts are confirmed (history would be reinterpreted); invalid zones are refused", async () => {
    await rejects(set(owner, "update shops set timezone='Asia/Kolkata' where id=$1", [shop]), /TIMEZONE_LOCKED/);
    await rejects(set(outsider, "update shops set timezone='Mars/Olympus' where id=$1", [otherShop]), /INVALID_TIMEZONE/);
    await set(outsider, "update shops set timezone='Asia/Kolkata' where id=$1", [otherShop]); // no counts yet: allowed
  });
  it("settings changes are audited with before and after", async () => {
    const a = (await q<{ before_data: { name: string }; after_data: { name: string } }>("select before_data, after_data from audit_logs where entity_type='shops' and action='update' order by created_at limit 1")).rows[0];
    expect(a.before_data.name).toBe("Perera Stores");
    expect(a.after_data.name).toBe("Perera & Sons");
  });
});

describe("valuation policy (explicit and selectable)", () => {
  const value = (month?: string) => asUser(db, owner, async () => month
    ? (await q<{ v: string | null; c: string | null }>("select closing_value::text v, closing_cost::text c from monthly_report_variants($1,$2) where product_name='A'", [shop, month])).rows[0]
    : (await q<{ total_cost: string }>("select total_cost::text from stock_valuation($1)", [shop])).rows[0]);
  it("default policy values the latest count at the cost in force when it was counted; 'latest_cost' uses today's cost", async () => {
    // latest count T: v1=50, v2=25, v3=6, all costed 100 => 8100 ; then A's cost rises today
    expect(await value()).toEqual({ total_cost: "8100.00" } as never);
    await asUser(db, owner, () => q("select set_variant_price($1,'purchase_cost',130,now())", [v1]));
    expect(await value()).toEqual({ total_cost: "8100.00" } as never);                                  // cost_at_count: unchanged
    await q(`update shops set settings='{"valuation_policy":"latest_cost"}' where id=$1`, [shop]);
    expect(await value()).toEqual({ total_cost: "9600.00" } as never);                                  // 50*130 + 25*100 + 6*100
    await q(`update shops set settings='{"valuation_policy":"cost_at_count"}' where id=$1`, [shop]);
    expect(await value()).toEqual({ total_cost: "8100.00" } as never);
  });
  it("the monthly report's closing stock value follows the same policy", async () => {
    // a closing count on the 1st of a past month, counted 50 days ago (when A's cost was 100; it is 130 now)
    const closeDate = `${addMonths(monthOf(T), -3)}-01`;
    const prev = addMonths(monthOf(T), -4);
    const sid = (await q<{ id: string }>("insert into stock_count_sessions (shop_id,business_date,status,created_by,counted_at,confirmed_by,confirmed_at) values ($1,$2,'confirmed',$3,now() - interval '50 days',$3,now()) returning id", [shop, closeDate, owner])).rows[0].id;
    await q("insert into stock_count_lines (session_id,variant_id,normalized_base_quantity,count_status) values ($1,$2,10,'counted')", [sid, v1]);
    const atCount = await value(prev);
    expect(atCount).toEqual({ v: "1000.00", c: "100.00" });
    await q(`update shops set settings='{"valuation_policy":"latest_cost"}' where id=$1`, [shop]);
    expect(await value(prev)).toEqual({ v: "1300.00", c: "130.00" });
    await q(`update shops set settings='{"valuation_policy":"cost_at_count"}' where id=$1`, [shop]);
  });
});
