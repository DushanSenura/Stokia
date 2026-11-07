import { describe, expect, it, vi } from "vitest";
import type { CountResult } from "@/features/inventory/count-types";
import { confirmOrQueue, type ConfirmFlowArgs } from "@/lib/offline/confirm-flow";
import type { EnqueueResult, NewQueuedCount } from "@/lib/offline/queue-engine";

const input: NewQueuedCount = {
  scope: "shop:user", businessDate: "2026-11-07", ack: true, key: "key-0123456789",
  payload: { businessDate: "2026-11-07", revision: null, items: [] }, labels: {}, yours: {},
};
const okResult: CountResult = { ok: true, sessionId: "s1", revision: 3, counted: 1, confirmed: true };
const conflictResult: CountResult = { ok: false, error: "ms.conflictConfirmed", conflict: true, conflictInfo: { reason: "already_confirmed", server: null } };
const queuedOk = (): Promise<EnqueueResult> => Promise.resolve({ ok: true, entry: { ...input, id: "x", state: "pending", attempts: 0, createdAt: 0, lastTriedAt: null } });

function setup(over: Partial<ConfirmFlowArgs> = {}) {
  const args = {
    online: true, canQueue: true,
    submit: vi.fn<() => Promise<CountResult>>().mockResolvedValue(okResult),
    queueInput: vi.fn(() => input),
    enqueue: vi.fn(queuedOk),
    recordConflict: vi.fn(queuedOk),
    ...over,
  } satisfies ConfirmFlowArgs;
  return args;
}

describe("confirmOrQueue: with a connection", () => {
  it("the server's answer wins, and nothing is stored on the device (the queue input is not even built)", async () => {
    const a = setup();
    expect(await confirmOrQueue(a)).toEqual({ kind: "confirmed", result: okResult });
    expect(a.enqueue).not.toHaveBeenCalled();
    expect(a.queueInput).not.toHaveBeenCalled();
  });

  it("a plain refusal (a rule, a permission) is reported as is and is not queued", async () => {
    const refused: CountResult = { ok: false, error: "ms.err.COUNT_OUT_OF_ORDER" };
    const a = setup({ submit: vi.fn().mockResolvedValue(refused) });
    expect(await confirmOrQueue(a)).toEqual({ kind: "rejected", result: refused });
    expect(a.enqueue).not.toHaveBeenCalled();
    expect(a.recordConflict).not.toHaveBeenCalled();
  });

  it("a conflict keeps this device's numbers next to the server's copy, then reports the conflict", async () => {
    const a = setup({ submit: vi.fn().mockResolvedValue(conflictResult) });
    expect(await confirmOrQueue(a)).toEqual({ kind: "conflict", result: conflictResult });
    expect(a.recordConflict).toHaveBeenCalledWith(input, "ms.conflictConfirmed", { reason: "already_confirmed", server: null });
    expect(a.enqueue).not.toHaveBeenCalled();
  });

  it("a conflict is still reported when there is nowhere to keep the numbers (but nothing is recorded)", async () => {
    const a = setup({ canQueue: false, submit: vi.fn().mockResolvedValue(conflictResult) });
    expect((await confirmOrQueue(a)).kind).toBe("conflict");
    expect(a.recordConflict).not.toHaveBeenCalled();
  });
});

describe("confirmOrQueue: no answer from the server", () => {
  it("offline: never even tries, and keeps the count on the device (not confirmed)", async () => {
    const a = setup({ online: false });
    expect(await confirmOrQueue(a)).toEqual({ kind: "queued" });
    expect(a.submit).not.toHaveBeenCalled();
    expect(a.enqueue).toHaveBeenCalledWith(input);
  });

  it("a request that throws (network failure, server error) is kept on the device too, under the same input and key", async () => {
    const a = setup({ submit: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")) });
    expect(await confirmOrQueue(a)).toEqual({ kind: "queued" });
    expect(a.enqueue).toHaveBeenCalledWith(expect.objectContaining({ key: "key-0123456789" }));
  });

  it("says why it could not keep it: an earlier copy may already have reached the server, or storage is unavailable", async () => {
    const exists = setup({ online: false, enqueue: vi.fn().mockResolvedValue({ ok: false, reason: "exists" }) });
    expect(await confirmOrQueue(exists)).toEqual({ kind: "queue_failed", reason: "exists" });
    const broken = setup({ online: false, enqueue: vi.fn().mockResolvedValue({ ok: false, reason: "unavailable" }) });
    expect(await confirmOrQueue(broken)).toEqual({ kind: "queue_failed", reason: "unavailable" });
  });

  it("with nowhere to keep it, it is reported as unavailable instead of pretending it was saved", async () => {
    const a = setup({ online: false, canQueue: false });
    expect(await confirmOrQueue(a)).toEqual({ kind: "queue_failed", reason: "unavailable" });
    expect(a.enqueue).not.toHaveBeenCalled();
  });
});
