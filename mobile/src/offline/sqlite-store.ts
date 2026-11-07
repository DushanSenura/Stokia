import type { QueuedCount, QueueStore } from "@/lib/offline/queue-engine";

/**
 * The phone's binding of the shared offline-queue rules (`src/lib/offline/queue-engine.ts`) to SQLite. The rules themselves are the
 * same code the web app runs; this file only says how to store rows. Kept free of React Native imports so it can be tested with a
 * real SQLite in Node.
 *
 * Each queued count is one row: the whole entry as JSON, plus the scope and date so listing is an indexed query.
 */
export interface SqlTx {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
}
export interface SqlDriver extends SqlTx {
  exec(sql: string): Promise<void>;
  /** Run `fn` inside one exclusive transaction. If `fn` throws, everything it wrote is rolled back and the error is rethrown. */
  transaction<T>(fn: (tx: SqlTx) => Promise<T>): Promise<T>;
}

export const QUEUE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS queued_counts (
    id TEXT PRIMARY KEY NOT NULL,
    scope TEXT NOT NULL,
    business_date TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS queued_counts_scope_idx ON queued_counts (scope, business_date);
`;

export function createSqliteQueueStore(open: () => Promise<SqlDriver>): QueueStore {
  let ready: Promise<SqlDriver> | null = null;
  const driver = () => (ready ??= open().then(async (d) => { await d.exec(QUEUE_SCHEMA); return d; }).catch((e) => { ready = null; throw e; }));
  const parse = (rows: { body: string }[]) => rows.map((r) => JSON.parse(r.body) as QueuedCount);

  return {
    async list(scope) {
      try {
        const d = await driver();
        return parse(await d.all<{ body: string }>("SELECT body FROM queued_counts WHERE scope = ? ORDER BY business_date", [scope]));
      } catch {
        return [];
      }
    },

    async transact(fn, fallback) {
      try {
        const d = await driver();
        return await d.transaction((tx) => fn({
          get: async (id) => {
            const rows = await tx.all<{ body: string }>("SELECT body FROM queued_counts WHERE id = ?", [id]);
            return rows.length ? (JSON.parse(rows[0].body) as QueuedCount) : undefined;
          },
          put: async (e) => {
            await tx.run(
              "INSERT INTO queued_counts (id, scope, business_date, body) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, business_date = excluded.business_date, body = excluded.body",
              [e.id, e.scope, e.businessDate, JSON.stringify(e)],
            );
          },
        }));
      } catch {
        return fallback; // storage failed: nothing was written (the transaction rolled back)
      }
    },

    async remove(id) {
      try { await (await driver()).run("DELETE FROM queued_counts WHERE id = ?", [id]); } catch { /* storage unavailable */ }
    },

    async clear() {
      try { await (await driver()).run("DELETE FROM queued_counts"); } catch { /* storage unavailable */ }
    },
  };
}
