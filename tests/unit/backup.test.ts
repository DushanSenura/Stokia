// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BACKUP_TABLES, backupChunks, PAGE_SIZE, verifyBackup, type BackupFinish, type BackupSource } from "@/features/data/backup";

vi.mock("server-only", () => ({}));

const meta = { shopId: "shop-1", shopName: "Perera Stores", exportedAt: "2026-11-06T04:00:00.000Z" };
const rowsFor = (n: number, table: string) => Array.from({ length: n }, (_, i) => ({ id: `${table}-${i}`, note: `ශ්‍රී "quoted" ${i}`, qty: i + 0.5 }));
const fakeSource = (sizes: Record<string, number>, failOn?: string): BackupSource => ({
  async page(t, offset, size) {
    if (t.name === failOn && offset > 0) throw new Error("db went away");
    const all = rowsFor(sizes[t.name] ?? 0, t.name);
    return all.slice(offset, offset + size);
  },
});
async function run(src: BackupSource) {
  let finish: BackupFinish | undefined;
  let text = "";
  let error: unknown;
  try { for await (const c of backupChunks(src, meta, (f) => { finish = f; })) text += c; } catch (e) { error = e; }
  return { text, finish: finish!, error };
}

describe("backup file", () => {
  it("is valid JSON, verifies, and contains every row (including across page boundaries)", async () => {
    const sizes = { products: 3, stock_count_lines: PAGE_SIZE * 2 + 7, audit_logs: PAGE_SIZE }; // exactly one full page, then an empty page
    const { text, finish, error } = await run(fakeSource(sizes));
    expect(error).toBeUndefined();
    const doc = JSON.parse(text);
    expect(doc.format).toBe("stokia-backup");
    expect(doc.shop).toEqual({ id: "shop-1", name: "Perera Stores" });
    expect(doc.data.products).toHaveLength(3);
    expect(doc.data.stock_count_lines).toHaveLength(PAGE_SIZE * 2 + 7);
    expect(doc.data.audit_logs).toHaveLength(PAGE_SIZE);
    expect(Object.keys(doc.data)).toEqual(BACKUP_TABLES.map((t) => t.name));
    expect(finish.complete).toBe(true);
    expect(finish.counts.stock_count_lines).toBe(PAGE_SIZE * 2 + 7);
    expect(doc.footer.checksum).toBe(finish.checksum);
    expect(verifyBackup(text)).toMatchObject({ ok: true, problems: [] });
  });

  it("keeps Sinhala text, quotes and decimals exactly", async () => {
    const { text } = await run(fakeSource({ products: 2 }));
    const doc = JSON.parse(text);
    expect(doc.data.products[1]).toEqual({ id: "products-1", note: 'ශ්‍රී "quoted" 1', qty: 1.5 });
  });

  it("an empty shop still produces a valid, verifiable file", async () => {
    const { text } = await run(fakeSource({}));
    expect(verifyBackup(text).ok).toBe(true);
  });

  it("detects a changed value, a removed row, a damaged file and a wrong format", async () => {
    const { text } = await run(fakeSource({ products: 5, daily_sales: 5 }));
    expect(verifyBackup(text.replace('"qty":2.5', '"qty":9.5')).problems).toContain("checksum_mismatch");

    const doc = JSON.parse(text);
    doc.data.products.pop();
    expect(verifyBackup(JSON.stringify(doc)).problems).toEqual(expect.arrayContaining(["count_mismatch:products", "checksum_mismatch"]));

    expect(verifyBackup(text.slice(0, text.length - 40)).problems).toEqual(["not_valid_json"]);
    expect(verifyBackup("").problems).toEqual(["not_valid_json"]);
    expect(verifyBackup("null").ok).toBe(false);
    expect(verifyBackup(JSON.stringify({ ...doc, format: "other" })).problems).toContain("wrong_format");
    expect(verifyBackup(JSON.stringify({ ...doc, version: 99 })).problems).toContain("unsupported_version");
    const noFooter = { ...doc };
    delete noFooter.footer;
    expect(verifyBackup(JSON.stringify(noFooter)).problems).toContain("no_footer");
  });

  it("a missing table is reported", async () => {
    const { text } = await run(fakeSource({ products: 1 }));
    const doc = JSON.parse(text);
    delete doc.data.audit_logs;
    expect(verifyBackup(JSON.stringify(doc)).problems).toContain("missing_table:audit_logs");
  });

  it("if the database fails part-way the stream errors, the audit callback still fires, and it is marked incomplete", async () => {
    const { text, finish, error } = await run(fakeSource({ stock_movements: PAGE_SIZE * 2 }, "stock_movements"));
    expect(String(error)).toMatch(/db went away/);
    expect(finish.complete).toBe(false);
    expect(finish.checksum).toBe("incomplete");
    expect(verifyBackup(text).ok).toBe(false); // the half-written file cannot pass as a good backup
  });

  it("if the download is cancelled early, the audit callback still fires as incomplete", async () => {
    let finish: BackupFinish | undefined;
    const gen = backupChunks(fakeSource({ products: 3 }), meta, (f) => { finish = f; });
    await gen.next();
    await gen.return(undefined);
    expect(finish?.complete).toBe(false);
  });

  it("never includes e-mail addresses or password material (no profile/auth tables)", () => {
    const names = BACKUP_TABLES.map((t) => t.name);
    expect(names.some((n) => /profile|auth|user$|invitation/.test(n))).toBe(false);
  });

  it("every table that has a shop column is filtered by it", () => {
    for (const t of BACKUP_TABLES) {
      if (t.name === "shops") expect(t.scope).toBe("id");
      else if (!["packaging_units", "product_price_history", "stock_count_lines", "stock_count_corrections"].includes(t.name)) expect(t.scope, t.name).toBe("shop_id");
    }
  });
});

// ---- the route ----
const ctx = vi.fn();
vi.mock("@/server/services/session", () => ({ getSessionContext: () => ctx() }));
const rpc = vi.fn();
const pages: Record<string, number> = {};
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (...a: unknown[]) => rpc(...a),
    from: (table: string) => {
      const q = { select: () => q, order: () => q, eq: () => q, range: async (a: number, b: number) => ({ data: rowsFor(pages[table] ?? 0, table).slice(a, b + 1), error: null }) };
      return q;
    },
  }),
}));

describe("GET /api/exports/backup", () => {
  const member = (role: string) => ({ user: { id: "u" }, membership: { shopId: "shop-1", shopName: "Perera Stores", timezone: "Asia/Colombo", role } });
  beforeEach(() => { ctx.mockReset(); rpc.mockReset().mockResolvedValue({ data: null, error: null }); for (const k of Object.keys(pages)) delete pages[k]; });

  it("401 for anonymous, 403 for managers and viewers, and nothing is read or audited", async () => {
    const { GET } = await import("@/app/api/exports/backup/route");
    ctx.mockResolvedValue({ user: null, membership: null });
    expect((await GET()).status).toBe(401);
    for (const role of ["stock_manager", "viewer"]) {
      ctx.mockResolvedValue(member(role));
      expect((await GET()).status).toBe(403);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an owner gets a verifiable file with safe headers, and the download is audited with counts and checksum", async () => {
    const { GET } = await import("@/app/api/exports/backup/route");
    pages.products = 4;
    pages.stock_movements = 2;
    ctx.mockResolvedValue(member("owner"));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="stokia-backup-\d{4}-\d{2}-\d{2}\.json"$/);
    const text = await res.text();
    expect(verifyBackup(text)).toMatchObject({ ok: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0];
    expect(fn).toBe("record_backup_export");
    expect(args.p_shop).toBe("shop-1");
    expect(args.p_counts).toMatchObject({ products: 4, stock_movements: 2 });
    expect(args.p_checksum).toBe(JSON.parse(text).footer.checksum);
  });
});
