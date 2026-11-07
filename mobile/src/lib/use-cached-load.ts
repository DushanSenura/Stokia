import { useCallback, useEffect, useState } from "react";
import { ApiSignedOut } from "./api-client";
import { kvGetJson, kvSetJson } from "./kv";
import { useSession } from "~/providers/session";

interface Saved<T> { data: T; savedAt: number }

/**
 * Load something from the server, keep a copy on the phone, and fall back to that copy when the server cannot be reached.
 *  - `savedAt` is non-null ONLY while showing the saved copy (so the screen can say so);
 *  - `failed` says the last attempt did not reach the server;
 *  - `loader` must be stable (wrap it in useCallback) because a new one means "load again";
 *  - `reloadToken` loads again when it changes (for example after a queued count was confirmed).
 * The copies live under the `cache.` prefix, which sign-out removes.
 */
export function useCachedLoad<T>(key: string, loader: () => Promise<T>, reloadToken = 0) {
  const { signOut } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const fresh = await loader();
      setData(fresh); setSavedAt(null); setFailed(false);
      await kvSetJson(key, { data: fresh, savedAt: Date.now() } satisfies Saved<T>);
    } catch (e) {
      if (e instanceof ApiSignedOut) { await signOut(); return; }
      const saved = await kvGetJson<Saved<T>>(key);
      if (saved) { setData(saved.data); setSavedAt(saved.savedAt); }
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [key, loader, signOut]);

  useEffect(() => {
    let live = true;
    void (async () => { if (live) await load(); })();
    return () => { live = false; };
  }, [load, reloadToken]);

  /** Pull-to-refresh / retry: show the spinner again, then load. */
  const refresh = useCallback(() => { setLoading(true); return load(); }, [load]);
  return { data, savedAt, loading, failed, refresh };
}
