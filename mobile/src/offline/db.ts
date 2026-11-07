import * as SQLite from "expo-sqlite";
import type { SqlDriver, SqlTx } from "./sqlite-store";

/** One shared SQLite connection for the whole app (the offline queue, saved drafts, cached screens, preferences). */
let opened: Promise<SqlDriver> | null = null;

const params = (p?: unknown[]) => (p ?? []) as SQLite.SQLiteBindParams;

export function openDriver(): Promise<SqlDriver> {
  opened ??= (async () => {
    const db = await SQLite.openDatabaseAsync("stokia.db");
    await db.execAsync("PRAGMA journal_mode = WAL;");
    const driver: SqlDriver = {
      exec: (sql) => db.execAsync(sql),
      all: <T,>(sql: string, p?: unknown[]) => db.getAllAsync<T>(sql, params(p)),
      run: async (sql, p) => { await db.runAsync(sql, params(p)); },
      // expo-sqlite's exclusive transaction rolls back if the callback throws. Its callback returns nothing, so the result is captured.
      transaction: async <T,>(fn: (tx: SqlTx) => Promise<T>) => {
        let out: T | undefined;
        await db.withExclusiveTransactionAsync(async (txn) => {
          out = await fn({
            all: <R,>(sql: string, p?: unknown[]) => txn.getAllAsync<R>(sql, params(p)),
            run: async (sql, p) => { await txn.runAsync(sql, params(p)); },
          });
        });
        return out as T;
      },
    };
    return driver;
  })().catch((e) => { opened = null; throw e; });
  return opened;
}
