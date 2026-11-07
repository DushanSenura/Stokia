// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates/business";
import { addUser, asUser, createDb } from "./db-harness";

/** Phase 11: submit_count — one atomic, idempotent, conflict-aware call for offline and multi-device use. */
let db: PGlite;
let owner: string, manager: string, viewer: string, outsider: string;
let shop: string, otherShop: string;
let T: string;
let v1: string, v2: string, other1: string;

const q = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<R>(sql, params);
const day = (n: number) => addDays(T, -n);

interface Server { session_id: string; revision: number; status: string; by: string | null; lines: { variant_id: string; quantity: string }[] }
interface Res {
  status: "confirmed" | "saved" | "conflict"; replayed?: boolean; reason?: "revision" | "already_confirmed";
  session_id?: string; revision?: number; counted?: number; not_counted?: number; server?: Server | null;
}
interface Opts { confirm?: boolean; ack?: boolean; device?: string | null }

const submit = (user: string, s: string, date: string, entries: [string, number][], base: number | null, key: string, o: Opts = {}) =>
  asUser(db, user, async () => {
    const lines = JSON.stringify(entries.map(([variant_id, n]) => ({ variant_id, normalized_base_quantity: n })));
    const r = await q<{ r: Res }>("select submit_count($1,$2::date,$3::jsonb,$4::integer,$5,$6::boolean,$7::boolean,$8) r",
      [s, date, lines, base, key, o.confirm ?? true, o.ack ?? true, o.device ?? null]);
    return r.rows[0].r;
  });
const count = async (sql: string, params: unknown[] = []) => Number((await q<{ n: string }>(sql, params)).rows[0].n);
const sessionOf = async (s: string, date: string) =>
  (await q<{ id: string; status: string; revision: number }>("select id,status::text status,revision from stock_count_sessions where shop_id=$1 and business_date=$2", [s, date])).rows[0];

beforeAll(async () => {
  db = await createDb();
  [owner, manager, viewer, outsider] = await Promise.all(["o", "m", "v", "x"].map((n) => addUser(db, `${n}@sync.lk`)));
  shop = await asUser(db, owner, async () => (await q<{ s: string }>("select create_shop('Sync Stores') s")).rows[0].s);
  otherShop = await asUser(db, outsider, async () => (await q<{ s: string }>("select create_shop('Other') s")).rows[0].s);
  await q("insert into shop_memberships (shop_id,user_id,role) values ($1,$2,'stock_manager'),($1,$3,'viewer')", [shop, manager, viewer]);
  T = (await q<{ t: string }>("select (now() at time zone 'Asia/Colombo')::date::text t")).rows[0].t;
  const mk = (s: string, user: string, name: string) => asUser(db, user, async () => {
    const p = (await q<{ id: string }>("insert into products (shop_id,name,product_code) values ($1,$2,$2) returning id", [s, name])).rows[0].id;
    const v = (await q<{ id: string }>("insert into product_variants (product_id,shop_id,sku) values ($1,$2,$3) returning id", [p, s, `${name}-1`])).rows[0].id;
    await q("select set_variant_price($1,'selling',150,now() - interval '100 days')", [v]);
    return v;
  });
  v1 = await mk(shop, owner, "Oil");
  v2 = await mk(shop, owner, "Rice");
  other1 = await mk(otherShop, outsider, "Soap");
});

describe("submit_count: the normal path", () => {
  it("saves and confirms in one call, and the previous day's sales are calculated in the same transaction", async () => {
    const a = await submit(owner, shop, day(9), [[v1, 100], [v2, 50]], null, "key-day9-aaaa");
    expect(a).toMatchObject({ status: "confirmed", replayed: false, counted: 2, not_counted: 0 });
    const b = await submit(owner, shop, day(8), [[v1, 72], [v2, 50]], null, "key-day8-aaaa");
    expect(b.status).toBe("confirmed");
    const sale = (await q<{ u: string }>("select inferred_base_units_sold::float8::text u from daily_sales where shop_id=$1 and variant_id=$2 and sales_date=$3", [shop, v1, day(9)])).rows[0];
    expect(sale.u).toBe("28");
    expect(await sessionOf(shop, day(8))).toMatchObject({ status: "confirmed" });
  });

  it("with confirm=false it only saves a draft, and a draft can be saved again with the returned revision", async () => {
    const a = await submit(owner, shop, day(4), [[v1, 10]], null, "key-draft-1-aaa", { confirm: false });
    expect(a).toMatchObject({ status: "saved", revision: 2 });
    expect((await sessionOf(shop, day(4))).status).toBe("draft");
    const b = await submit(owner, shop, day(4), [[v1, 11], [v2, 5]], a.revision!, "key-draft-2-aaa", { confirm: false });
    expect(b).toMatchObject({ status: "saved", counted: 2, revision: 3 });
  });
});

describe("submit_count: retries are safe (idempotency)", () => {
  let first: Res;
  it("the same key and request returns the original answer and applies nothing twice", async () => {
    first = await submit(owner, shop, day(7), [[v1, 70], [v2, 50]], null, "key-retry-aaaaa");
    const audits = () => count("select count(*) n from audit_logs where shop_id=$1 and action='confirm_count' and entity_id=$2", [shop, first.session_id]);
    expect(await audits()).toBe(1);
    const again = await submit(owner, shop, day(7), [[v1, 70], [v2, 50]], null, "key-retry-aaaaa");
    expect(again).toMatchObject({ status: "confirmed", replayed: true, session_id: first.session_id, revision: first.revision });
    expect(await audits()).toBe(1);
    expect((await sessionOf(shop, day(7))).revision).toBe(first.revision);
  });

  it("a retry still succeeds when the device lost the first answer, even if a different device has since looked at the day", async () => {
    // the replay does not depend on the current state of the session at all
    const again = await submit(owner, shop, day(7), [[v1, 70], [v2, 50]], null, "key-retry-aaaaa");
    expect(again.replayed).toBe(true);
  });

  it("the same key with different numbers is rejected, never silently accepted", async () => {
    await expect(submit(owner, shop, day(7), [[v1, 71], [v2, 50]], null, "key-retry-aaaaa")).rejects.toThrow(/IDEMPOTENCY_KEY_REUSED/);
    const s = await q<{ n: string }>("select normalized_base_quantity::float8::text n from stock_count_lines where session_id=$1 and variant_id=$2", [first.session_id, v1]);
    expect(s.rows[0].n).toBe("70");
  });

  it("keys are per shop: the same key text in another shop is a different request", async () => {
    const r = await submit(outsider, otherShop, day(9), [[other1, 10]], null, "key-retry-aaaaa");
    expect(r).toMatchObject({ status: "confirmed", replayed: false });
  });

  it("a failed confirm leaves nothing behind (no half-saved draft), and the retry with the missing items acknowledged works", async () => {
    await expect(submit(owner, shop, day(6), [[v1, 60]], null, "key-atomic-aaaa", { ack: false })).rejects.toThrow(/MISSING_COUNTS/);
    expect(await sessionOf(shop, day(6))).toBeUndefined();
    const ok = await submit(owner, shop, day(6), [[v1, 60]], null, "key-atomic-bbbb", { ack: true });
    expect(ok).toMatchObject({ status: "confirmed", counted: 1, not_counted: 1 });
  });
});

describe("submit_count: conflicts never overwrite", () => {
  it("a device that was offline while another confirmed the same morning gets a conflict with the server's copy", async () => {
    // day(7) was confirmed above by the owner with v1=70, v2=50. The manager's offline device now arrives with other numbers.
    const before = await sessionOf(shop, day(7));
    const r = await submit(manager, shop, day(7), [[v1, 65], [v2, 48]], null, "key-offline-mgr-1", { device: "manager phone" });
    expect(r).toMatchObject({ status: "conflict", reason: "already_confirmed" });
    expect(r.server).toMatchObject({ status: "confirmed", revision: before.revision });
    expect(r.server!.lines.map((l) => [l.variant_id, l.quantity]).sort()).toEqual([[v1, "70.000"], [v2, "50.000"]].sort());
    expect(r.server!.by).toBeTruthy();
    // the confirmed count is exactly as it was
    expect(await sessionOf(shop, day(7))).toEqual(before);
    expect(await count("select count(*) n from stock_count_lines where session_id=$1 and normalized_base_quantity in (65,48)", [before.id])).toBe(0);
  });

  it("the conflict is written to the audit log with the device name, and a conflict result is not cached as the key's answer", async () => {
    const a = await q<{ after_data: { reason: string; device: string } }>("select after_data from audit_logs where shop_id=$1 and action='count_sync_conflict' order by created_at desc limit 1", [shop]);
    expect(a.rows[0].after_data).toMatchObject({ reason: "already_confirmed", device: "manager phone" });
    expect(await count("select count(*) n from idempotency_records where shop_id=$1 and key='key-offline-mgr-1'", [shop])).toBe(0);
  });

  it("two devices drafting the same morning: the stale one gets the draft back, and can resolve by resubmitting on top of it", async () => {
    const a = await submit(owner, shop, day(5), [[v1, 55], [v2, 30]], null, "key-dev-a-aaaaa", { confirm: false });
    // device B never saw A's draft (it believes there is no session)
    const stale = await submit(manager, shop, day(5), [[v1, 54], [v2, 31]], null, "key-dev-b-aaaaa");
    expect(stale).toMatchObject({ status: "conflict", reason: "revision" });
    expect(stale.server).toMatchObject({ status: "draft", revision: a.revision });
    expect(stale.server!.lines).toHaveLength(2);
    expect((await sessionOf(shop, day(5))).status).toBe("draft"); // nothing confirmed by the failed attempt
    // explicit resolution: the person chose "use mine" and resubmits against the server's revision with a NEW key
    const resolved = await submit(manager, shop, day(5), [[v1, 54], [v2, 31]], stale.server!.revision, "key-dev-b-bbbbb");
    expect(resolved.status).toBe("confirmed");
    const v = await q<{ n: string }>("select normalized_base_quantity::float8::text n from stock_count_lines l join stock_count_sessions s on s.id=l.session_id where s.shop_id=$1 and s.business_date=$2 and l.variant_id=$3", [shop, day(5), v1]);
    expect(v.rows[0].n).toBe("54");
  });

  it("a draft that was discarded elsewhere is reported as a conflict, not recreated blindly", async () => {
    const a = await submit(owner, shop, day(3), [[v1, 1]], null, "key-disc-aaaaaa", { confirm: false });
    await asUser(db, owner, () => q("select discard_count_draft($1,$2)", [a.session_id, a.revision]));
    const r = await submit(owner, shop, day(3), [[v1, 2]], a.revision!, "key-disc-bbbbbb");
    expect(r).toMatchObject({ status: "conflict", reason: "revision", server: null });
  });

  it("business rules still apply: a count dated before an already confirmed one is refused", async () => {
    await expect(submit(owner, shop, day(30), [[v1, 1]], null, "key-order-aaaaaa")).rejects.toThrow(/COUNT_OUT_OF_ORDER/);
  });
});

describe("submit_count: who may call it", () => {
  it("a viewer and an outsider are refused", async () => {
    await expect(submit(viewer, shop, day(2), [[v1, 1]], null, "key-viewer-aaaaa")).rejects.toThrow(/FORBIDDEN/);
    await expect(submit(outsider, shop, day(2), [[v1, 1]], null, "key-outsid-aaaaa")).rejects.toThrow(/FORBIDDEN/);
  });

  it("a malformed key or payload is refused", async () => {
    await expect(submit(owner, shop, day(2), [[v1, 1]], null, "short")).rejects.toThrow(/INVALID_KEY/);
    await expect(submit(owner, shop, day(2), [[v1, 1]], null, "x".repeat(101))).rejects.toThrow(/INVALID_KEY/);
    await expect(asUser(db, owner, () => q("select submit_count($1,$2::date,'{}'::jsonb,null,'key-payload-aaa')", [shop, day(2)]))).rejects.toThrow(/INVALID_PAYLOAD/);
  });

  it("a line for another shop's product is refused and nothing is saved", async () => {
    await expect(submit(owner, shop, day(2), [[other1, 5]], null, "key-foreign-aaaa")).rejects.toThrow(/INVALID_VARIANT/);
    expect(await sessionOf(shop, day(2))).toBeUndefined();
  });

  it("the idempotency records are not readable or writable by signed-in users", async () => {
    await expect(asUser(db, owner, () => q("select * from idempotency_records"))).rejects.toThrow(/permission denied/i);
    await expect(asUser(db, owner, () => q("delete from idempotency_records"))).rejects.toThrow(/permission denied/i);
    await expect(asUser(db, owner, () => q("select _count_snapshot($1,$2::date)", [shop, day(7)]))).rejects.toThrow(/permission denied/i);
  });
});
