// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates/business";
import { addUser, asUser, createDb } from "./db-harness";

/**
 * A second stock sheet on the same day: a stock manager asks, the owner approves, ONLY that manager can use it, it replaces the day's
 * figures (nothing deleted) and the sales are recalculated. Against the real migrations.
 *
 * Oil, Rs. 10 a bottle. Yesterday's count 100, today's count 70 -> 30 sold yesterday (Rs. 300.00).
 */
let db: PGlite;
let owner: string, managerA: string, managerB: string, viewer: string, outsider: string;
let shop: string, otherShop: string;
let T: string, Y: string;
let oil: string, rice: string, foreign: string;
let todaySession: string, yesterdaySession: string;

const q = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<R>(sql, params);
const hoursAgo = (h: number) => `now() - interval '${h} hours'`;
const fails = (p: Promise<unknown>, code: RegExp | string) => expect(p).rejects.toThrow(code);

async function countDay(date: string, h: number, entries: [string, number][]) {
  const lines = JSON.stringify(entries.map(([variant_id, n]) => ({ variant_id, normalized_base_quantity: n })));
  const r = await asUser(db, owner, async () => (await q<{ r: { session_id: string; revision: number } }>("select save_count_draft($1,$2::date,$3::jsonb,null) r", [shop, date, lines])).rows[0].r);
  await q(`update stock_count_sessions set counted_at = ${hoursAgo(h)} where id=$1`, [r.session_id]);
  await asUser(db, owner, () => q("select confirm_count($1,$2,true)", [r.session_id, r.revision]));
  return r.session_id;
}
const request = (as: string, session: string, reason: string | null) =>
  asUser(db, as, async () => (await q<{ r: { id: string; status: string } }>("select request_recount($1,$2) r", [session, reason])).rows[0].r);
const decide = (as: string, id: string, approve: boolean, note: string | null = null) =>
  asUser(db, as, async () => (await q<{ r: { status: string } }>("select decide_recount($1,$2,$3) r", [id, approve, note])).rows[0].r);
const cancel = (as: string, id: string) => asUser(db, as, () => q("select cancel_recount($1)", [id]));
const lines = (...l: [string, number][]) => JSON.stringify(l.map(([variant_id, n]) => ({ variant_id, normalized_base_quantity: n, entry_details: { entries: [{ unit_id: null, quantity: String(n) }] } })));
const submit = (as: string, id: string, ls: string, key: string) =>
  asUser(db, as, async () => (await q<{ r: { duplicate: boolean; changed: number } }>("select submit_recount($1,$2::jsonb,$3) r", [id, ls, key])).rows[0].r);
const day = async (variant = oil, date = Y) => (await q<{ units: string | null; amount: string | null; status: string }>(
  "select inferred_base_units_sold::text units, estimated_sales_amount::text amount, calculation_status::text status from daily_sales where shop_id=$1 and variant_id=$2 and sales_date=$3::date", [shop, variant, date])).rows[0];
const sessionStatus = async () => (await q<{ status: string; revision: number }>("select status::text, revision from stock_count_sessions where id=$1", [todaySession])).rows[0];
const line = async (variant = oil) => (await q<{ qty: string }>("select normalized_base_quantity::text qty from stock_count_lines where session_id=$1 and variant_id=$2", [todaySession, variant])).rows[0]?.qty;
const reqRow = async (id: string) => (await q<{ status: string; changed_lines: number | null; submit_key: string | null }>("select status, changed_lines, submit_key from recount_requests where id=$1", [id])).rows[0];

beforeAll(async () => {
  db = await createDb();
  [owner, managerA, managerB, viewer, outsider] = await Promise.all(["o", "a", "b", "v", "x"].map((n) => addUser(db, `${n}@shop.lk`)));
  shop = await asUser(db, owner, async () => (await q<{ s: string }>("select create_shop('Perera Stores') s")).rows[0].s);
  otherShop = await asUser(db, outsider, async () => (await q<{ s: string }>("select create_shop('Other') s")).rows[0].s);
  await q("insert into shop_memberships (shop_id,user_id,role) values ($1,$2,'stock_manager'), ($1,$3,'stock_manager'), ($1,$4,'viewer')", [shop, managerA, managerB, viewer]);
  const t = (await q<{ t: string }>("select (now() at time zone 'Asia/Colombo')::date::text t")).rows[0].t;
  [T, Y] = [t, addDays(t, -1)];

  const mk = (shopId: string, user: string, name: string, price: number) => asUser(db, user, async () => {
    const p = (await q<{ id: string }>("insert into products (shop_id,name,product_code) values ($1,$2,$2) returning id", [shopId, name])).rows[0].id;
    const v = (await q<{ id: string }>("insert into product_variants (product_id,shop_id,sku,base_inventory_unit) values ($1,$2,$3,'bottle') returning id", [p, shopId, `${name}-1`])).rows[0].id;
    await q("select set_variant_price($1,'selling',$2,now() - interval '100 days')", [v, price]);
    return v;
  });
  oil = await mk(shop, owner, "Oil", 10);
  rice = await mk(shop, owner, "Rice", 20);
  foreign = await mk(otherShop, outsider, "Foreign", 5);

  yesterdaySession = await countDay(Y, 24, [[oil, 100], [rice, 50]]);
  todaySession = await countDay(T, 1, [[oil, 70], [rice, 40]]);
}, 120_000);
afterAll(() => db.close());

describe("the normal rule: one stock sheet per day", () => {
  it("yesterday's sales come from yesterday's and today's counts: 30 sold, Rs. 300.00", async () => {
    expect(await day()).toMatchObject({ units: "30.000", amount: "300.00", status: "calculated" });
  });

  it("today is confirmed and final: a second ordinary save is refused", async () => {
    await fails(asUser(db, managerA, () => q("select save_count_draft($1,$2::date,$3::jsonb,null)", [shop, T, JSON.stringify([{ variant_id: oil, normalized_base_quantity: 10 }])])), /./);
    expect(await line()).toBe("70.000");
  });
});

describe("asking for another stock sheet", () => {
  it("needs a reason", async () => {
    await fails(request(managerA, todaySession, null), /REASON_REQUIRED/);
    await fails(request(managerA, todaySession, "   "), /REASON_REQUIRED/);
  });

  it("is for stock managers and the owner only: a viewer and a stranger are refused", async () => {
    await fails(request(viewer, todaySession, "I want to"), /FORBIDDEN/);
    await fails(request(outsider, todaySession, "I want to"), /FORBIDDEN/);
  });

  it("only works on today's sheet: an older day goes through ordinary corrections", async () => {
    await fails(request(managerA, yesterdaySession, "Wrong count yesterday"), /NOT_TODAY/);
  });

  it("an unconfirmed sheet is simply edited, so it cannot be requested", async () => {
    // a different shop whose owner has only SAVED today's sheet (a draft)
    const solo = await addUser(db, "solo@shop.lk");
    const soloShop = await asUser(db, solo, async () => (await q<{ s: string }>("select create_shop('Solo Stores') s")).rows[0].s);
    const v = await asUser(db, solo, async () => {
      const p = (await q<{ id: string }>("insert into products (shop_id,name,product_code) values ($1,'Tea','Tea') returning id", [soloShop])).rows[0].id;
      return (await q<{ id: string }>("insert into product_variants (product_id,shop_id,sku,base_inventory_unit) values ($1,$2,'Tea-1','packet') returning id", [p, soloShop])).rows[0].id;
    });
    const draft = await asUser(db, solo, async () => (await q<{ r: { session_id: string } }>("select save_count_draft($1,$2::date,$3::jsonb,null) r", [soloShop, T, JSON.stringify([{ variant_id: v, normalized_base_quantity: 5 }])])).rows[0].r.session_id);
    await fails(request(solo, draft, "Too early"), /NOT_CONFIRMED/);
  });

  it("a stock manager's request waits for the owner", async () => {
    const r = await request(managerA, todaySession, "Miscounted the oil shelf");
    expect(r.status).toBe("pending");
    expect(await reqRow(r.id)).toMatchObject({ status: "pending" });
    await cancel(managerA, r.id); // leave a clean slate for the next tests
  });

  it("only one open request per person per day", async () => {
    const r = await request(managerA, todaySession, "First");
    await fails(request(managerA, todaySession, "Second"), /ALREADY_OPEN/);
    await cancel(managerA, r.id);
  });

  it("is written to the audit log", async () => {
    const a = (await q<{ action: string }>("select action from audit_logs where shop_id=$1 and entity_type='recount_requests' order by created_at", [shop])).rows.map((x) => x.action);
    expect(a).toContain("request_recount");
    expect(a).toContain("cancel_recount");
  });
});

describe("the owner decides, and only the owner", () => {
  it("a stock manager cannot approve (not even their own request)", async () => {
    const r = await request(managerA, todaySession, "Recount please");
    await fails(decide(managerA, r.id, true), /FORBIDDEN/);
    await fails(decide(managerB, r.id, true), /FORBIDDEN/);
    await fails(decide(viewer, r.id, true), /FORBIDDEN/);
    expect((await reqRow(r.id)).status).toBe("pending");
    await cancel(owner, r.id);
  });

  it("a rejection needs a reason, and a rejected request cannot be used", async () => {
    const r = await request(managerA, todaySession, "Recount please");
    await fails(decide(owner, r.id, false, ""), /NOTE_REQUIRED/);
    expect((await decide(owner, r.id, false, "The count was right")).status).toBe("rejected");
    await fails(submit(managerA, r.id, lines([oil, 60]), "recount-key-rejected"), /NOT_APPROVED/);
    expect(await line()).toBe("70.000");
  });

  it("a request is decided once", async () => {
    const r = await request(managerA, todaySession, "Recount please");
    await decide(owner, r.id, true);
    await fails(decide(owner, r.id, false, "changed my mind"), /NOT_PENDING/);
    await cancel(owner, r.id);
  });

  it("the owner's own request is approved in the same step", async () => {
    const r = await request(owner, todaySession, "I miscounted");
    expect(r.status).toBe("approved");
    await cancel(owner, r.id);
  });
});

describe("withdrawing a request", () => {
  it("the person who asked, or the owner, can withdraw it; nobody else", async () => {
    const r = await request(managerA, todaySession, "Maybe");
    await fails(cancel(managerB, r.id), /FORBIDDEN/);
    await fails(cancel(viewer, r.id), /FORBIDDEN/);
    await cancel(managerA, r.id);
    expect((await reqRow(r.id)).status).toBe("cancelled");
    await fails(cancel(managerA, r.id), /NOT_OPEN/);
  });

  it("a withdrawn request cannot be used", async () => {
    const r = await request(managerA, todaySession, "Maybe");
    await decide(owner, r.id, true);
    await cancel(managerA, r.id);
    await fails(submit(managerA, r.id, lines([oil, 60]), "recount-key-cancelled"), /NOT_APPROVED/);
  });
});

describe("using the approval: only the person who asked", () => {
  let id: string;
  let revisionBefore = 0;
  beforeAll(async () => {
    id = (await request(managerA, todaySession, "Miscounted the oil shelf")).id;
  });

  it("not before it is approved", async () => {
    await fails(submit(managerA, id, lines([oil, 60]), "recount-key-early"), /NOT_APPROVED/);
    await decide(owner, id, true, "Go ahead");
  });

  it("another stock manager cannot use it, and neither can the owner on their behalf", async () => {
    await fails(submit(managerB, id, lines([oil, 60]), "recount-key-other"), /FORBIDDEN/);
    await fails(submit(owner, id, lines([oil, 60]), "recount-key-owner"), /FORBIDDEN/);
    await fails(submit(viewer, id, lines([oil, 60]), "recount-key-viewer"), /FORBIDDEN/);
    await fails(submit(outsider, id, lines([oil, 60]), "recount-key-out"), /FORBIDDEN/);
    expect(await line()).toBe("70.000");
    expect((await reqRow(id)).status).toBe("approved");
  });

  it("refuses a recount that changes nothing, malformed lines, repeated lines and another shop's product", async () => {
    await fails(submit(managerA, id, lines([oil, 70], [rice, 40]), "recount-key-nochange"), /NO_CHANGE/);
    await fails(submit(managerA, id, "[]", "recount-key-empty"), /NO_LINES/);
    await fails(submit(managerA, id, JSON.stringify([{ variant_id: "nope", normalized_base_quantity: 1 }]), "recount-key-bad"), /INVALID_LINE/);
    await fails(submit(managerA, id, JSON.stringify([{ variant_id: oil, normalized_base_quantity: -3 }]), "recount-key-neg"), /INVALID_LINE/);
    await fails(submit(managerA, id, lines([oil, 60], [oil, 61]), "recount-key-dup"), /DUPLICATE_LINE/);
    await fails(submit(managerA, id, lines([foreign, 5]), "recount-key-foreign"), /INVALID_VARIANT/);
    await fails(submit(managerA, id, lines([oil, 60]), "short"), /KEY_REQUIRED/);
    expect(await line()).toBe("70.000"); // every refusal changed nothing
  });

  it("replaces the day's figure: 60 instead of 70, so 40 were sold yesterday (Rs. 400.00), recalculated with history", async () => {
    revisionBefore = (await sessionStatus()).revision;
    const r = await submit(managerA, id, lines([oil, 60]), "recount-key-0001");
    expect(r).toEqual({ duplicate: false, changed: 1 });
    expect(await line()).toBe("60.000");
    expect(await day()).toMatchObject({ units: "40.000", amount: "400.00", status: "recalculated" });
    const rev = (await q<{ estimated_sales_amount: string; superseded_reason: string }>(
      "select r.estimated_sales_amount::text, r.superseded_reason from daily_sales_revisions r join daily_sales d on d.id=r.daily_sales_id where d.shop_id=$1 and d.variant_id=$2 and d.sales_date=$3::date order by r.revision", [shop, oil, Y])).rows;
    expect(rev.at(-1)).toMatchObject({ estimated_sales_amount: "300.00", superseded_reason: "count_recounted" });
  });

  it("leaves products that were not changed alone", async () => {
    expect(await line(rice)).toBe("40.000");
    expect(await day(rice)).toMatchObject({ units: "10.000", amount: "200.00" });
  });

  it("keeps the old figure: nothing is deleted (an approved correction row, who and why)", async () => {
    const c = (await q<{ old_quantity: string; new_quantity: string; status: string; reason: string; created_by: string; decided_by: string; decision_note: string }>(
      "select old_quantity::text, new_quantity::text, status, reason, created_by, decided_by, decision_note from stock_count_corrections where session_id=$1 and variant_id=$2", [todaySession, oil])).rows;
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ old_quantity: "70.000", new_quantity: "60.000", status: "approved", created_by: managerA, decided_by: owner, decision_note: "Go ahead" });
    expect(c[0].reason).toContain("Miscounted the oil shelf");
    const d = (await q<{ d: { corrected: boolean; previous: { quantity: string } } }>("select entry_details d from stock_count_lines where session_id=$1 and variant_id=$2", [todaySession, oil])).rows[0].d;
    expect(d.corrected).toBe(true);
    expect(Number(d.previous.quantity)).toBe(70);
  });

  it("marks the sheet 'corrected' (a new revision) and the request 'used', and records who did it", async () => {
    expect((await sessionStatus()).status).toBe("corrected");
    expect((await sessionStatus()).revision).toBe(revisionBefore + 1);
    expect(await reqRow(id)).toMatchObject({ status: "used", changed_lines: 1, submit_key: "recount-key-0001" });
    const a = (await q<{ user_id: string; after_data: { changed_lines: number; approved_by: string } }>("select user_id, after_data from audit_logs where shop_id=$1 and action='submit_recount'", [shop])).rows;
    expect(a).toHaveLength(1);
    expect(a[0].user_id).toBe(managerA);
    expect(a[0].after_data).toMatchObject({ changed_lines: 1, approved_by: owner });
  });

  it("is retry-safe: the same key again is a duplicate, a different key is refused", async () => {
    expect(await submit(managerA, id, lines([oil, 60]), "recount-key-0001")).toEqual({ duplicate: true, changed: 1 });
    await fails(submit(managerA, id, lines([oil, 55]), "recount-key-0002"), /ALREADY_USED/);
    expect(await line()).toBe("60.000");
  });

  it("another recount the same day needs a NEW request and a new approval", async () => {
    const again = await request(managerA, todaySession, "Still wrong");
    expect(again.status).toBe("pending");
    await fails(submit(managerA, again.id, lines([oil, 55]), "recount-key-0003"), /NOT_APPROVED/);
    await decide(owner, again.id, true);
    expect(await submit(managerA, again.id, lines([oil, 55], [rice, 35]), "recount-key-0003")).toEqual({ duplicate: false, changed: 2 });
    expect(await day()).toMatchObject({ units: "45.000", amount: "450.00" });
    expect(await day(rice)).toMatchObject({ units: "15.000", amount: "300.00" });
  });
});

describe("an approval only lasts for its own day", () => {
  it("cannot be approved or used once the shop's day has moved on", async () => {
    const r = await request(managerB, todaySession, "Late recount");
    await decide(owner, r.id, true);
    // make the shop's own "today" a different calendar day than the sheet's: one of these two zones always differs from Colombo's date
    const zone = (await q<{ z: string }>("select case when (now() at time zone 'Pacific/Kiritimati')::date <> (now() at time zone 'Asia/Colombo')::date then 'Pacific/Kiritimati' else 'Pacific/Pago_Pago' end z")).rows[0].z;
    // (the app locks a shop's time zone once counts exist, so this test steps around that lock for one statement)
    const setZone = (z: string) => db.exec(`set session_replication_role = replica; update shops set timezone='${z}' where id='${shop}'; set session_replication_role = origin;`);
    await setZone(zone);
    try {
      await fails(submit(managerB, r.id, lines([oil, 50]), "recount-key-late-1"), /EXPIRED/);
      await fails(request(managerA, todaySession, "Also late"), /NOT_TODAY/);
    } finally {
      await setZone("Asia/Colombo");
    }
    await cancel(managerB, r.id);
  });
});

describe("who can see the requests (row-level security)", () => {
  let mine: string, theirs: string;
  beforeAll(async () => {
    mine = (await request(managerA, todaySession, "Mine")).id;
    theirs = (await request(managerB, todaySession, "Theirs")).id;
  });

  it("the owner sees every request in the shop", async () => {
    const ids = (await asUser(db, owner, () => q<{ id: string }>("select id from recount_requests where shop_id=$1", [shop]))).rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([mine, theirs]));
  });

  it("a stock manager sees only their own", async () => {
    const a = (await asUser(db, managerA, () => q<{ id: string }>("select id from recount_requests where shop_id=$1", [shop]))).rows.map((r) => r.id);
    expect(a).toContain(mine);
    expect(a).not.toContain(theirs);
    const b = (await asUser(db, managerB, () => q<{ id: string }>("select id from recount_requests where shop_id=$1", [shop]))).rows.map((r) => r.id);
    expect(b).toContain(theirs);
    expect(b).not.toContain(mine);
  });

  it("a viewer and a stranger see none", async () => {
    expect((await asUser(db, viewer, () => q("select * from recount_requests"))).rows).toHaveLength(0);
    expect((await asUser(db, outsider, () => q("select * from recount_requests"))).rows).toHaveLength(0);
  });

  it("clients cannot write the table directly (no approving yourself with an UPDATE)", async () => {
    await fails(asUser(db, managerA, () => q("update recount_requests set status='approved' where id=$1", [mine])), /permission denied/);
    await fails(asUser(db, managerA, () => q("insert into recount_requests (shop_id,session_id,business_date,requested_by,reason,status) values ($1,$2,$3::date,$4,'x','approved')", [shop, todaySession, T, managerA])), /permission denied/);
    await fails(asUser(db, owner, () => q("delete from recount_requests")), /permission denied/);
    expect((await reqRow(mine)).status).toBe("pending");
  });
});

describe("a recount on the owner's own request", () => {
  it("the owner can recount straight away (self-approved, still recorded)", async () => {
    await cancel(owner, (await q<{ id: string }>("select id from recount_requests where requested_by=$1 and status='pending' limit 1", [managerA])).rows[0].id);
    const r = await request(owner, todaySession, "Owner recount");
    expect(r.status).toBe("approved");
    expect(await submit(owner, r.id, lines([oil, 50]), "recount-key-owner-1")).toEqual({ duplicate: false, changed: 1 });
    expect(await day()).toMatchObject({ units: "50.000", amount: "500.00" });
    const a = (await q<{ after_data: { self_approved?: boolean } }>("select after_data from audit_logs where shop_id=$1 and action='approve_recount' and user_id=$2", [shop, owner])).rows;
    expect(a.some((x) => x.after_data.self_approved)).toBe(true);
  });
});
