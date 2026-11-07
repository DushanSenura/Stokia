import type { FieldValues } from "@/features/inventory/count-entry";
import { createStore, done, wrap } from "./idb";

/**
 * A safety copy of an in-progress morning count, kept in this browser's IndexedDB so a dropped connection,
 * a closed tab or a flat battery does not lose an hour of counting. The server copy always wins once it has
 * the data; this is only ever a fallback. Every call fails soft: no IndexedDB (private window, blocked) = no-op.
 */
export interface LocalDraft {
  key: string;
  scope: string;
  businessDate: string;
  values: Record<string, FieldValues>;
  /** The server revision the user was editing against (null = no server draft existed yet). */
  baseRevision: number | null;
  savedAt: number;
}

const STORE = "drafts";
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const keyOf = (scope: string, businessDate: string) => `${scope}|${businessDate}`;

const { run } = createStore("stokia-drafts", STORE);
export function saveLocalDraft(d: Omit<LocalDraft, "key" | "savedAt">): Promise<boolean> {
  return run(async (db) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ ...d, key: keyOf(d.scope, d.businessDate), savedAt: Date.now() } satisfies LocalDraft);
    await done(tx);
    return true;
  }, false);
}

export function loadLocalDraft(scope: string, businessDate: string): Promise<LocalDraft | null> {
  return run(async (db) => {
    const row = (await wrap(db.transaction(STORE).objectStore(STORE).get(keyOf(scope, businessDate)))) as LocalDraft | undefined;
    if (!row) return null;
    if (Date.now() - row.savedAt > MAX_AGE_MS) { await clearNow(db, row.key); return null; }
    return row;
  }, null);
}

async function clearNow(db: IDBDatabase, key: string) {
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(key);
  await done(tx);
}

export function clearLocalDraft(scope: string, businessDate: string): Promise<void> {
  return run((db) => clearNow(db, keyOf(scope, businessDate)), undefined);
}

/** For sign-out on a shared device: nothing of this shop's counts should stay behind. */
export function clearAllLocalDrafts(): Promise<void> {
  return run(async (db) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await done(tx);
  }, undefined);
}
