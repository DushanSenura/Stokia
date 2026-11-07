// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createQueue, type NewQueuedCount } from "@/lib/offline/queue-engine";
import { createSqliteQueueStore } from "../../mobile/src/offline/sqlite-store";
import { nodeDriver, Sqlite } from "./helpers/node-sqlite";
import { defineQueueSuite } from "./helpers/queue-suite";

/** Runs the phone's SQLite queue store against a REAL SQLite engine (see helpers/node-sqlite.ts). Skipped only where Node has none. */

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
