import type { SqlDriver, SqlTx } from "../../../mobile/src/offline/sqlite-store";

/**
 * A REAL SQLite engine (Node's built-in), behind the same driver interface the phone binds to expo-sqlite, so the phone's stores can
 * be tested for real. `Sqlite` is null where this Node version has no built-in SQLite (the tests then skip).
 */
type DatabaseSyncCtor = new (path: string) => {
  exec(sql: string): void;
  prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown };
};

async function loadSqlite(): Promise<DatabaseSyncCtor | null> {
  // Loaded by a computed name: this project's Node type definitions predate the built-in module, but it exists at runtime.
  const name = "node:sqlite";
  try { return ((await import(/* @vite-ignore */ name)) as { DatabaseSync: DatabaseSyncCtor }).DatabaseSync; } catch { return null; }
}
export const Sqlite = await loadSqlite();

/** The same shape the phone builds around expo-sqlite, here around Node's synchronous API. */
export function nodeDriver(): () => Promise<SqlDriver> {
  const db = new Sqlite!(":memory:");
  const tx: SqlTx = {
    all: async <T,>(sql: string, p: unknown[] = []) => db.prepare(sql).all(...p) as T[],
    run: async (sql, p = []) => { db.prepare(sql).run(...p); },
  };
  // One transaction at a time, exactly like expo-sqlite's exclusive transactions.
  let chain: Promise<unknown> = Promise.resolve();
  const driver: SqlDriver = {
    ...tx,
    exec: async (sql) => { db.exec(sql); },
    transaction: <T,>(fn: (t: SqlTx) => Promise<T>) => {
      const next = chain.then(async () => {
        db.exec("BEGIN IMMEDIATE");
        try { const out = await fn(tx); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; }
      });
      chain = next.catch(() => undefined);
      return next;
    },
  };
  return async () => driver;
}
