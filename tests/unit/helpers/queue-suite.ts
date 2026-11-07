import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CountConflict, CountResult } from "@/features/inventory/count-types";
import { draftValuesFromPayload, isBlocked, queueId, type NewQueuedCount, type QueuedCount, type SubmitFn, type createQueue } from "@/lib/offline/queue-engine";
import { BASE_KEY } from "@/features/inventory/count-entry";

export type Queue = ReturnType<typeof createQueue>;

const SCOPE = "shop1:user1";
const V1 = "00000000-0000-4000-8000-000000000001";
const V2 = "00000000-0000-4000-8000-000000000002";

const entry = (date: string, over: Partial<NewQueuedCount> = {}): NewQueuedCount => ({
  scope: SCOPE, businessDate: date, ack: true, key: `key-${date}-aaaaaa`,
  payload: { businessDate: date, revision: null, items: [{ variantId: V1, entries: [{ unitId: null, quantity: "4" }] }] },
  labels: { [V1]: { name: "Coconut Oil 1 L", unit: "bottle" } }, yours: { [V1]: "4" }, ...over,
});
const ok = (revision = 3): CountResult => ({ ok: true, sessionId: "s1", revision, counted: 1, confirmed: true });
const conflict = (reason: CountConflict["reason"], server: CountConflict["server"]): CountResult => ({
  ok: false, error: reason === "already_confirmed" ? "ms.conflictConfirmed" : "ms.conflict", conflict: true, conflictInfo: { reason, server },
});
const serverCopy = (status: "draft" | "confirmed", revision = 5): NonNullable<CountConflict["server"]> => ({
  sessionId: "s9", revision, status, by: "Nimal", confirmedAt: null, lines: [{ variantId: V1, quantity: "7.000" }],
});

/**
 * The offline-queue rules, run against ANY storage backend. The web app runs them over IndexedDB and the phone app over SQLite,
 * so "the same rules on both" is proven by the same assertions, not assumed.
 */
export function defineQueueSuite(label: string, makeQueue: () => Queue | Promise<Queue>) {
  describe(`offline queue rules on ${label}`, () => {
    let q: Queue;
    const get = async (date: string) => (await q.listQueued(SCOPE)).find((e) => e.businessDate === date);

    beforeEach(async () => {
      q = await makeQueue();
      await q.clearAllQueued();
    });

    describe("enqueue", () => {
      it("stores a pending entry with the key it will be sent with, and lists oldest morning first", async () => {
        await q.enqueueCount(entry("2026-11-03"));
        await q.enqueueCount(entry("2026-11-02"));
        const list = await q.listQueued(SCOPE);
        expect(list.map((e) => e.businessDate)).toEqual(["2026-11-02", "2026-11-03"]);
        expect(list[0]).toMatchObject({ id: queueId(SCOPE, "2026-11-02"), state: "pending", attempts: 0, key: "key-2026-11-02-aaaaaa", lastTriedAt: null });
      });

      it("keeps accounts and shops apart on a shared device", async () => {
        await q.enqueueCount(entry("2026-11-02"));
        await q.enqueueCount(entry("2026-11-02", { scope: "shop1:someone-else" }));
        expect(await q.listQueued(SCOPE)).toHaveLength(1);
        expect(await q.listQueued("shop2:user1")).toHaveLength(0);
      });

      it("may replace a copy that was never sent, but never one that might have reached the server", async () => {
        await q.enqueueCount(entry("2026-11-02"));
        const replaced = await q.enqueueCount(entry("2026-11-02", { key: "key-second-aaaaaa", yours: { [V1]: "9" } }));
        expect(replaced.ok).toBe(true);
        expect((await get("2026-11-02"))?.key).toBe("key-second-aaaaaa");

        await q.syncQueue(SCOPE, async () => { throw new Error("no answer"); });
        const refused = await q.enqueueCount(entry("2026-11-02", { key: "key-third-aaaaaaa" }));
        expect(refused).toEqual({ ok: false, reason: "exists" });
        expect((await get("2026-11-02"))?.key).toBe("key-second-aaaaaa");
      });

      it("round-trips every field exactly (nothing is lost or reshaped by the storage)", async () => {
        const input = entry("2026-11-02", { ack: false, labels: { [V1]: { name: "Cooking Oil 1 L (ශ්‍රී)", unit: "bottle" }, [V2]: { name: "Rice", unit: "kg" } }, yours: { [V1]: "89.5", [V2]: "0" } });
        await q.enqueueCount(input);
        expect(await get("2026-11-02")).toMatchObject({ ...input, state: "pending", attempts: 0 });
      });
    });

    describe("what reaches the server", () => {
      it("sends the stored payload and key, and removes the entry only after the server confirms", async () => {
        await q.enqueueCount(entry("2026-11-02"));
        const submit = vi.fn<SubmitFn>().mockResolvedValue(ok());
        const out = await q.syncQueue(SCOPE, submit);
        expect(submit).toHaveBeenCalledTimes(1);
        expect(submit.mock.calls[0][0]).toMatchObject({ key: "key-2026-11-02-aaaaaa", ack: true, payload: { businessDate: "2026-11-02" } });
        expect(out.confirmed.map((e) => e.businessDate)).toEqual(["2026-11-02"]);
        expect(await q.listQueued(SCOPE)).toEqual([]);
      });

      it("marks the entry as attempted BEFORE sending, so a crash mid-request cannot lead to it being replaced", async () => {
        await q.enqueueCount(entry("2026-11-02"));
        let seenDuringSend: QueuedCount | undefined;
        await q.syncQueue(SCOPE, async () => { seenDuringSend = await get("2026-11-02"); return ok(); });
        expect(seenDuringSend).toMatchObject({ attempts: 1, state: "pending" });
        expect(seenDuringSend?.lastTriedAt).not.toBeNull();
      });

      it("no answer: keeps the entry and replays the SAME key next time, so a count the server did apply is never applied twice", async () => {
        await q.enqueueCount(entry("2026-11-02"));
        const keys: string[] = [];
        const down: SubmitFn = async (e) => { keys.push(e.key); throw new TypeError("Failed to fetch"); };
        const first = await q.syncQueue(SCOPE, down);
        expect(first).toMatchObject({ unreachable: true, waiting: 1, confirmed: [] });
        expect(await get("2026-11-02")).toMatchObject({ state: "pending", attempts: 1 });
        await q.syncQueue(SCOPE, down);
        expect(await get("2026-11-02")).toMatchObject({ state: "pending", attempts: 2 });
        expect(new Set(keys).size).toBe(1);
      });

      it("sends counts strictly in date order and stops at the first one that gets no answer", async () => {
        await q.enqueueCount(entry("2026-11-04"));
        await q.enqueueCount(entry("2026-11-02"));
        await q.enqueueCount(entry("2026-11-03"));
        const order: string[] = [];
        const out = await q.syncQueue(SCOPE, async (e) => { order.push(e.businessDate); if (e.businessDate === "2026-11-03") throw new Error("down"); return ok(); });
        expect(order).toEqual(["2026-11-02", "2026-11-03"]);
        expect(out).toMatchObject({ waiting: 2, unreachable: true });
        expect((await q.listQueued(SCOPE)).map((e) => e.businessDate)).toEqual(["2026-11-03", "2026-11-04"]);
      });

      it("two overlapping syncs share one run (one submission, not two)", async () => {
        await q.enqueueCount(entry("2026-11-02"));
        const submit = vi.fn<SubmitFn>().mockImplementation(async () => { await new Promise((r) => setTimeout(r, 20)); return ok(); });
        const [a, b] = await Promise.all([q.syncQueue(SCOPE, submit), q.syncQueue(SCOPE, submit)]);
        expect(submit).toHaveBeenCalledTimes(1);
        expect(a).toBe(b);
      });
    });

    describe("conflicts and failures never lose the numbers", () => {
      it("another device confirmed first: the entry becomes a conflict carrying the server's copy, and nothing later is sent past it", async () => {
        await q.enqueueCount(entry("2026-11-02"));
        await q.enqueueCount(entry("2026-11-03"));
        const submit = vi.fn<SubmitFn>().mockResolvedValue(conflict("already_confirmed", serverCopy("confirmed")));
        const out = await q.syncQueue(SCOPE, submit);
        expect(submit).toHaveBeenCalledTimes(1);
        expect(out.conflicts).toHaveLength(1);
        const c = (await get("2026-11-02"))!;
        expect(c).toMatchObject({ state: "conflict", error: "ms.conflictConfirmed", conflict: { reason: "already_confirmed", server: { revision: 5, by: "Nimal" } } });
        expect(c.yours).toEqual({ [V1]: "4" });
        expect(out.waiting).toBe(1);
        expect((await get("2026-11-03"))?.state).toBe("pending");
        expect(isBlocked(await q.listQueued(SCOPE), (await get("2026-11-03"))!)).toBe(true);
      });

      it("'use my numbers' resends on top of the server's revision under a NEW key (the old key was answered with a conflict)", async () => {
        await q.enqueueCount(entry("2026-11-02"));
        await q.syncQueue(SCOPE, async () => conflict("revision", serverCopy("draft", 7)));
        const before = (await get("2026-11-02"))!;
        const after = (await q.resubmitOnTopOfServer(before.id))!;
        expect(after).toMatchObject({ state: "pending", attempts: 0, error: undefined, conflict: undefined });
        expect(after.payload.revision).toBe(7);
        expect(after.key).not.toBe(before.key);
        expect(after.key.length).toBeGreaterThanOrEqual(8);

        const submit = vi.fn<SubmitFn>().mockResolvedValue(ok(8));
        await q.syncQueue(SCOPE, submit);
        expect(submit.mock.calls[0][0].payload.revision).toBe(7);
        expect(await q.listQueued(SCOPE)).toEqual([]);
      });

      it("a draft that was removed elsewhere resends as a fresh count (no base revision)", async () => {
        await q.enqueueCount(entry("2026-11-02", { payload: { businessDate: "2026-11-02", revision: 4, items: [] } }));
        await q.syncQueue(SCOPE, async () => conflict("revision", null));
        expect((await q.resubmitOnTopOfServer(queueId(SCOPE, "2026-11-02")))?.payload.revision).toBeNull();
      });

      it("a rule violation fails the entry (kept, with the reason) instead of retrying forever, and 'try again' re-queues it", async () => {
        await q.enqueueCount(entry("2026-11-02"));
        const out = await q.syncQueue(SCOPE, async () => ({ ok: false, error: "ms.err.COUNT_OUT_OF_ORDER" }));
        expect(out.failed).toHaveLength(1);
        expect(await get("2026-11-02")).toMatchObject({ state: "failed", error: "ms.err.COUNT_OUT_OF_ORDER" });
        expect(await q.retryQueued(queueId(SCOPE, "2026-11-02"))).toMatchObject({ state: "pending", attempts: 0 });
      });

      it("an unexplained server error is retried with the same key, then fails after 10 attempts", async () => {
        await q.enqueueCount(entry("2026-11-02"));
        const generic: SubmitFn = async () => ({ ok: false, error: "auth.error.generic" });
        for (let i = 0; i < 9; i++) await q.syncQueue(SCOPE, generic);
        expect(await get("2026-11-02")).toMatchObject({ state: "pending", attempts: 9 });
        await q.syncQueue(SCOPE, generic);
        expect(await get("2026-11-02")).toMatchObject({ state: "failed", attempts: 10 });
      });

      it("an entry discarded while a send was in flight is not resurrected", async () => {
        await q.enqueueCount(entry("2026-11-02"));
        await q.syncQueue(SCOPE, async (e) => { await q.removeQueued(e.id); return conflict("revision", serverCopy("draft")); });
        expect(await q.listQueued(SCOPE)).toEqual([]);
      });

      it("a failing update changes nothing (the read-modify-write is atomic)", async () => {
        await q.enqueueCount(entry("2026-11-02"));
        const before = await get("2026-11-02");
        const r = await q.updateQueued(queueId(SCOPE, "2026-11-02"), () => { throw new Error("boom"); });
        expect(r).toBeNull();
        expect(await get("2026-11-02")).toEqual(before);
      });
    });

    describe("conflicts found while online", () => {
      it("keeps this device's numbers as a conflict entry so they survive a reload", async () => {
        const r = await q.enqueueConflict(entry("2026-11-02"), "ms.conflictConfirmed", { reason: "already_confirmed", server: serverCopy("confirmed") });
        expect(r.ok).toBe(true);
        expect(await get("2026-11-02")).toMatchObject({ state: "conflict", yours: { [V1]: "4" }, conflict: { reason: "already_confirmed" } });
      });

      it("does not overwrite an entry already waiting for the same morning", async () => {
        await q.enqueueCount(entry("2026-11-02"));
        await q.syncQueue(SCOPE, async () => { throw new Error("down"); });
        expect(await q.enqueueConflict(entry("2026-11-02", { key: "key-other-aaaaaaa" }), "ms.conflict", undefined)).toEqual({ ok: false, reason: "exists" });
      });
    });

    describe("helpers", () => {
      it("turns a queued payload back into form fields (nothing typed is lost when the person edits again)", () => {
        const unit = "00000000-0000-4000-8000-0000000000b1";
        expect(draftValuesFromPayload([
          { variantId: V1, entries: [{ unitId: unit, quantity: "7" }, { unitId: null, quantity: "5" }] },
          { variantId: V2, entries: [{ unitId: null, quantity: "2.5" }] },
        ])).toEqual({ [V1]: { [unit]: "7", [BASE_KEY]: "5" }, [V2]: { [BASE_KEY]: "2.5" } });
      });

      it("clearAllQueued empties the queue (sign-out on a shared device)", async () => {
        await q.enqueueCount(entry("2026-11-02"));
        await q.clearAllQueued();
        expect(await q.listQueued(SCOPE)).toEqual([]);
      });
    });
  });
}
