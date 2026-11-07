// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMovementQueue, MAX_MOVEMENT_ATTEMPTS, type MovementAnswer, type NewQueuedMovement, type QueuedMovement } from "@/lib/offline/movement-queue";
import { createSqliteMovementStore } from "../../mobile/src/offline/sqlite-store";
import { createLocalStorageMovementStore } from "../../mobile/src/offline/web-store";
import { nodeDriver, Sqlite } from "./helpers/node-sqlite";

type Queue = ReturnType<typeof createMovementQueue>;
const SCOPE = "shop1:user1";
const V = "00000000-0000-4000-8000-000000000001";

const entry = (key: string, over: Partial<NewQueuedMovement> = {}): NewQueuedMovement => ({
  scope: SCOPE, key,
  payload: { variantId: V, type: "stock_received", unitId: null, quantity: "10", when: "custom", effectiveLocal: "2026-11-06T18:45", reference: "INV-1" },
  summary: { label: "Coconut Oil 1 L", baseUnit: "bottle", effect: "10", entered: "10 bottle" },
  ...over,
});
const ok = (id = "m1", duplicate = false): MovementAnswer => ({ ok: true, id, duplicate });
const refused = (error: string, fieldErrors?: Record<string, string>): MovementAnswer => ({ ok: false, error: error as never, fieldErrors: fieldErrors as never });

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
}

/** The movement-queue rules, run against every storage backend the phone uses. */
function defineSuite(label: string, make: () => Queue, clock: { t: number }) {
  describe(`movement queue rules on ${label}`, () => {
    let q: Queue;
    const keys = async () => (await q.list(SCOPE)).map((e) => e.key);
    const get = async (key: string) => (await q.list(SCOPE)).find((e) => e.key === key) as QueuedMovement;

    beforeEach(async () => { q = make(); await q.clear(); clock.t = 1_000; });

    describe("saving", () => {
      it("keeps a pending entry whose id is the key it will be sent with, oldest first", async () => {
        await q.enqueue(entry("key-bbbbbbbb")); clock.t += 10;
        await q.enqueue(entry("key-aaaaaaaa"));
        expect(await keys()).toEqual(["key-bbbbbbbb", "key-aaaaaaaa"]);
        expect(await get("key-bbbbbbbb")).toMatchObject({ id: "key-bbbbbbbb", state: "pending", maybeSent: false, attempts: 0, lastTriedAt: null });
      });

      it("the same entry saved twice (a double tap) is one entry", async () => {
        await q.enqueue(entry("key-aaaaaaaa")); await q.enqueue(entry("key-aaaaaaaa"));
        expect(await keys()).toEqual(["key-aaaaaaaa"]);
      });

      it("keeps shops and people apart on a shared phone", async () => {
        await q.enqueue(entry("key-aaaaaaaa")); await q.enqueue(entry("key-bbbbbbbb", { scope: "shop1:someone-else" }));
        expect(await keys()).toEqual(["key-aaaaaaaa"]);
        expect(await q.list("shop2:user1")).toEqual([]);
      });
    });

    describe("sending", () => {
      it("sends each entry with ITS key and removes it once the server confirms", async () => {
        await q.enqueue(entry("key-aaaaaaaa")); clock.t += 1; await q.enqueue(entry("key-bbbbbbbb"));
        const submit = vi.fn(async (e: QueuedMovement) => ok(`id-${e.key}`));
        const out = await q.sync(SCOPE, submit);
        expect(submit.mock.calls.map((c) => c[0].key)).toEqual(["key-aaaaaaaa", "key-bbbbbbbb"]);
        expect(out.confirmed.map((e) => e.key)).toEqual(["key-aaaaaaaa", "key-bbbbbbbb"]);
        expect(await keys()).toEqual([]);
      });

      it("an entry the server had already recorded (a replay) is confirmed and removed, never recorded twice", async () => {
        await q.enqueue(entry("key-aaaaaaaa"));
        const out = await q.sync(SCOPE, async () => ok("m9", true));
        expect(out.confirmed).toHaveLength(1);
        expect(await keys()).toEqual([]);
      });

      it("marks the entry as maybe-sent BEFORE sending, so a crash mid-send cannot lead to it being discarded", async () => {
        await q.enqueue(entry("key-aaaaaaaa"));
        let seenDuringSend: QueuedMovement | undefined;
        await q.sync(SCOPE, async () => { seenDuringSend = await get("key-aaaaaa" + "aa"); throw new Error("app died"); });
        expect(seenDuringSend).toMatchObject({ maybeSent: true, attempts: 1 });
      });

      it("no answer keeps everything, stops the run, and replays the SAME key next time", async () => {
        await q.enqueue(entry("key-aaaaaaaa")); clock.t += 1; await q.enqueue(entry("key-bbbbbbbb"));
        const down = vi.fn(async () => { throw new Error("offline"); });
        const out = await q.sync(SCOPE, down);
        expect(out).toMatchObject({ confirmed: [], failed: [], unreachable: true, waiting: 2 });
        expect(down).toHaveBeenCalledTimes(1); // no point trying the second
        expect(await keys()).toEqual(["key-aaaaaaaa", "key-bbbbbbbb"]);
        const again = vi.fn(async (e: QueuedMovement) => ok(e.key));
        await q.sync(SCOPE, again);
        expect(again.mock.calls[0][0].key).toBe("key-aaaaaaaa");
        expect(await keys()).toEqual([]);
      });

      it("a refusal is kept WITH its reason, marked failed, and does not hold the others back", async () => {
        await q.enqueue(entry("key-aaaaaaaa")); clock.t += 1; await q.enqueue(entry("key-bbbbbbbb"));
        const out = await q.sync(SCOPE, async (e) => (e.key === "key-aaaaaaaa" ? refused("mv.err.INVALID_VARIANT") : ok("m2")));
        expect(out.failed.map((e) => e.key)).toEqual(["key-aaaaaaaa"]);
        expect(out.confirmed.map((e) => e.key)).toEqual(["key-bbbbbbbb"]);
        expect(await get("key-aaaaaaaa")).toMatchObject({ state: "failed", maybeSent: false, error: "mv.err.INVALID_VARIANT" });
        expect(await keys()).toEqual(["key-aaaaaaaa"]);
      });

      it("keeps field messages from a refusal so the person can see which part was wrong", async () => {
        await q.enqueue(entry("key-aaaaaaaa"));
        await q.sync(SCOPE, async () => refused("auth.error.generic", { reason: "mv.err.reason" }));
        // an unexplained error is retried, but a field-level refusal is a real answer; check the failed path:
        await q.update("key-aaaaaaaa", (e) => ({ ...e, attempts: MAX_MOVEMENT_ATTEMPTS }));
        await q.sync(SCOPE, async () => refused("auth.error.generic", { reason: "mv.err.reason" }));
        expect(await get("key-aaaaaaaa")).toMatchObject({ state: "failed", fieldErrors: { reason: "mv.err.reason" } });
      });

      it("an unexplained server error is retried with the same key, and only gives up after many attempts", async () => {
        await q.enqueue(entry("key-aaaaaaaa"));
        const out = await q.sync(SCOPE, async () => refused("auth.error.generic"));
        expect(out).toMatchObject({ unreachable: true, waiting: 1, failed: [] });
        expect((await get("key-aaaaaaaa")).state).toBe("pending");
        await q.update("key-aaaaaaaa", (e) => ({ ...e, attempts: MAX_MOVEMENT_ATTEMPTS }));
        await q.sync(SCOPE, async () => refused("auth.error.generic"));
        expect((await get("key-aaaaaaaa")).state).toBe("failed");
      });

      it("a failed entry is not sent again until the person says so", async () => {
        await q.enqueue(entry("key-aaaaaaaa"));
        await q.sync(SCOPE, async () => refused("mv.err.INVALID_VARIANT"));
        const submit = vi.fn(async () => ok());
        await q.sync(SCOPE, submit);
        expect(submit).not.toHaveBeenCalled();
        await q.retry("key-aaaaaaaa");
        await q.sync(SCOPE, submit);
        expect(submit).toHaveBeenCalledTimes(1);
        expect(await keys()).toEqual([]);
      });

      it("'before the count' can be told to wait (its count is still queued): it stays pending and can still be discarded", async () => {
        await q.enqueue(entry("key-aaaaaaaa", { payload: { variantId: V, type: "damaged", unitId: null, quantity: "1", when: "before_count", countDate: "2026-11-06", reason: "x" } }));
        const out = await q.sync(SCOPE, async () => refused("auth.error.generic", { when: "mv.err.noCountToday" }), { shouldWait: () => true });
        expect(out).toMatchObject({ waiting: 1, failed: [], unreachable: false });
        expect(await get("key-aaaaaaaa")).toMatchObject({ state: "pending", maybeSent: false });
        expect(await q.discard("key-aaaaaaaa")).toBe(true);
      });

      it("a second caller during a run shares its result (one run at a time)", async () => {
        await q.enqueue(entry("key-aaaaaaaa"));
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const submit = vi.fn(async () => { await gate; return ok(); });
        const a = q.sync(SCOPE, submit), b = q.sync(SCOPE, submit);
        release();
        expect(await a).toBe(await b);
        expect(submit).toHaveBeenCalledTimes(1);
      });
    });

    describe("discarding", () => {
      it("an entry that was never sent can be discarded", async () => {
        await q.enqueue(entry("key-aaaaaaaa"));
        expect(await q.discard("key-aaaaaaaa")).toBe(true);
        expect(await keys()).toEqual([]);
      });

      it("an entry that may have reached the server cannot be discarded", async () => {
        await q.enqueue(entry("key-aaaaaaaa"));
        await q.sync(SCOPE, async () => { throw new Error("offline"); });
        expect(await q.discard("key-aaaaaaaa")).toBe(false);
        expect(await keys()).toEqual(["key-aaaaaaaa"]);
      });

      it("a refused entry (the server clearly did not record it) can be discarded", async () => {
        await q.enqueue(entry("key-aaaaaaaa"));
        await q.sync(SCOPE, async () => refused("mv.err.INVALID_VARIANT"));
        expect(await q.discard("key-aaaaaaaa")).toBe(true);
      });

      it("discarding something that is gone is harmless", async () => {
        expect(await q.discard("nothing-here")).toBe(false);
      });
    });
  });
}

const clockA = { t: 1_000 };
defineSuite("localStorage (browser test build)", () => createMovementQueue(createLocalStorageMovementStore(memoryStorage()), { now: () => clockA.t }), clockA);

const clockB = { t: 1_000 };
describe.skipIf(!Sqlite)("movement queue on real SQLite", () => {
  defineSuite("SQLite (phone)", () => createMovementQueue(createSqliteMovementStore(nodeDriver()), { now: () => clockB.t }), clockB);

  it("a storage failure is reported as 'unavailable' and writes nothing, instead of pretending the movement was saved", async () => {
    const q = createMovementQueue(createSqliteMovementStore(async () => { throw new Error("cannot open database"); }));
    expect(await q.enqueue(entry("key-aaaaaaaa"))).toEqual({ ok: false, reason: "unavailable" });
    expect(await q.list(SCOPE)).toEqual([]);
  });

  it("entries survive reopening the database handle (a restart of the app)", async () => {
    const open = nodeDriver();
    await createMovementQueue(createSqliteMovementStore(open)).enqueue(entry("key-aaaaaaaa"));
    const reopened = createMovementQueue(createSqliteMovementStore(open));
    expect((await reopened.list(SCOPE)).map((e) => e.key)).toEqual(["key-aaaaaaaa"]);
  });
});
