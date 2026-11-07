// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createQueue, type NewQueuedCount } from "@/lib/offline/queue-engine";
import { createSqliteQueueStore, type SqlDriver, type SqlTx } from "../../mobile/src/offline/sqlite-store";
import { defineQueueSuite } from "./helpers/queue-suite";

/**
 * Runs the phone's SQLite queue store against a REAL SQLite engine (Node's built-in), through the same driver interface the phone
 * binds to expo-sqlite. Skipped only where the Node version has no built-in SQLite.
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
const Sqlite = await loadSqlite();

/** The same shape the phone builds around expo-sqlite, here around Node's synchronous API. */
function nodeDriver(): () => Promise<SqlDriver> {
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

const input: NewQueuedCount = {
  scope: "shop1:user1", businessDate: "2026-11-02", ack: true, key: "key-0123456789",
  payload: { businessDate: "2026-11-02", revision: null, items: [] }, labels: {}, yours: {},
};
let n = 0;
const newKey = () => `generated-key-${++n}-padding`;

describe.skipIf(!Sqlite)("phone queue on real SQLite", () => {
  defineQueueSuite("phone (SQLite)", () => createQueue(createSqliteQueueStore(nodeDriver()), { newKey }));

  it("a storage failure is reported as 'unavailable' and writes nothing, instead of pretending the count was saved", async () => {
    const q = createQueue(createSqliteQueueStore(async () => { throw new Error("cannot open database"); }), { newKey });
    expect(await q.enqueueCount(input)).toEqual({ ok: false, reason: "unavailable" });
    expect(await q.listQueued("shop1:user1")).toEqual([]);
  });

  it("recovers if the database could not be opened the first time (the next call tries again)", async () => {
    let fail = true;
    const open = nodeDriver();
    const q = createQueue(createSqliteQueueStore(async () => { if (fail) throw new Error("locked"); return open(); }), { newKey });
    expect(await q.enqueueCount(input)).toEqual({ ok: false, reason: "unavailable" });
    fail = false;
    expect((await q.enqueueCount(input)).ok).toBe(true);
  });

  it("a transaction that throws rolls back what it wrote", async () => {
    const q = createQueue(createSqliteQueueStore(nodeDriver()), { newKey });
    await q.enqueueCount(input);
    const before = await q.listQueued("shop1:user1");
    await q.updateQueued(before[0].id, () => { throw new Error("boom"); });
    expect(await q.listQueued("shop1:user1")).toEqual(before);
  });
});
