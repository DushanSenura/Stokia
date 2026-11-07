import { openDriver } from "~/offline/db";

/**
 * A tiny key-value store on the phone's SQLite: preferences (language, theme, chosen shop), the on-device copy of an unfinished
 * count, and the last downloaded screens (so the app is still useful with no connection). Every call fails soft.
 * Nothing here is a secret: the sign-in session lives in the secure store, not here.
 */
let ready: Promise<void> | null = null;
const init = () => (ready ??= openDriver().then((d) => d.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);")).catch((e) => { ready = null; throw e; }));

export async function kvGet(key: string): Promise<string | null> {
  try {
    await init();
    const rows = await (await openDriver()).all<{ value: string }>("SELECT value FROM kv WHERE key = ?", [key]);
    return rows[0]?.value ?? null;
  } catch { return null; }
}

export async function kvSet(key: string, value: string): Promise<boolean> {
  try {
    await init();
    await (await openDriver()).run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
    return true;
  } catch { return false; }
}

export async function kvRemove(key: string): Promise<void> {
  try { await init(); await (await openDriver()).run("DELETE FROM kv WHERE key = ?", [key]); } catch { /* storage unavailable */ }
}

/** Remove everything whose key starts with `prefix` (sign-out on a shared phone). */
export async function kvRemovePrefix(prefix: string): Promise<void> {
  try { await init(); await (await openDriver()).run("DELETE FROM kv WHERE key LIKE ? ESCAPE '\\'", [`${prefix.replace(/[\\%_]/g, "\\$&")}%`]); } catch { /* storage unavailable */ }
}

export async function kvGetJson<T>(key: string): Promise<T | null> {
  const raw = await kvGet(key);
  if (raw === null) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}
export const kvSetJson = (key: string, value: unknown) => kvSet(key, JSON.stringify(value));
