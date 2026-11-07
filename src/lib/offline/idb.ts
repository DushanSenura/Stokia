/**
 * Tiny IndexedDB helper shared by the on-device draft store and the sync queue.
 * Every call fails soft: no IndexedDB (private window, blocked, old browser) means the caller's fallback value is returned.
 */
export const wrap = <T,>(req: IDBRequest<T>) => new Promise<T>((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
export const done = (tx: IDBTransaction) => new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

export function createStore(dbName: string, storeName: string, keyPath = "key") {
  function open(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
      try {
        if (typeof indexedDB === "undefined") return resolve(null);
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(storeName, { keyPath });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  /** Operations run strictly in call order, so a late "save" can never land after a "clear". */
  let queue: Promise<unknown> = Promise.resolve();
  function run<T>(fn: (db: IDBDatabase) => Promise<T>, fallback: T): Promise<T> {
    const next = queue.then(async () => {
      const db = await open();
      if (!db) return fallback;
      try { return await fn(db); } catch { return fallback; } finally { db.close(); }
    });
    queue = next.catch(() => undefined);
    return next;
  }

  return { run, storeName };
}
