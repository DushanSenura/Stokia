// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUser, asUser, createDb } from "./db-harness";

let db: PGlite;
let owner: string, manager: string, viewer: string, outsider: string;
let shopA: string, shopB: string;
let productA: string, variantA: string;

const q = <T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(sql, params);
const rejects = async (p: Promise<unknown>, re: RegExp) => { await expect(p).rejects.toThrow(re); };

beforeAll(async () => {
  db = await createDb();
  [owner, manager, viewer, outsider] = await Promise.all(["o", "m", "v", "x"].map((n) => addUser(db, `${n}@shop.lk`)));

  shopA = await asUser(db, owner, async () => (await q<{ create_shop: string }>("select create_shop('Perera Stores')")).rows[0].create_shop);
  shopB = await asUser(db, outsider, async () => (await q<{ create_shop: string }>("select create_shop('Other Shop')")).rows[0].create_shop);
  await q("insert into shop_memberships (shop_id,user_id,role) values ($1,$2,'stock_manager'),($1,$3,'viewer')", [shopA, manager, viewer]);

  await asUser(db, owner, async () => {
    productA = (await q<{ id: string }>("insert into products (shop_id,name,product_code) values ($1,'Chilli Powder','CHL') returning id", [shopA])).rows[0].id;
    variantA = (await q<{ id: string }>("insert into product_variants (product_id,shop_id,sku,size_value,size_unit) values ($1,$2,'CHL-250',250,'g') returning id", [productA, shopA])).rows[0].id;
  });
}, 60_000);
afterAll(() => db.close());

describe("tenancy + RLS", () => {
  it("create_shop makes the caller an active owner, once", async () => {
    const m = await q("select role,status from shop_memberships where shop_id=$1 and user_id=$2", [shopA, owner]);
    expect(m.rows[0]).toEqual({ role: "owner", status: "active" });
    await asUser(db, owner, () => rejects(q("select create_shop('Second')"), /ALREADY_MEMBER/));
  });
  it("users only see their own shop's data (shop isolation)", async () => {
    await asUser(db, outsider, async () => {
      expect((await q("select * from products")).rows).toHaveLength(0);
      expect((await q("select * from shops")).rows.map((r) => r.id)).toEqual([shopB]);
      expect((await q("select * from product_variants")).rows).toHaveLength(0);
    });
  });
  it("outsider cannot write into another shop", async () => {
    await asUser(db, outsider, () => rejects(q("insert into products (shop_id,name,product_code) values ($1,'Evil','E')", [shopA]), /row-level security/));
  });
  it("anonymous users get nothing", async () => {
    await asUser(db, null, () => rejects(q("select * from products"), /permission denied/));
  });
  it("viewer and stock manager can read but not edit the catalog", async () => {
    for (const u of [viewer, manager]) {
      await asUser(db, u, async () => {
        expect((await q("select * from products")).rows).toHaveLength(1);
        await rejects(q("insert into products (shop_id,name,product_code) values ($1,'Nope','N')", [shopA]), /row-level security/);
        expect((await q("update products set name='Hacked' where id=$1 returning id", [productA])).rows).toHaveLength(0);
      });
    }
  });
  it("a variant cannot point at another shop's product", async () => {
    await asUser(db, owner, () => rejects(q("insert into product_variants (product_id,shop_id,sku) values ($1,$2,'X-1')", [productA, shopB]), /row-level security/));
  });
  it("only owners can read the audit log, and nobody can write it directly", async () => {
    await asUser(db, owner, async () => expect((await q("select * from audit_logs")).rows.length).toBeGreaterThan(0));
    await asUser(db, manager, async () => expect((await q("select * from audit_logs")).rows).toHaveLength(0));
    await asUser(db, owner, () => rejects(q("insert into audit_logs (shop_id,action,entity_type) values ($1,'x','y')", [shopA]), /permission denied/));
  });
});

describe("catalog constraints", () => {
  it("SKU and product code are unique per shop, case-insensitive", async () => {
    await asUser(db, owner, async () => {
      await rejects(q("insert into product_variants (product_id,shop_id,sku) values ($1,$2,'chl-250')", [productA, shopA]), /variants_shop_sku_uq|duplicate/);
      await rejects(q("insert into products (shop_id,name,product_code) values ($1,'Dup','chl')", [shopA]), /products_shop_code_uq|duplicate/);
    });
  });
  it("same SKU is allowed in a different shop", async () => {
    await asUser(db, outsider, async () => {
      const p = (await q<{ id: string }>("insert into products (shop_id,name,product_code) values ($1,'Chilli','CHL') returning id", [shopB])).rows[0].id;
      await q("insert into product_variants (product_id,shop_id,sku) values ($1,$2,'CHL-250')", [p, shopB]);
    });
  });
  it("rejects zero/negative size and negative threshold", async () => {
    await asUser(db, owner, async () => {
      await rejects(q("insert into product_variants (product_id,shop_id,sku,size_value,size_unit) values ($1,$2,'Z-0',0,'g')", [productA, shopA]), /check/);
      await rejects(q("insert into product_variants (product_id,shop_id,sku,low_stock_threshold) values ($1,$2,'Z-1',-1)", [productA, shopA]), /check/);
    });
  });
  it("products with variants cannot be hard-deleted", async () => {
    await asUser(db, owner, () => rejects(q("delete from products where id=$1", [productA]), /foreign key|violates/));
  });
});

describe("price history (Test I support)", () => {
  const price = (t: string, amt: number, at: string) => q("select set_variant_price($1,$2::price_type,$3,$4::timestamptz)", [variantA, t, amt, at]);

  it("a new price closes the previous period; history stays contiguous", async () => {
    await asUser(db, owner, async () => {
      await price("selling", 150, "2026-11-01T00:00:00Z");
      await price("selling", 165, "2026-11-10T00:00:00Z");
    });
    const rows = (await q<{ amount_lkr: string; effective_from: Date; effective_to: Date | null }>("select * from product_price_history where variant_id=$1 and price_type='selling' order by effective_from", [variantA])).rows;
    expect(rows.map((r) => r.amount_lkr)).toEqual(["150.00", "165.00"]);
    expect(rows[0].effective_to?.toISOString()).toBe(rows[1].effective_from.toISOString());
    expect(rows[1].effective_to).toBeNull();
  });
  it("cannot rewrite the past or reuse a start time", async () => {
    await asUser(db, owner, async () => {
      await rejects(price("selling", 99, "2026-11-05T00:00:00Z"), /PRICE_PERIOD_CONFLICT/);
      await rejects(price("selling", 99, "2026-11-10T00:00:00Z"), /PRICE_PERIOD_CONFLICT/);
    });
  });
  it("rejects negative amounts; purchase cost tracked independently", async () => {
    await asUser(db, owner, async () => {
      await rejects(price("selling", -1, "2026-12-01T00:00:00Z"), /INVALID_AMOUNT|check/);
      await price("purchase_cost", 120, "2026-11-01T00:00:00Z");
    });
  });
  it("only owners may set prices; clients cannot call the internal helper", async () => {
    await asUser(db, manager, () => rejects(price("selling", 1, "2027-01-01T00:00:00Z"), /FORBIDDEN/));
    await asUser(db, owner, () => rejects(q("select _apply_price($1,'selling',1,now())", [variantA]), /permission denied/));
  });
  it("overlapping periods are impossible even via direct insert", async () => {
    await asUser(db, owner, () => rejects(q("insert into product_price_history (variant_id,price_type,amount_lkr,effective_from) values ($1,'selling',1,'2026-11-12T00:00:00Z')", [variantA]), /price_history_no_overlap|conflicting/));
  });
});

describe("import_catalog (all-or-nothing)", () => {
  const payload = (extra: object[] = []) => JSON.stringify([
    { product_code: "IMP-1", name: "Imported One", category: "Spices", variants: [{ sku: "IMP-1-A", size_value: "100", size_unit: "g", base_inventory_unit: "packet", low_stock_threshold: "5", selling_price: "99.50", purchase_cost: "70" }] },
    ...extra,
  ]);

  it("creates category, product, variant and prices in one go", async () => {
    const r = await asUser(db, owner, () => q<{ import_catalog: { products: number; variants: number } }>("select import_catalog($1,$2::jsonb)", [shopA, payload()]));
    expect(r.rows[0].import_catalog).toEqual({ products: 1, variants: 1 });
    const p = await q("select amount_lkr from product_price_history h join product_variants v on v.id=h.variant_id where v.sku='IMP-1-A' and h.price_type='selling'");
    expect(p.rows[0]).toEqual({ amount_lkr: "99.50" });
    expect((await q("select 1 from categories where shop_id=$1 and name='Spices'", [shopA])).rows).toHaveLength(1);
  });
  it("rolls back EVERYTHING when any row conflicts (transaction rollback)", async () => {
    const before = (await q<{ n: number }>("select count(*)::int n from products where shop_id=$1", [shopA])).rows[0].n;
    const bad = payload([
      { product_code: "IMP-2", name: "Fine Product", category: "NewCat", variants: [{ sku: "IMP-2-A" }] },
      { product_code: "IMP-3", name: "Clash", variants: [{ sku: "CHL-250" }] }, // existing SKU
    ]);
    await asUser(db, owner, () => rejects(q("select import_catalog($1,$2::jsonb)", [shopA, bad.replace('"IMP-1"', '"IMP-9"').replace('"IMP-1-A"', '"IMP-9-A"')]), /duplicate|variants_shop_sku_uq/));
    const after = (await q<{ n: number }>("select count(*)::int n from products where shop_id=$1", [shopA])).rows[0].n;
    expect(after).toBe(before);
    expect((await q("select 1 from categories where name='NewCat'")).rows).toHaveLength(0);
    expect((await q("select 1 from products where product_code in ('IMP-2','IMP-9')")).rows).toHaveLength(0);
  });
  it("only the shop owner can import", async () => {
    await asUser(db, manager, () => rejects(q("select import_catalog($1,$2::jsonb)", [shopA, payload()]), /FORBIDDEN/));
    await asUser(db, outsider, () => rejects(q("select import_catalog($1,$2::jsonb)", [shopA, payload()]), /FORBIDDEN/));
  });
});

describe("stock tables (foundation for Phase 4/5)", () => {
  it("an uncounted line must have NULL quantity; a counted line must be >= 0", async () => {
    const s = (await q<{ id: string }>("insert into stock_count_sessions (shop_id,business_date,created_by) values ($1,'2026-11-02',$2) returning id", [shopA, owner])).rows[0].id;
    await rejects(q("insert into stock_count_lines (session_id,variant_id,count_status,normalized_base_quantity) values ($1,$2,'not_counted',0)", [s, variantA]), /check/);
    await rejects(q("insert into stock_count_lines (session_id,variant_id,count_status,normalized_base_quantity) values ($1,$2,'counted',-1)", [s, variantA]), /check/);
    await q("insert into stock_count_lines (session_id,variant_id,count_status,normalized_base_quantity) values ($1,$2,'counted',0)", [s, variantA]); // explicit zero is valid
  });
  it("one count session per shop per business date", async () => {
    await rejects(q("insert into stock_count_sessions (shop_id,business_date,created_by) values ($1,'2026-11-02',$2)", [shopA, owner]), /duplicate|unique/);
  });
  it("stock movements are append-only; clients cannot insert them directly (record_movement validates + de-duplicates)", async () => {
    await asUser(db, manager, async () => {
      await rejects(q("insert into stock_movements (shop_id,variant_id,type,input_quantity,normalized_base_quantity,effective_at,idempotency_key,reason,created_by) values ($1,$2,'stock_received',20,20,now(),'key-1','x',$3)", [shopA, variantA, manager]), /permission denied/);
      await rejects(q("update stock_movements set normalized_base_quantity=999"), /permission denied/);
      await rejects(q("delete from stock_movements"), /permission denied/);
    });
  });
});

describe("packaging guard (Phase 3, Test J at database level)", () => {
  let pv: string; // dedicated variant so other tests are unaffected
  let otherVariant: string;
  const unit = (name: string, parent: string | null, factor: number, variant = () => pv) =>
    q<{ id: string; base_unit_multiplier: string }>("insert into packaging_units (variant_id,name,parent_unit_id,conversion_factor,base_unit_multiplier) values ($1,$2,$3,$4,1) returning id,base_unit_multiplier", [variant(), name, parent, factor]);
  const mult = async (id: string) => (await q<{ m: string }>("select base_unit_multiplier::text m from packaging_units where id=$1", [id])).rows[0].m;

  beforeAll(async () => {
    await asUser(db, owner, async () => {
      pv = (await q<{ id: string }>("insert into product_variants (product_id,shop_id,sku,base_inventory_unit) values ($1,$2,'PK-1','packet') returning id", [productA, shopA])).rows[0].id;
      otherVariant = (await q<{ id: string }>("insert into product_variants (product_id,shop_id,sku,base_inventory_unit) values ($1,$2,'PK-2','packet') returning id", [productA, shopA])).rows[0].id;
    });
  });

  it("derives the base multiplier itself (ignores what the client sends) and nests", async () => {
    await asUser(db, owner, async () => {
      const b = (await unit("Bundle", null, 12)).rows[0];
      expect(await mult(b.id)).toBe("12.000000");
      const c = (await unit("Carton", b.id, 4)).rows[0];
      expect(await mult(c.id)).toBe("48.000000");
    });
  });
  it("rejects zero / negative factors", async () => {
    await asUser(db, owner, async () => {
      await rejects(unit("Zero", null, 0), /check/);
      await rejects(unit("Neg", null, -2), /check/);
    });
  });
  it("rejects duplicate active names (case-insensitive) and the base unit's own name", async () => {
    await asUser(db, owner, async () => {
      await rejects(unit("bundle", null, 6), /packaging_variant_name_uq|duplicate/);
      await rejects(unit("Packet", null, 6), /NAME_EQUALS_BASE/);
    });
  });
  it("cannot build on a unit from another variant", async () => {
    await asUser(db, owner, async () => {
      const parent = (await q<{ id: string }>("select id from packaging_units where variant_id=$1 and name='Bundle'", [pv])).rows[0].id;
      await rejects(unit("CrossVariant", parent, 2, () => otherVariant), /PARENT_OTHER_VARIANT/);
    });
  });
  it("rejects circular definitions on update, and self-parenting", async () => {
    await asUser(db, owner, async () => {
      const b = (await q<{ id: string }>("select id from packaging_units where variant_id=$1 and name='Bundle'", [pv])).rows[0].id;
      const c = (await q<{ id: string }>("select id from packaging_units where variant_id=$1 and name='Carton'", [pv])).rows[0].id;
      await rejects(q("update packaging_units set parent_unit_id=$1 where id=$2", [c, b]), /CIRCULAR_PACKAGING/); // Bundle built from Carton built from Bundle
      await rejects(q("update packaging_units set parent_unit_id=id where id=$1", [b]), /SELF_PARENT|check/);
    });
  });
  it("limits nesting depth to 5 units", async () => {
    await asUser(db, owner, async () => {
      const v = (await q<{ id: string }>("insert into product_variants (product_id,shop_id,sku) values ($1,$2,'PK-DEEP') returning id", [productA, shopA])).rows[0].id;
      let parent: string | null = null;
      for (let i = 1; i <= 5; i++) parent = (await unit(`L${i}`, parent, 2, () => v)).rows[0].id;
      await rejects(unit("L6", parent, 2, () => v), /PACKAGING_TOO_DEEP/);
    });
  });
  it("changing a unit's size recomputes units built on it", async () => {
    await asUser(db, owner, async () => {
      const b = (await q<{ id: string }>("select id from packaging_units where variant_id=$1 and name='Bundle'", [pv])).rows[0].id;
      const c = (await q<{ id: string }>("select id from packaging_units where variant_id=$1 and name='Carton'", [pv])).rows[0].id;
      await q("update packaging_units set conversion_factor=10 where id=$1", [b]);
      expect(await mult(b)).toBe("10.000000");
      expect(await mult(c)).toBe("40.000000");
    });
  });
  it("cannot deactivate a unit that active units depend on, but can once they are inactive", async () => {
    await asUser(db, owner, async () => {
      const b = (await q<{ id: string }>("select id from packaging_units where variant_id=$1 and name='Bundle'", [pv])).rows[0].id;
      const c = (await q<{ id: string }>("select id from packaging_units where variant_id=$1 and name='Carton'", [pv])).rows[0].id;
      await rejects(q("update packaging_units set is_active=false where id=$1", [b]), /HAS_ACTIVE_CHILDREN/);
      await q("update packaging_units set is_active=false where id=$1", [c]);
      await q("update packaging_units set is_active=false where id=$1", [b]);
      await rejects(q("update packaging_units set is_active=true where id=$1", [c]), /INACTIVE_PARENT/);
      await q("update packaging_units set is_active=true where id=$1", [b]);
    });
  });
  it("a unit used by stock movements cannot be redefined (history stays interpretable)", async () => {
    // movements are inserted by the (privileged) record_movement path; simulate that here
    await q("insert into stock_movements (shop_id,variant_id,type,input_quantity,input_unit_id,normalized_base_quantity,effective_at,idempotency_key,reason,created_by) values ($1,$2,'stock_received',2,$3,20,now(),'pk-mv-1','delivery',$4)", [shopA, pv, (await q<{ id: string }>("select id from packaging_units where variant_id=$1 and name='Bundle'", [pv])).rows[0].id, owner]);
    await asUser(db, owner, async () => {
      const b = (await q<{ id: string }>("select id from packaging_units where variant_id=$1 and name='Bundle'", [pv])).rows[0].id;
      await rejects(q("update packaging_units set conversion_factor=24 where id=$1", [b]), /PACKAGING_IN_USE/);
      await q("update packaging_units set name='Bundle pack' where id=$1", [b]); // renaming is harmless
    });
  });
  it("only owners can change packaging; clients cannot delete it; changes are audited", async () => {
    await asUser(db, manager, () => rejects(unit("Sneaky", null, 3), /row-level security/));
    await asUser(db, owner, () => rejects(q("delete from packaging_units where variant_id=$1", [pv]), /permission denied/));
    await asUser(db, owner, async () => expect((await q("select 1 from audit_logs where entity_type='packaging_units'")).rows.length).toBeGreaterThan(0));
  });
  it("another shop cannot see this shop's packaging", async () => {
    await asUser(db, outsider, async () => expect((await q("select * from packaging_units")).rows).toHaveLength(0));
  });
});
