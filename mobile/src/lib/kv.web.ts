/** Browser test build of the key-value store: localStorage. (Real phones use SQLite: see kv.ts.) */
const ok = <T,>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };

export const kvGet = async (key: string): Promise<string | null> => ok(() => localStorage.getItem(`stokia.kv.${key}`), null);
export const kvSet = async (key: string, value: string): Promise<boolean> => ok(() => { localStorage.setItem(`stokia.kv.${key}`, value); return true; }, false);
export const kvRemove = async (key: string): Promise<void> => ok(() => localStorage.removeItem(`stokia.kv.${key}`), undefined);
export const kvRemovePrefix = async (prefix: string): Promise<void> =>
  ok(() => { for (const k of Object.keys(localStorage)) if (k.startsWith(`stokia.kv.${prefix}`)) localStorage.removeItem(k); }, undefined);

export async function kvGetJson<T>(key: string): Promise<T | null> {
  const raw = await kvGet(key);
  if (raw === null) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}
export const kvSetJson = (key: string, value: unknown) => kvSet(key, JSON.stringify(value));
