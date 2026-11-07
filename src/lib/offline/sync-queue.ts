import { createStore, done, wrap } from "./idb";
import { newIdempotencyKey } from "./idempotency";
import { createQueue, type QueuedCount, type QueueStore } from "./queue-engine";

/**
 * Web binding of the offline queue: IndexedDB underneath, the shared rules (`queue-engine.ts`) on top. The phone app binds the
 * same engine to SQLite. See `queue-engine.ts` for the rules and the reasons behind them.
 */
export {
  MAX_ATTEMPTS, draftValuesFromPayload, isBlocked, queueId,
  type EnqueueResult, type NewQueuedCount, type QueuedCount, type QueuedState, type SubmitFn, type SyncOutcome,
} from "./queue-engine";

const STORE = "counts";
const { run } = createStore("stokia-sync", STORE, "id");

const idbStore: QueueStore = {
  list: (scope) =>
    run(async (db) => {
      const rows = (await wrap(db.transaction(STORE).objectStore(STORE).getAll())) as QueuedCount[];
      return rows.filter((r) => r.scope === scope);
    }, [] as QueuedCount[]),

  transact: (fn, fallback) =>
    run(async (db) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const result = await fn({ get: async (id) => (await wrap(store.get(id))) as QueuedCount | undefined, put: (e) => void store.put(e) });
      await done(tx);
      return result;
    }, fallback),

  remove: (id) =>
    run(async (db) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      await done(tx);
    }, undefined),

  clear: () =>
    run(async (db) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      await done(tx);
    }, undefined),
};

export const {
  listQueued, enqueueCount, enqueueConflict, updateQueued, removeQueued, clearAllQueued, resubmitOnTopOfServer, retryQueued, syncQueue,
} = createQueue(idbStore, { newKey: newIdempotencyKey });

/** A short, human label for the audit trail ("Web app on Android"). Never anything identifying. */
export function deviceLabel(): string {
  if (typeof navigator === "undefined") return "Server";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || "device";
  const standalone = typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)").matches;
  return `${standalone ? "Installed app" : "Browser"} on ${platform}`.slice(0, 100);
}
