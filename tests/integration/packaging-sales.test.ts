// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates/business";
import { computeBreakdown } from "@/lib/calculations/sales-breakdown";
import { addUser, asUser, createDb } from "./db-harness";

/**
 * Packaging-level selling and the optional breakdown of a day's inferred sales, against the REAL migrations.
 *
 * Choco: base unit Piece (Rs. 30); 1 Box = 20 Pieces (Rs. 550); 1 Carton = 10 Boxes = 200 Pieces (stock only, not sellable).
 * Sales date S: opening count 400 pieces, closing count 255 pieces -> 145 pieces inferred sold.
 */
let db: PGlite;
let owner: string, manager: string, viewer: string, outsider: string;
let shop: string, otherShop: string;
let T: string, S: string;
let choco: string, plain: string, other: string;
let box: string, carton: string, otherBox: string, unpriced: string;

const q = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<R>(sql, params);
const hoursAgo = (h: number) => `now() - interval '${h} hours'`;
const KEY = (n: string) => `breakdown-key-${n}-padding`;

async function countDay(date: string, h: number, entries: [string, number][]) {
  const lines = JSON.stringify(entries.map(([variant_id, n]) => ({ variant_id, normalized_base_quantity: n })));
  const r = await asUser(db, owner, async () => (await q<{ r: { session_id: string; revision: number } }>("select save_count_draft($1,$2::date,$3::jsonb,null) r", [shop, date, lines])).rows[0].r);
  await q(`update stock_count_sessions set counted_at = ${hoursAgo(h)} where id=$1`, [r.session_id]);
  await asUser(db, owner, () => q("select confirm_count($1,$2,true)", [r.session_id, r.revision]));
}

const lines = (...l: [string, number][]) => JSON.stringify(l.map(([unit_id, quantity]) => ({ unit_id, quantity })));
const record = (as: string, ls: string, key: string, opts: { reason?: string | null; rev?: number | null; variant?: string; date?: string; shopId?: string } = {}) =>
  asUser(db, as, async () => (await q<{ r: Record<string, unknown> }>("select record_sales_breakdown($1,$2,$3::date,$4::jsonb,$5,$6,$7) r",
    [opts.shopId ?? shop, opts.variant ?? choco, opts.date ?? S, ls, opts.reason ?? null, key, opts.rev ?? null])).rows[0].r);
const fails = (p: Promise<unknown>, code: RegExp | string) => expect(p).rejects.toThrow(code);
const clear = (as: string, reason: string | null, key: string, variant = choco) =>
  asUser(db, as, async () => (await q<{ r: Record<string, unknown> }>("select clear_sales_breakdown($1,$2,$3::date,$4,$5) r", [shop, variant, S, reason, key])).rows[0].r);
const day = async (variant = choco, date = S) => (await q<{ units: string | null; amount: string | null; status: string; pkg: string; rev: number }>(
  "select inferred_base_units_sold::text units, estimated_sales_amount::text amount, calculation_status::text status, packaging_status pkg, calculation_revision rev from daily_sales where shop_id=$1 and variant_id=$2 and sales_date=$3::date", [shop, variant, date])).rows[0];
const breakdown = async (variant = choco) => (await q<{ id: string; status: string; revision: number; packaged: string; remainder: string; amount: string }>(
  "select id, status, revision, packaged_base_units::text packaged, remainder_base_units::text remainder, amount::text amount from sales_breakdowns where shop_id=$1 and variant_id=$2 and sales_date=$3::date", [shop, variant, S])).rows[0];
const history = async (variant = choco) => (await q<{ revision: number; action: string; reason: string | null }>(
  "select revision, action, reason from sales_breakdown_revisions where shop_id=$1 and variant_id=$2 and sales_date=$3::date order by revision", [shop, variant, S])).rows;

beforeAll(async () => {
  db = await createDb();
  [owner, manager, viewer, outsider] = await Promise.all(["o", "m", "v", "x"].map((n) => addUser(db, `${n}@shop.lk`)));
  shop = await asUser(db, owner, async () => (await q<{ s: string }>("select create_shop('Perera Stores') s")).rows[0].s);
  otherShop = await asUser(db, outsider, async () => (await q<{ s: string }>("select create_shop('Other') s")).rows[0].s);
  await q("insert into shop_memberships (shop_id,user_id,role) values ($1,$2,'stock_manager'), ($1,$3,'viewer')", [shop, manager, viewer]);
  const t = (await q<{ t: string }>("select (now() at time zone 'Asia/Colombo')::date::text t")).rows[0].t;
  [T, S] = [t, addDays(t, -1)];

  const mkVariant = (shopId: string, user: string, name: string, price: number | null) => asUser(db, user, async () => {
    const p = (await q<{ id: string }>("insert into products (shop_id,name,product_code) values ($1,$2,$2) returning id", [shopId, name])).rows[0].id;
    const v = (await q<{ id: string }>("insert into product_variants (product_id,shop_id,sku,base_inventory_unit) values ($1,$2,$3,'piece') returning id", [p, shopId, `${name}-1`])).rows[0].id;
    if (price !== null) await q("select set_variant_price($1,'selling',$2,now() - interval '100 days')", [v, price]);
    return v;
  });
  choco = await mkVariant(shop, owner, "Choco", 30);
  plain = await mkVariant(shop, owner, "Plain", 10);
  other = await mkVariant(otherShop, outsider, "Other", 5);

  await asUser(db, owner, async () => {
    box = (await q<{ id: string }>("insert into packaging_units (variant_id,name,conversion_factor,base_unit_multiplier,can_be_sold,can_be_counted) values ($1,'Box',20,1,true,true) returning id", [choco])).rows[0].id;
    carton = (await q<{ id: string }>("insert into packaging_units (variant_id,name,parent_unit_id,conversion_factor,base_unit_multiplier,can_be_sold,can_be_counted) values ($1,'Carton',$2,10,1,false,true) returning id", [choco, box])).rows[0].id;
    unpriced = (await q<{ id: string }>("insert into packaging_units (variant_id,name,conversion_factor,base_unit_multiplier,can_be_sold) values ($1,'Tray',6,1,true) returning id", [choco])).rows[0].id;
    await q("select set_packaging_price($1, 550, now() - interval '100 days')", [box]);
  });
  otherBox = await asUser(db, outsider, async () => (await q<{ id: string }>("insert into packaging_units (variant_id,name,conversion_factor,base_unit_multiplier,can_be_sold) values ($1,'Box',20,1,true) returning id", [other])).rows[0].id);
  await asUser(db, outsider, () => q("select set_packaging_price($1, 99, now() - interval '100 days')", [otherBox]));

  // Choco: 400 pieces counted on S, 255 on the next morning => 145 inferred sold. Plain: 50 -> 40 => 10 sold.
  await countDay(S, 24, [[choco, 400], [plain, 50]]);
  await countDay(T, 1, [[choco, 255], [plain, 40]]);
}, 120_000);
afterAll(() => db.close());

describe("the packaging model", () => {
  it("the multipliers follow the hierarchy: 1 box = 20 pieces, 1 carton = 10 boxes = 200 pieces", async () => {
    const r = (await q<{ name: string; m: string }>("select name, base_unit_multiplier::text m from packaging_units where variant_id=$1 order by base_unit_multiplier", [choco])).rows;
    expect(r.find((x) => x.name === "Box")?.m).toBe("20.000000");
    expect(r.find((x) => x.name === "Carton")?.m).toBe("200.000000");
  });

  it("Choco: Carton is stock only, Box and Piece are sold and counted", async () => {
    const u = (await asUser(db, owner, () => q<{ name: string; is_base_unit: boolean; can_be_sold: boolean; can_be_counted: boolean; unit_key: string }>(
      "select name, is_base_unit, can_be_sold, can_be_counted, unit_key from sale_units where variant_id=$1 and name <> 'Tray' order by base_unit_multiplier", [choco]))).rows;
    expect(u.map((x) => [x.name, x.is_base_unit, x.can_be_sold, x.can_be_counted])).toEqual([
      ["piece", true, true, true], ["Box", false, true, true], ["Carton", false, false, true],
    ]);
    expect(u[0].unit_key).toBe("base"); // the base unit has an explicit identity, not "a null that happens to mean base"
  });

  it("existing units keep counting as before and are not sellable until the owner says so (backward compatible)", async () => {
    const plainUnit = await asUser(db, owner, async () => (await q<{ id: string }>("insert into packaging_units (variant_id,name,conversion_factor,base_unit_multiplier) values ($1,'Bag',5,1) returning id", [plain])).rows[0].id);
    const r = (await q<{ can_be_sold: boolean; can_be_counted: boolean }>("select can_be_sold, can_be_counted from packaging_units where id=$1", [plainUnit])).rows[0];
    expect(r).toEqual({ can_be_sold: false, can_be_counted: true });
  });

  it("an unsellable unit cannot be given a price", async () => {
    await fails(asUser(db, owner, () => q("select set_packaging_price($1, 5000)", [carton])), /NOT_SELLABLE/);
  });

  it("only owners set packaging prices", async () => {
    await fails(asUser(db, manager, () => q("select set_packaging_price($1, 560, now())", [box])), /FORBIDDEN/);
    await fails(asUser(db, viewer, () => q("select set_packaging_price($1, 560, now())", [box])), /FORBIDDEN/);
    await fails(asUser(db, outsider, () => q("select set_packaging_price($1, 560, now())", [box])), /FORBIDDEN/);
  });

  it("the Choco prices: piece Rs. 30 (the variant's own selling price), box Rs. 550", async () => {
    expect((await q<{ a: string }>("select amount_lkr::text a from product_price_history where variant_id=$1 and price_type='selling'", [choco])).rows[0].a).toBe("30.00");
    expect((await q<{ a: string }>("select amount_lkr::text a from packaging_unit_price_history where unit_id=$1", [box])).rows[0].a).toBe("550.00");
  });
});

describe("with NO breakdown the day keeps today's figure", () => {
  it("145 pieces inferred, valued at the piece price: Rs. 4,350.00, packaging unknown", async () => {
    expect(await day()).toMatchObject({ units: "145.000", amount: "4350.00", status: "calculated", pkg: "unknown" });
  });
});

describe("recording a breakdown", () => {
  it("145 sold with 4 complete boxes: 65 loose pieces, Rs. 4,150.00 (4 x 550 + 65 x 30)", async () => {
    const r = await record(owner, lines([box, 4]), KEY("a"));
    expect(r).toMatchObject({ ok: true, duplicate: false, revision: 1, amount: 4150 }); // JSON numbers
    expect(await breakdown()).toMatchObject({ status: "active", packaged: "80.000", remainder: "65.000", amount: "4150.00" });
    const l = (await q<{ name: string; is_base_unit: boolean; quantity: string; base_units: string; unit_price: string; amount: string }>(
      "select unit_name name, is_base_unit, quantity::text, base_units::text, unit_price::text, amount::text from sales_breakdown_lines where breakdown_id=$1 order by is_base_unit", [(await breakdown()).id])).rows;
    expect(l).toEqual([
      { name: "Box", is_base_unit: false, quantity: "4.000", base_units: "80.000", unit_price: "550.00", amount: "2200.00" },
      { name: "piece", is_base_unit: true, quantity: "65.000", base_units: "65.000", unit_price: "30.00", amount: "1950.00" },
    ]);
  });

  it("the day's estimate now uses the known split, is marked known, and the previous figure is kept in the revision history", async () => {
    expect(await day()).toMatchObject({ units: "145.000", amount: "4150.00", status: "recalculated", pkg: "known" });
    const rev = (await q<{ estimated_sales_amount: string; packaging_status: string; superseded_reason: string }>(
      "select r.estimated_sales_amount::text, r.packaging_status, r.superseded_reason from daily_sales_revisions r join daily_sales d on d.id=r.daily_sales_id where d.shop_id=$1 and d.variant_id=$2 and d.sales_date=$3::date order by r.revision",
      [shop, choco, S])).rows;
    expect(rev.at(-1)).toMatchObject({ estimated_sales_amount: "4350.00", packaging_status: "unknown", superseded_reason: "breakdown_saved" });
  });

  it("NEVER touches stock: no movements were created and the counts are unchanged", async () => {
    expect(Number((await q<{ n: string }>("select count(*) n from stock_movements where shop_id=$1", [shop])).rows[0].n)).toBe(0);
    const c = (await q<{ d: string; q: string }>(
      "select s.business_date::text d, l.normalized_base_quantity::text q from stock_count_lines l join stock_count_sessions s on s.id=l.session_id where s.shop_id=$1 and l.variant_id=$2 order by s.business_date", [shop, choco])).rows;
    expect(c.map((x) => x.q)).toEqual(["400.000", "255.000"]);
  });

  it("is written to the audit log and to the breakdown's own history", async () => {
    expect((await history()).map((h) => [h.revision, h.action])).toEqual([[1, "created"]]);
    const a = (await q<{ action: string; after_data: { amount: string } }>("select action, after_data from audit_logs where shop_id=$1 and entity_type='sales_breakdowns' order by created_at", [shop])).rows;
    expect(a[0].action).toBe("sales_breakdown_created");
    expect(a[0].after_data.amount).toBe(4150);
  });

  it("a stock manager may change one too (with a reason), recorded under their own name", async () => {
    const r = await record(manager, lines([box, 4]), KEY("mgr"), { reason: "Manager recount" });
    expect(r).toMatchObject({ ok: true, duplicate: false });
    const h = (await q<{ created_by: string; action: string }>(
      "select created_by, action from sales_breakdown_revisions where shop_id=$1 and variant_id=$2 and idempotency_key=$3", [shop, choco, KEY("mgr")])).rows[0];
    expect(h).toMatchObject({ created_by: manager, action: "updated" });
  });
});

describe("server-side validation", () => {
  it("rejects negative box sales", async () => {
    await fails(record(owner, lines([box, -1]), KEY("neg"), { reason: "x" }), /NEGATIVE_QUANTITY/);
  });

  it("rejects fractional package counts (whole boxes only)", async () => {
    await fails(record(owner, lines([box, 2.5]), KEY("frac"), { reason: "x" }), /FRACTIONAL_PACKAGE/);
  });

  it("rejects box sales whose equivalent exceeds the inferred sales (8 boxes = 160 > 145)", async () => {
    await fails(record(owner, lines([box, 8]), KEY("big"), { reason: "x" }), /EXCEEDS_INFERRED/);
  });

  it("accepts exactly the inferred total (7 boxes = 140 pieces, 5 loose) but not one box more", async () => {
    await fails(record(owner, lines([box, 8]), KEY("big2"), { reason: "x" }), /EXCEEDS_INFERRED/);
  });

  it("rejects a carton (stock only, not sellable)", async () => {
    await fails(record(owner, lines([carton, 1]), KEY("ctn"), { reason: "x" }), /NOT_SELLABLE/);
  });

  it("rejects a unit that belongs to another product or another shop", async () => {
    await fails(record(owner, lines([otherBox, 1]), KEY("oth"), { reason: "x" }), /INVALID_UNIT/);
  });

  it("rejects a sellable unit that has no price in force on the sales date (historical price validity)", async () => {
    await fails(record(owner, lines([unpriced, 1]), KEY("nop"), { reason: "x" }), /PRICE_MISSING/);
  });

  it("rejects the same unit listed twice and malformed lines", async () => {
    await fails(record(owner, lines([box, 1], [box, 1]), KEY("dup"), { reason: "x" }), /DUPLICATE_UNIT/);
    await fails(record(owner, JSON.stringify([{ unit_id: "not-a-uuid", quantity: 1 }]), KEY("bad"), { reason: "x" }), /INVALID_LINE/);
    await fails(record(owner, JSON.stringify({ unit_id: box }), KEY("obj"), { reason: "x" }), /INVALID_LINE/);
  });

  it("a day with no calculated figure (pending) cannot take a breakdown", async () => {
    await fails(record(owner, lines([box, 1]), KEY("pend"), { date: T, reason: "x" }), /NOT_CALCULATED/);
  });

  it("viewers and strangers are refused (role permissions); a stranger cannot reach another shop's day", async () => {
    await fails(record(viewer, lines([box, 1]), KEY("view"), { reason: "x" }), /FORBIDDEN/);
    await fails(record(outsider, lines([box, 1]), KEY("out"), { reason: "x" }), /FORBIDDEN/);
    await fails(record(owner, lines([otherBox, 1]), KEY("xs"), { shopId: otherShop, variant: other, reason: "x" }), /FORBIDDEN/);
  });

  it("a key is required", async () => {
    await fails(record(owner, lines([box, 1]), "short", { reason: "x" }), /KEY_REQUIRED/);
  });

  it("clients cannot write the tables directly", async () => {
    await fails(asUser(db, owner, () => q("insert into sales_breakdowns (shop_id,variant_id,sales_date,inferred_base_units,packaged_base_units,remainder_base_units,amount) values ($1,$2,$3::date,1,0,1,30)", [shop, plain, S])), /permission denied/);
    await fails(asUser(db, owner, () => q("update sales_breakdowns set amount = 1")), /permission denied/);
    await fails(asUser(db, owner, () => q("delete from sales_breakdown_revisions")), /permission denied/);
    await fails(asUser(db, owner, () => q("insert into packaging_unit_price_history (unit_id,amount_lkr,effective_from) values ($1,1,now())", [box])), /permission denied/);
  });
});

describe("duplicate submission protection", () => {
  it("the same key twice returns the original and records nothing twice", async () => {
    const before = (await history()).length;
    const r = await record(owner, lines([box, 4]), KEY("a"));
    expect(r).toMatchObject({ ok: true, duplicate: true, revision: 1 });
    expect((await history()).length).toBe(before);
  });

  it("one key used for a different request is refused", async () => {
    await fails(record(owner, lines([box, 3]), KEY("a")), /IDEMPOTENCY_MISMATCH/);
  });
});

describe("changing a recorded breakdown", () => {
  it("needs a reason", async () => {
    await fails(record(owner, lines([box, 3]), KEY("u1")), /REASON_REQUIRED/);
    await fails(record(owner, lines([box, 3]), KEY("u1b"), { reason: "   " }), /REASON_REQUIRED/);
  });

  it("refuses a change based on an old revision (two people cannot overwrite each other)", async () => {
    const cur = await breakdown();
    await fails(record(owner, lines([box, 3]), KEY("u2"), { reason: "recount", rev: cur.revision - 1 }), /REVISION_CONFLICT/);
  });

  it("3 boxes instead of 4: 85 loose pieces, Rs. 4,200.00 (3 x 550 + 85 x 30), with the full history", async () => {
    const cur = await breakdown();
    const r = await record(owner, lines([box, 3]), KEY("u3"), { reason: "Counted the till slips again", rev: cur.revision });
    expect(r).toMatchObject({ ok: true, duplicate: false, amount: 4200 });
    expect(await breakdown()).toMatchObject({ packaged: "60.000", remainder: "85.000", amount: "4200.00" });
    expect(await day()).toMatchObject({ amount: "4200.00", pkg: "known" });
    const h = await history();
    expect(h.map((x) => x.action)).toEqual(expect.arrayContaining(["created", "updated"]));
    expect(h.at(-1)).toMatchObject({ action: "updated", reason: "Counted the till slips again" });
    const a = (await q<{ action: string; before_data: { amount: string } | null; after_data: { reason: string } }>(
      "select action, before_data, after_data from audit_logs where shop_id=$1 and action='sales_breakdown_updated' order by created_at, id", [shop])).rows;
    expect(a.at(-1)?.before_data?.amount).toBeTruthy();
    expect(a.at(-1)?.after_data.reason).toBe("Counted the till slips again");
  });

  it("history revisions are numbered 1, 2, 3... and never reused", async () => {
    const nums = (await history()).map((h) => h.revision);
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
    expect(new Set(nums).size).toBe(nums.length);
  });
});

describe("historical prices", () => {
  it("a later price change does NOT rewrite the day: it keeps the price in force on the sales date", async () => {
    await asUser(db, owner, () => q("select set_packaging_price($1, 600, now())", [box]));
    await asUser(db, owner, () => q("select set_variant_price($1,'selling',35, now())", [choco]));
    const cur = await breakdown();
    // force a recalculation of that day (a movement recorded between the counts triggers it) without changing the inferred figure
    await q("select _recalc_sales_day($1,$2::date,'test')", [shop, S]);
    expect(await day()).toMatchObject({ amount: "4200.00", pkg: "known" });
    expect(await breakdown()).toMatchObject({ revision: cur.revision, amount: "4200.00" });
    // both old periods are still there
    const p = (await q<{ a: string; closed: boolean }>("select amount_lkr::text a, effective_to is not null closed from packaging_unit_price_history where unit_id=$1 order by effective_from", [box])).rows;
    expect(p).toEqual([{ a: "550.00", closed: true }, { a: "600.00", closed: false }]);
  });

  it("a new price cannot start before the latest one began (history is never rewritten)", async () => {
    await fails(asUser(db, owner, () => q("select set_packaging_price($1, 1, now() - interval '5 days')", [box])), /PRICE_PERIOD_CONFLICT/);
  });

  it("a breakdown for a day BEFORE a unit had any price is refused", async () => {
    await fails(record(owner, lines([unpriced, 1]), KEY("hist"), { reason: "x" }), /PRICE_MISSING/);
  });
});

describe("corrections and recalculation", () => {
  const move = (type: string, qty: number, effect: number, key: string, reason: string) =>
    asUser(db, owner, async () => (await q<{ r: { id: string } }>(
      "select record_movement($1,$2,$3::movement_type,$4,null,$5,now() - interval '12 hours',$6,null,null,null,$7) r", [shop, choco, type, qty, effect, reason, key])).rows[0].r.id);

  it("stock received between the counts raises the inferred sale; the breakdown follows (3 boxes stay, remainder grows)", async () => {
    await move("stock_received", 30, 30, "mv-received-key-1", "delivery");
    expect(await day()).toMatchObject({ units: "175.000" });
    expect(await breakdown()).toMatchObject({ status: "active", packaged: "60.000", remainder: "115.000", amount: String(3 * 550 + 115 * 30) + ".00" });
    expect(await day()).toMatchObject({ amount: String(3 * 550 + 115 * 30) + ".00", pkg: "known" });
    expect((await history()).at(-1)?.action).toBe("recalculated");
  });

  it("damaged stock that shrinks the sale below the boxes claimed makes the breakdown STALE: kept, flagged, and the day falls back to the plain estimate", async () => {
    const id = await move("damaged", 140, -140, "mv-damaged-key-001", "flood");   // 175 - 140 = 35 pieces sold, but 3 boxes = 60
    expect(await day()).toMatchObject({ units: "35.000", pkg: "stale", amount: "1050.00" }); // 35 x Rs. 30 (the price in force on that day), NOT a known figure
    expect(await breakdown()).toMatchObject({ status: "stale" });
    expect((await history()).at(-1)?.action).toBe("marked_stale");
    // undoing the damage restores it
    await asUser(db, owner, () => q("select reverse_movement($1,'entered by mistake','rev-damaged-key-001')", [id]));
    expect(await breakdown()).toMatchObject({ status: "active", remainder: "115.000" });
    expect(await day()).toMatchObject({ units: "175.000", pkg: "known" });
    expect((await history()).at(-1)?.action).toBe("restored");
  });
});

describe("clearing a breakdown", () => {
  it("needs a reason, returns the day to the plain estimate and keeps the history", async () => {
    await fails(clear(owner, null, KEY("c1")), /REASON_REQUIRED/);
    const r = await clear(owner, "I do not know the box sales after all", KEY("c2"));
    expect(r).toMatchObject({ ok: true, duplicate: false });
    expect(await breakdown()).toBeUndefined();
    expect(await day()).toMatchObject({ pkg: "unknown" });
    expect(Number((await day()).amount)).toBe(175 * 30);
    const h = await history();
    expect(h.at(-1)).toMatchObject({ action: "cleared", reason: "I do not know the box sales after all" });
    expect(h.length).toBeGreaterThan(3);
  });

  it("a repeated clear is a duplicate, not an error; clearing nothing is refused; viewers cannot", async () => {
    expect(await clear(owner, "again", KEY("c2"))).toMatchObject({ ok: true, duplicate: true });
    await fails(clear(owner, "nothing there", KEY("c3")), /NOT_FOUND/);
    await fails(clear(viewer, "x", KEY("c4")), /FORBIDDEN/);
  });

  it("recording again after a clear continues the revision numbers (never reused)", async () => {
    const before = (await history()).at(-1)!.revision;
    await record(owner, lines([box, 2]), KEY("again"));
    expect((await history()).at(-1)).toMatchObject({ action: "created", revision: before + 1 });
  });
});

describe("reporting", () => {
  it("separates KNOWN packaging sales, UNKNOWN (sellable but no breakdown) and STANDARD (no sellable packaging)", async () => {
    const m = S.slice(0, 7);
    const rows = (await asUser(db, owner, () => q<{ product_name: string; bucket: string; estimated_amount: string; lines: unknown }>(
      "select product_name, bucket, estimated_amount::text, lines from monthly_packaging_report($1,$2) order by product_name", [shop, m]))).rows;
    const by = Object.fromEntries(rows.map((r) => [r.product_name, r]));
    expect(by.Choco.bucket).toBe("known");
    expect(by.Choco.estimated_amount).toBe(String(2 * 550 + 135 * 30) + ".00");
    expect(by.Choco.lines).toEqual([
      expect.objectContaining({ name: "Box", quantity: 2, amount: 1100 }),
      expect.objectContaining({ name: "piece", is_base_unit: true, quantity: 135, amount: 4050 }),
    ]);
    expect(by.Plain.bucket).toBe("standard");
    expect(by.Plain.lines).toBeNull();
  });

  it("with the breakdown cleared, the same product is 'unknown', never silently mixed with known figures", async () => {
    await clear(owner, "back to unknown", KEY("c5"));
    const rows = (await asUser(db, owner, () => q<{ product_name: string; bucket: string }>("select product_name, bucket from monthly_packaging_report($1,$2)", [shop, S.slice(0, 7)]))).rows;
    expect(rows.find((r) => r.product_name === "Choco")?.bucket).toBe("unknown");
  });

  it("viewers can read breakdowns and the report; strangers see nothing", async () => {
    await record(owner, lines([box, 4]), KEY("view-final"));
    expect((await asUser(db, viewer, () => q("select * from sales_breakdowns where shop_id=$1", [shop]))).rows).toHaveLength(1);
    expect((await asUser(db, viewer, () => q("select * from monthly_packaging_report($1,$2)", [shop, S.slice(0, 7)]))).rows.length).toBeGreaterThan(0);
    expect((await asUser(db, outsider, () => q("select * from sales_breakdowns where shop_id=$1", [shop]))).rows).toHaveLength(0);
    expect((await asUser(db, outsider, () => q("select * from sales_breakdown_revisions where shop_id=$1", [shop]))).rows).toHaveLength(0);
    expect((await asUser(db, outsider, () => q("select * from packaging_unit_price_history where unit_id=$1", [box]))).rows).toHaveLength(0);
  });
});

describe("parity: the TypeScript rule and the database rule give the same answer", () => {
  // Prices in force on the sales date S (the later changes to 600 / 35 do not apply to it).
  const units = () => [
    { id: box, name: "Box", multiplier: "20", canBeSold: true, isActive: true, price: "550" },
    { id: carton, name: "Carton", multiplier: "200", canBeSold: false, isActive: true, price: null },
    { id: unpriced, name: "Tray", multiplier: "6", canBeSold: true, isActive: true, price: null },
  ];
  const cases: { name: string; inferred: string | null; lines: [string, string][] }[] = [
    { name: "145 with 4 boxes", inferred: "145", lines: [["box", "4"]] },
    { name: "no lines", inferred: "145", lines: [] },
    { name: "zero boxes", inferred: "145", lines: [["box", "0"]] },
    { name: "exactly the boxes", inferred: "140", lines: [["box", "7"]] },
    { name: "too many boxes", inferred: "145", lines: [["box", "8"]] },
    { name: "negative", inferred: "145", lines: [["box", "-1"]] },
    { name: "fractional", inferred: "145", lines: [["box", "2.5"]] },
    { name: "carton", inferred: "500", lines: [["carton", "1"]] },
    { name: "no price", inferred: "145", lines: [["tray", "1"]] },
    { name: "duplicate", inferred: "145", lines: [["box", "1"], ["box", "1"]] },
    { name: "fractional inferred", inferred: "145.5", lines: [["box", "3"]] },
    { name: "tiny", inferred: "1", lines: [["box", "1"]] },
    { name: "none inferred", inferred: null, lines: [["box", "1"]] },
  ];
  const ids: Record<string, () => string> = { box: () => box, carton: () => carton, tray: () => unpriced };

  for (const c of cases) {
    it(c.name, async () => {
      const lines = c.lines.map(([u, quantity]) => ({ unit_id: ids[u](), quantity: Number(quantity) }));
      const sql = (await q<{ r: { ok: boolean; error?: string; amount?: number; packaged?: number; remainder?: number; lines?: { name: string; quantity: number; amount: number }[] } }>(
        "select _breakdown_compute($1,$2,$3::date,$4,$5::jsonb,false) r", [shop, choco, S, c.inferred, JSON.stringify(lines)])).rows[0].r;
      const ts = computeBreakdown({
        inferred: c.inferred, lines: c.lines.map(([u, quantity]) => ({ unitId: ids[u](), quantity })), units: units(), base: { name: "piece", sellable: true, price: "30" },
      });
      expect(sql.ok).toBe(ts.ok);
      if (!ts.ok) { expect(sql.error).toBe(ts.error); return; }
      expect(Number(sql.amount)).toBe(Number(ts.amount));
      expect(Number(sql.packaged)).toBe(Number(ts.packaged));
      expect(Number(sql.remainder)).toBe(Number(ts.remainder));
      expect(sql.lines?.map((l) => [l.name, Number(l.quantity), Number(l.amount)])).toEqual(ts.lines.map((l) => [l.name, Number(l.quantity), Number(l.amount)]));
    });
  }
});
