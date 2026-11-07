import type { MovementDraft } from "@/features/movements/phone-types";
import type { MessageKey } from "@/i18n";

/**
 * Stock movements entered while the phone could not reach the server. Storage-agnostic, like the count queue
 * (`queue-engine.ts`), and with the same safety rules, but a separate, simpler queue because a movement is not a sealed morning
 * document: several can wait, they are independent, and one that is refused must not hold the others back.
 *
 *  - A queued movement is NEVER shown as recorded. Only the server's answer makes it so.
 *  - Every entry carries the idempotency key it is sent with (its id IS the key). A replay returns the original: it cannot record twice.
 *  - An entry is marked "maybe sent" BEFORE it is sent. A crash mid-send therefore cannot lead to it being discarded or replaced
 *    while the server may already have applied it.
 *  - No answer (offline, a timeout) keeps the entry and stops the run. An answer that refuses it (a rule, a deactivated product,
 *    a missing reason) keeps it too, marked failed WITH the reason, so nothing the person entered is silently lost.
 *  - Only a confirmed answer, or the person's explicit choice, removes an entry (and the person cannot discard one that may have
 *    reached the server).
 *  - The moment it happened is fixed when it is entered (see `queuedDraft`), so sending it hours later still lands at the right time.
 */
export type QueuedMovementState = "pending" | "failed";

export interface QueuedMovement {
  /** Equal to `key`. */
  id: string;
  scope: string;
  key: string;
  payload: MovementDraft;
  /** What the list shows, kept so it can be drawn with no network. */
  summary: { label: string; baseUnit: string; /** signed effect on stock, base unit */ effect: string; /** e.g. "3 Bundle" */ entered: string };
  state: QueuedMovementState;
  /** True from just before the first send until the server clearly refuses it: it may have been applied. */
  maybeSent: boolean;
  attempts: number;
  createdAt: number;
  lastTriedAt: number | null;
  error?: MessageKey;
  fieldErrors?: Record<string, MessageKey>;
}

export type NewQueuedMovement = Pick<QueuedMovement, "scope" | "key" | "payload" | "summary">;
export type EnqueueMovementResult = { ok: true; entry: QueuedMovement } | { ok: false; reason: "unavailable" };
/** The server's answer. A thrown error means NO answer. */
export type MovementAnswer = { ok: true; id: string; duplicate: boolean } | { ok: false; error?: MessageKey; fieldErrors?: Record<string, MessageKey> };
export type SubmitMovementFn = (entry: QueuedMovement) => Promise<MovementAnswer>;

export interface MovementSyncOutcome {
  /** Recorded by the server (including "already recorded": a replay that found the original). */
  confirmed: QueuedMovement[];
  failed: QueuedMovement[];
  /** Still waiting: offline, a temporary server problem, or told to wait. */
  waiting: number;
  unreachable: boolean;
}

export interface MovementTx {
  get(id: string): Promise<QueuedMovement | undefined>;
  put(entry: QueuedMovement): void | Promise<void>;
}
export interface MovementStore {
  list(scope: string): Promise<QueuedMovement[]>;
  /** One atomic read-modify-write. Resolves to `fallback` if storage is unavailable or the transaction fails. */
  transact<T>(fn: (tx: MovementTx) => Promise<T>, fallback: T): Promise<T>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

export const MAX_MOVEMENT_ATTEMPTS = 10;
const byAge = (a: QueuedMovement, b: QueuedMovement) => a.createdAt - b.createdAt || a.id.localeCompare(b.id);

export interface MovementQueueDeps { now?: () => number }
export interface SyncOptions {
  /**
   * Called for a refusal: return true to keep the entry pending instead of failing it. Used for "before the count" when that
   * morning's count has not reached the server yet (it is waiting in the count queue): the movement waits for it.
   */
  shouldWait?: (entry: QueuedMovement, answer: Extract<MovementAnswer, { ok: false }>) => boolean;
}

export function createMovementQueue(store: MovementStore, deps: MovementQueueDeps = {}) {
  const now = deps.now ?? Date.now;
  const list = (scope: string) => store.list(scope).then((rows) => [...rows].sort(byAge));

  const enqueue = (input: NewQueuedMovement): Promise<EnqueueMovementResult> =>
    store.transact<EnqueueMovementResult>(async (tx) => {
      const existing = await tx.get(input.key);
      if (existing) return { ok: true, entry: existing }; // the same entry saved twice (a double tap) is one entry
      const entry: QueuedMovement = { ...input, id: input.key, state: "pending", maybeSent: false, attempts: 0, createdAt: now(), lastTriedAt: null };
      await tx.put(entry);
      return { ok: true, entry };
    }, { ok: false, reason: "unavailable" });

  const update = (id: string, change: (e: QueuedMovement) => QueuedMovement): Promise<QueuedMovement | null> =>
    store.transact<QueuedMovement | null>(async (tx) => {
      const row = await tx.get(id);
      if (!row) return null;
      const next = change(row);
      await tx.put(next);
      return next;
    }, null);

  /** Whether the person may delete this entry: not if the server may already have applied it. */
  const canDiscard = (e: QueuedMovement) => !e.maybeSent;

  /** Remove an entry at the person's request. Refuses (false) one that may have reached the server. */
  async function discard(id: string): Promise<boolean> {
    const row = await store.transact<QueuedMovement | undefined>((tx) => tx.get(id), undefined);
    if (!row || !canDiscard(row)) return false;
    await store.remove(id);
    return true;
  }

  /** "Try again" on a refused entry. */
  const retry = (id: string) => update(id, (e) => (e.state === "failed" ? { ...e, state: "pending", error: undefined, fieldErrors: undefined, attempts: 0 } : e));

  let inFlight: Promise<MovementSyncOutcome> | null = null;
  /** One run at a time; a second caller shares the first run's result. */
  function sync(scope: string, submit: SubmitMovementFn, opts: SyncOptions = {}): Promise<MovementSyncOutcome> {
    if (inFlight) return inFlight;
    inFlight = doSync(scope, submit, opts).finally(() => { inFlight = null; });
    return inFlight;
  }

  async function doSync(scope: string, submit: SubmitMovementFn, opts: SyncOptions): Promise<MovementSyncOutcome> {
    const out: MovementSyncOutcome = { confirmed: [], failed: [], waiting: 0, unreachable: false };
    const rows = await list(scope);
    for (let i = 0; i < rows.length; i++) {
      const e = rows[i];
      if (e.state !== "pending") continue;

      // Mark as maybe-sent BEFORE sending: if the app dies mid-request, this entry can no longer be discarded or replaced.
      const sending = await update(e.id, (x) => ({ ...x, maybeSent: true, attempts: x.attempts + 1, lastTriedAt: now() }));
      if (!sending) continue; // discarded meanwhile

      let res: MovementAnswer;
      try {
        res = await submit(sending);
      } catch {
        // No answer: it may or may not have been applied. The SAME key is replayed next time, which is exactly the safe thing.
        out.unreachable = true;
        out.waiting += 1 + rows.slice(i + 1).filter((o) => o.state === "pending").length;
        return out;
      }

      if (res.ok) { await store.remove(e.id); out.confirmed.push(sending); continue; }

      if (opts.shouldWait?.(sending, res)) {
        // Clearly refused for now, so nothing was applied: it can be discarded, and it will be tried again.
        await update(e.id, (x) => ({ ...x, maybeSent: false }));
        out.waiting++;
        continue;
      }
      if (res.error === "auth.error.generic" && sending.attempts < MAX_MOVEMENT_ATTEMPTS) {
        out.unreachable = true; // an unexplained server error: keep trying, with the same key
        out.waiting += 1 + rows.slice(i + 1).filter((o) => o.state === "pending").length;
        return out;
      }
      const f = await update(e.id, (x) => ({ ...x, state: "failed", maybeSent: false, error: res.error, fieldErrors: res.fieldErrors }));
      if (f) out.failed.push(f);
    }
    return out;
  }

  return { list, enqueue, update, discard, canDiscard, retry, sync, clear: () => store.clear() };
}
