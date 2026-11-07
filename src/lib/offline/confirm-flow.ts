import type { CountConflict, CountResult } from "@/features/inventory/count-types";
import type { MessageKey } from "@/i18n";
import type { EnqueueResult, NewQueuedCount } from "./queue-engine";

/**
 * What to do when the person presses "Confirm count". One decision, shared by the web form and the phone app:
 *
 *  - online and the server answers  -> confirmed, a conflict, or a plain refusal;
 *  - offline, or the request gets NO answer -> keep the count on the device under the SAME idempotency key it was sent with, so
 *    that if the server did apply it, replaying it later applies nothing twice. It is NOT confirmed until the server says so;
 *  - a conflict with another device -> keep this device's numbers next to the server's copy so a reload cannot lose them.
 */
export type ConfirmOutcome =
  | { kind: "confirmed"; result: Extract<CountResult, { ok: true }> }
  | { kind: "queued" }
  | { kind: "queue_failed"; reason: "exists" | "unavailable" }
  | { kind: "conflict"; result: Extract<CountResult, { ok: false }> }
  | { kind: "rejected"; result: Extract<CountResult, { ok: false }> };

export interface ConfirmFlowArgs {
  /** What the platform believes about its connection. `false` skips the attempt entirely. */
  online: boolean;
  /** Is there somewhere to keep a count on this device? (No scope / no storage means no.) */
  canQueue: boolean;
  /** Send to the server. Must THROW when there is no answer (network failure, 5xx) and return the server's answer otherwise. */
  submit: () => Promise<CountResult>;
  /** Built lazily: only needed if the count has to be kept on the device. */
  queueInput: () => NewQueuedCount;
  enqueue: (input: NewQueuedCount) => Promise<EnqueueResult>;
  recordConflict: (input: NewQueuedCount, error: MessageKey, conflict: CountConflict | undefined) => Promise<EnqueueResult>;
}

export async function confirmOrQueue(a: ConfirmFlowArgs): Promise<ConfirmOutcome> {
  let res: CountResult | null = null;
  if (a.online) {
    try { res = await a.submit(); } catch { res = null; }
  }

  if (res === null) {
    if (!a.canQueue) return { kind: "queue_failed", reason: "unavailable" };
    const queued = await a.enqueue(a.queueInput());
    return queued.ok ? { kind: "queued" } : { kind: "queue_failed", reason: queued.reason };
  }
  if (res.ok) return { kind: "confirmed", result: res };
  if (res.conflict) {
    if (a.canQueue) await a.recordConflict(a.queueInput(), res.error, res.conflictInfo);
    return { kind: "conflict", result: res };
  }
  return { kind: "rejected", result: res };
}
