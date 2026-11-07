import type { QueuedCount, QueueStore } from "@/lib/offline/queue-engine";

/**
 * The offline queue for the BROWSER test build of the phone app: one localStorage entry holding all queued counts. Real phones use
 * SQLite (`sqlite-store.ts`). Reads and writes are serialised so a read-modify-write is atomic within the page.
 */
export function createLocalStorageQueueStore(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, key = "stokia.queue"): QueueStore {
  const read = (): Record<string, QueuedCount> => {
    try { return JSON.parse(storage.getItem(key) ?? "{}") as Record<string, QueuedCount>; } catch { return {}; }
  };
  const write = (rows: Record<string, QueuedCount>) => storage.setItem(key, JSON.stringify(rows));
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T,>(fn: () => Promise<T> | T): Promise<T> => {
    const next = chain.then(fn);
    chain = next.catch(() => undefined);
    return next;
  };

  return {
    list: (scope) => serial(() => Object.values(read()).filter((e) => e.scope === scope)).catch(() => []),
    transact: (fn, fallback) =>
      serial(async () => {
        const rows = read();
        const staged: Record<string, QueuedCount> = { ...rows };
        const result = await fn({ get: async (id) => staged[id], put: (e) => { staged[e.id] = e; } });
        write(staged); // only reached if `fn` did not throw: a failing update changes nothing
        return result;
      }).catch(() => fallback),
    remove: (id) => serial(() => { const rows = read(); delete rows[id]; write(rows); }).catch(() => undefined),
    clear: () => serial(() => { storage.removeItem(key); }).catch(() => undefined),
  };
}
