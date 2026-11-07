import { createHash } from "node:crypto";

/**
 * A complete, self-describing copy of one shop's data, for an owner to keep safely (a spreadsheet cannot hold the
 * count history faithfully; a database dump is not something a shop owner can make). It is a *copy*, not a restore tool:
 * restoring is done by Stokia's maintainers from the file, because blindly re-inserting rows would bypass the checks
 * (append-only history, reconciliation) that keep the numbers trustworthy.
 *
 * Layout:  { format, version, exportedAt, shop, data: { table: [rows] }, footer: { counts, checksum, complete } }
 * The footer comes LAST so the file can be streamed; the checksum is a SHA-256 over every row in order, so a
 * truncated, edited or damaged file is detected by `verifyBackup`.
 */
export const BACKUP_FORMAT = "stokia-backup";
export const BACKUP_VERSION = 1;
export const PAGE_SIZE = 1000;

export interface BackupTable {
  name: string;
  /** Column that scopes rows to the shop in the query. null = the table has no shop column; row-level security scopes it. */
  scope: "shop_id" | "id" | null;
  order: string;
}

/** Order matters only for readability: parents before children. Personal data (e-mail addresses, passwords) is deliberately absent. */
export const BACKUP_TABLES: readonly BackupTable[] = [
  { name: "shops", scope: "id", order: "id" },
  { name: "shop_memberships", scope: "shop_id", order: "id" },
  { name: "categories", scope: "shop_id", order: "id" },
  { name: "products", scope: "shop_id", order: "id" },
  { name: "product_variants", scope: "shop_id", order: "id" },
  { name: "packaging_units", scope: null, order: "id" },
  { name: "product_price_history", scope: null, order: "id" },
  { name: "stock_count_sessions", scope: "shop_id", order: "id" },
  { name: "stock_count_lines", scope: null, order: "id" },
  { name: "stock_count_corrections", scope: null, order: "id" },
  { name: "stock_movements", scope: "shop_id", order: "id" },
  { name: "daily_sales", scope: "shop_id", order: "id" },
  { name: "daily_sales_revisions", scope: "shop_id", order: "id" },
  { name: "report_exports", scope: "shop_id", order: "id" },
  { name: "audit_logs", scope: "shop_id", order: "id" },
];

export interface BackupSource {
  /** One page of rows for a table, in `order`. An empty or short page ends the table. */
  page(table: BackupTable, offset: number, size: number): Promise<Record<string, unknown>[]>;
}
export interface BackupFinish { counts: Record<string, number>; checksum: string; complete: boolean }

/** The checksum recipe, shared by writer and verifier so the two cannot drift apart. */
export class Digest {
  private h = createHash("sha256");
  table(name: string) { this.h.update(`#${name}\n`); }
  row(row: unknown) { this.h.update(`${JSON.stringify(row)}\n`); }
  private done?: string;
  /** Finalises once; later calls return the same value (a Node hash can only be finalised one time). */
  hex() { return (this.done ??= this.h.digest("hex")); }
}

/** Streams the backup as JSON text pieces. Calls `onFinish` exactly once, also when the source fails part-way (complete = false). */
export async function* backupChunks(
  source: BackupSource,
  meta: { shopId: string; shopName: string; exportedAt: string },
  onFinish: (f: BackupFinish) => void | Promise<void>,
  tables: readonly BackupTable[] = BACKUP_TABLES,
): AsyncGenerator<string> {
  const digest = new Digest();
  const counts: Record<string, number> = {};
  let complete = false;
  try {
    yield `{"format":"${BACKUP_FORMAT}","version":${BACKUP_VERSION},"exportedAt":${JSON.stringify(meta.exportedAt)},"shop":${JSON.stringify({ id: meta.shopId, name: meta.shopName })},"data":{`;
    let firstTable = true;
    for (const t of tables) {
      digest.table(t.name);
      counts[t.name] = 0;
      yield `${firstTable ? "" : ","}${JSON.stringify(t.name)}:[`;
      firstTable = false;
      let first = true;
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const rows = await source.page(t, offset, PAGE_SIZE);
        if (rows.length) {
          let out = "";
          for (const r of rows) { digest.row(r); out += `${first ? "" : ","}${JSON.stringify(r)}`; first = false; }
          counts[t.name] += rows.length;
          yield out;
        }
        if (rows.length < PAGE_SIZE) break;
      }
      yield "]";
    }
    complete = true;
    yield `},"footer":${JSON.stringify({ counts, checksum: digest.hex(), complete: true })}}`;
  } finally {
    await onFinish({ counts, checksum: complete ? digest.hex() : "incomplete", complete });
  }
}

export interface VerifyResult { ok: boolean; problems: string[]; counts: Record<string, number> }

/** Checks a backup file's structure, row counts and checksum. Never throws on bad input. */
export function verifyBackup(text: string): VerifyResult {
  const problems: string[] = [];
  let doc: { format?: unknown; version?: unknown; data?: Record<string, unknown>; footer?: { counts?: Record<string, number>; checksum?: string; complete?: boolean } };
  try { doc = JSON.parse(text); } catch { return { ok: false, problems: ["not_valid_json"], counts: {} }; }
  if (!doc || typeof doc !== "object") return { ok: false, problems: ["not_valid_json"], counts: {} };
  if (doc.format !== BACKUP_FORMAT) problems.push("wrong_format");
  if (doc.version !== BACKUP_VERSION) problems.push("unsupported_version");
  if (!doc.data || typeof doc.data !== "object") return { ok: false, problems: [...problems, "no_data"], counts: {} };
  if (!doc.footer) return { ok: false, problems: [...problems, "no_footer"], counts: {} };

  const digest = new Digest();
  const counts: Record<string, number> = {};
  for (const [name, rows] of Object.entries(doc.data)) {
    if (!Array.isArray(rows)) { problems.push(`table_not_a_list:${name}`); continue; }
    digest.table(name);
    for (const r of rows) digest.row(r);
    counts[name] = rows.length;
  }
  for (const t of BACKUP_TABLES) if (!(t.name in counts)) problems.push(`missing_table:${t.name}`);
  for (const [name, n] of Object.entries(doc.footer.counts ?? {})) if (counts[name] !== n) problems.push(`count_mismatch:${name}`);
  if (doc.footer.complete !== true) problems.push("marked_incomplete");
  if (doc.footer.checksum !== digest.hex()) problems.push("checksum_mismatch");
  return { ok: problems.length === 0, problems, counts };
}
