import { BASE_KEY, type FieldValues } from "@/features/inventory/count-entry";
import type { CountConflict, CountInput, CountResult } from "@/features/inventory/count-types";
import type { MessageKey } from "@/i18n";

/**
 * The rules for counts that could not reach the server (offline, dropped connection). Storage-agnostic: the web app plugs
 * in IndexedDB, the phone app plugs in SQLite, and BOTH run exactly this code, so the rules cannot drift between them.
 *
 * A queued count is NEVER shown as confirmed: only the server's answer makes it so.
 *
 * Safety rules:
 *  - every entry carries the idempotency key it will be sent with, so replays can never apply a count twice;
 *  - an entry is marked as "attempted" BEFORE it is sent, so a crash mid-send cannot lead to it being replaced and re-sent
 *    with different numbers under a different key (which would hide the first, possibly applied, submission);
 *  - counts are sent strictly in date order and the queue stops at the first one that is not resolved, because the server
 *    refuses to confirm a count dated before an already confirmed one;
 *  - nothing is ever deleted automatically: only a confirmed answer, or the person's explicit choice, removes an entry.
 */
export type QueuedState = "pending" | "conflict" | "failed";

export interface QueuedCount {
  /** `${scope}|${businessDate}`: at most one waiting count per shop, user and morning. */
  id: string;
  scope: string;
  businessDate: string;
  payload: CountInput;
  ack: boolean;
  /** The idempotency key this entry is sent with. Changes only when the person resolves a conflict with "use mine". */
  key: string;
  /** For the conflict screen: what each counted product was called and counted in, and what this device recorded. */
  labels: Record<string, { name: string; unit: string }>;
  yours: Record<string, string>;
  state: QueuedState;
  attempts: number;
  createdAt: number;
  lastTriedAt: number | null;
  error?: MessageKey;
  conflict?: CountConflict;
}

export type NewQueuedCount = Pick<QueuedCount, "scope" | "businessDate" | "payload" | "ack" | "key" | "labels" | "yours">;
export type EnqueueResult = { ok: true; entry: QueuedCount } | { ok: false; reason: "exists" | "unavailable" };
export type SubmitFn = (entry: QueuedCount) => Promise<CountResult>;
export interface SyncOutcome {
  confirmed: QueuedCount[];
  conflicts: QueuedCount[];
  failed: QueuedCount[];
  /** Entries still waiting (offline, a temporary server problem, or behind an unresolved earlier morning). */
  waiting: number;
  /** The connection (or server) did not answer: try again later. */
  unreachable: boolean;
}

/** Operations inside one atomic transaction. */
export interface QueueTx {
  get(id: string): Promise<QueuedCount | undefined>;
  put(entry: QueuedCount): void | Promise<void>;
}

/** What a platform must provide. Every method must fail soft (return the fallback) when storage is unavailable. */
export interface QueueStore {
  list(scope: string): Promise<QueuedCount[]>;
  /** Run `fn` as ONE atomic read-modify-write. Resolves to `fallback` if storage is unavailable or the transaction fails. */
  transact<T>(fn: (tx: QueueTx) => Promise<T>, fallback: T): Promise<T>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

export const MAX_ATTEMPTS = 10;
export const queueId = (scope: string, businessDate: string) => `${scope}|${businessDate}`;
const byDate = (a: QueuedCount, b: QueuedCount) => a.businessDate.localeCompare(b.businessDate);

/** True when an earlier morning is still unresolved, so this one has to wait its turn. */
export function isBlocked(entries: QueuedCount[], e: QueuedCount): boolean {
  return entries.some((o) => o.id !== e.id && o.businessDate < e.businessDate && o.state !== "pending");
}

/** Turn a queued payload back into form fields so the person can edit it again (nothing typed is lost). */
export function draftValuesFromPayload(items: CountInput["items"]): Record<string, FieldValues> {
  const out: Record<string, FieldValues> = {};
  for (const it of items) {
    const f: FieldValues = {};
    for (const e of it.entries) f[e.unitId ?? BASE_KEY] = e.quantity;
    out[it.variantId] = f;
  }
  return out;
}

export interface QueueDeps {
  /** A fresh idempotency key (platform-specific randomness). */
  newKey: () => string;
  now?: () => number;
}

export function createQueue(store: QueueStore, deps: QueueDeps) {
  const now = deps.now ?? Date.now;

  const listQueued = (scope: string) => store.list(scope).then((rows) => [...rows].sort(byDate));

  const enqueueCount = (input: NewQueuedCount): Promise<EnqueueResult> =>
    store.transact<EnqueueResult>(async (tx) => {
      const id = queueId(input.scope, input.businessDate);
      const existing = await tx.get(id);
      // A copy that was already attempted (or is in conflict/failed) may have reached the server: never replace it silently.
      if (existing && (existing.attempts > 0 || existing.state !== "pending")) return { ok: false, reason: "exists" };
      const entry: QueuedCount = { ...input, id, state: "pending", attempts: 0, createdAt: now(), lastTriedAt: null };
      await tx.put(entry);
      return { ok: true, entry };
    }, { ok: false, reason: "unavailable" });

  /** Read-modify-write in one transaction. Returns the updated entry, or null if it no longer exists. */
  const updateQueued = (id: string, change: (e: QueuedCount) => QueuedCount): Promise<QueuedCount | null> =>
    store.transact<QueuedCount | null>(async (tx) => {
      const row = await tx.get(id);
      if (!row) return null;
      const next = change(row);
      await tx.put(next);
      return next;
    }, null);

  /**
   * A conflict discovered while online (another device got there first): keep this device's numbers as an entry in the
   * "conflict" state, so they survive a reload and the person can review them next to the server's copy.
   */
  async function enqueueConflict(input: NewQueuedCount, error: MessageKey, conflict: CountConflict | undefined): Promise<EnqueueResult> {
    const r = await enqueueCount(input);
    if (!r.ok) return r;
    const entry = await updateQueued(r.entry.id, (x) => ({ ...x, state: "conflict", attempts: 1, lastTriedAt: now(), error, conflict }));
    return entry ? { ok: true, entry } : { ok: false, reason: "unavailable" };
  }

  const removeQueued = (id: string) => store.remove(id);
  const clearAllQueued = () => store.clear();

  /**
   * "Use my numbers" after a conflict: send the same entries again on top of the server's current revision, under a NEW key
   * (the old key was answered with a conflict, and the server rejects one key used for different requests).
   */
  const resubmitOnTopOfServer = (id: string) =>
    updateQueued(id, (e) => ({
      ...e,
      payload: { ...e.payload, revision: e.conflict?.server?.revision ?? null },
      key: deps.newKey(),
      state: "pending", attempts: 0, lastTriedAt: null, error: undefined, conflict: undefined,
    }));

  /** "Try again" on a failed entry. */
  const retryQueued = (id: string) => updateQueued(id, (e) => ({ ...e, state: "pending", attempts: 0, error: undefined }));

  let inFlight: Promise<SyncOutcome> | null = null;

  /** One run at a time; a second caller shares the first run's result. */
  function syncQueue(scope: string, submit: SubmitFn): Promise<SyncOutcome> {
    if (inFlight) return inFlight;
    inFlight = doSync(scope, submit).finally(() => { inFlight = null; });
    return inFlight;
  }

  async function doSync(scope: string, submit: SubmitFn): Promise<SyncOutcome> {
    const out: SyncOutcome = { confirmed: [], conflicts: [], failed: [], waiting: 0, unreachable: false };
    let blocked = false;
    for (const e of await listQueued(scope)) {
      if (e.state !== "pending") { blocked = true; continue; }
      if (blocked) { out.waiting++; continue; }

      // Mark as attempted before sending: if the page dies mid-request, this entry can no longer be replaced.
      const sending = await updateQueued(e.id, (x) => ({ ...x, attempts: x.attempts + 1, lastTriedAt: now() }));
      if (!sending) continue; // discarded meanwhile

      let res: CountResult;
      try {
        res = await submit(sending);
      } catch {
        // No answer: the server may or may not have applied it. The SAME key is replayed next time, which is exactly the safe thing.
        out.unreachable = true; out.waiting++; blocked = true;
        continue;
      }

      if (res.ok) { await removeQueued(e.id); out.confirmed.push(sending); continue; }

      blocked = true;
      if (res.conflict) {
        const c = await updateQueued(e.id, (x) => ({ ...x, state: "conflict", error: res.error, conflict: res.conflictInfo }));
        if (c) out.conflicts.push(c);
      } else if (res.error === "auth.error.generic" && sending.attempts < MAX_ATTEMPTS) {
        out.waiting++; out.unreachable = true; // an unexplained server error: keep trying, with the same key
      } else {
        const f = await updateQueued(e.id, (x) => ({ ...x, state: "failed", error: res.error }));
        if (f) out.failed.push(f);
      }
    }
    return out;
  }

  return { listQueued, enqueueCount, enqueueConflict, updateQueued, removeQueued, clearAllQueued, resubmitOnTopOfServer, retryQueued, syncQueue };
}
