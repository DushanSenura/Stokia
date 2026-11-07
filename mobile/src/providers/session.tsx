import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import type { MessageKey } from "@/i18n";
import { ApiSignedOut, ApiUnreachable, type MeResponse, type Membership } from "~/lib/api-client";
import { api } from "~/lib/api";
import { isConfigured } from "~/lib/config";
import { kvGet, kvGetJson, kvRemove, kvRemovePrefix, kvSet, kvSetJson } from "~/lib/kv";
import { getSupabase } from "~/lib/supabase";
import type { MobileKey } from "~/i18n/mobile-strings";
import { queue } from "~/offline/queue";

/**
 * Who is signed in, and which shop they are working in.
 *  - `loading`   deciding (reading the stored session, loading the profile)
 *  - `signedOut` show the sign-in screen
 *  - `ready`     signed in and a shop is chosen
 *  - `problem`   signed in, but cannot continue: not in any shop yet, or the profile cannot be loaded and nothing is saved on the phone
 */
export type SessionStatus = "loading" | "signedOut" | "ready" | "problem";
export interface SessionApi {
  status: SessionStatus;
  problem: "noShop" | "unreachable" | null;
  user: MeResponse["user"] | null;
  shop: Membership | null;
  memberships: Membership[];
  selectShop: (shopId: string) => void;
  signIn: (email: string, password: string) => Promise<{ ok: true } | { ok: false; error: MessageKey | MobileKey }>;
  /** Signs out and removes this phone's copy of the shop's data (unsent counts included: the caller warns first). */
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
}

const Ctx = createContext<SessionApi | null>(null);
const ME_KEY = "cache.me";
const SHOP_KEY = "pref.shop";

export function SessionProvider({ children }: { children: React.ReactNode }) {
  // Without a server address there is nothing to load: start on the sign-in screen (which explains why it cannot sign in).
  const [status, setStatus] = useState<SessionStatus>(isConfigured ? "loading" : "signedOut");
  const [problem, setProblem] = useState<SessionApi["problem"]>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [shopId, setShopId] = useState<string | null>(null);
  const loading = useRef(false);

  const applyMe = useCallback(async (data: MeResponse) => {
    setMe(data);
    if (data.memberships.length === 0) { setProblem("noShop"); setStatus("problem"); return; }
    const saved = await kvGet(SHOP_KEY);
    const chosen = data.memberships.find((m) => m.shopId === saved) ?? data.memberships[0];
    setShopId(chosen.shopId);
    setProblem(null);
    setStatus("ready");
  }, []);

  const signedOut = useCallback(() => { setMe(null); setShopId(null); setProblem(null); setStatus("signedOut"); }, []);

  const wipeLocal = useCallback(async () => {
    await queue.clearAllQueued();
    await kvRemovePrefix("draft.");
    await kvRemovePrefix("cache.");
  }, []);

  /** Load the profile. With no connection, the copy saved on this phone is used (only for the SAME signed-in user). */
  const loadMe = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const { data } = await getSupabase().auth.getSession();
      const session = data.session;
      if (!session) { signedOut(); return; }
      try {
        const fresh = await api.me();
        await kvSetJson(ME_KEY, fresh);
        await applyMe(fresh);
      } catch (e) {
        if (e instanceof ApiSignedOut) { await getSupabase().auth.signOut().catch(() => undefined); await wipeLocal(); signedOut(); return; }
        const cached = await kvGetJson<MeResponse>(ME_KEY);
        if (e instanceof ApiUnreachable && cached && cached.user.id === session.user.id) await applyMe(cached);
        else { setProblem("unreachable"); setStatus("problem"); }
      }
    } finally {
      loading.current = false;
    }
  }, [applyMe, signedOut, wipeLocal]);

  useEffect(() => {
    if (!isConfigured) return;
    void loadMe();
    const { data: sub } = getSupabase().auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") signedOut(); });
    // The session token only refreshes itself while the app is in the foreground.
    const app = AppState.addEventListener("change", (s) => {
      if (s === "active") getSupabase().auth.startAutoRefresh(); else getSupabase().auth.stopAutoRefresh();
    });
    return () => { sub.subscription.unsubscribe(); app.remove(); };
  }, [loadMe, signedOut]);

  const signIn = useCallback<SessionApi["signIn"]>(async (email, password) => {
    if (!isConfigured) return { ok: false, error: "m.notConfigured" };
    try {
      const { error } = await getSupabase().auth.signInWithPassword({ email: email.trim(), password });
      if (error) {
        if (error.status === 429) return { ok: false, error: "auth.error.rateLimit" };
        if (error.status === 400 || error.status === 401 || /invalid/i.test(error.message)) return { ok: false, error: "auth.error.invalid" };
        return { ok: false, error: "m.signin.loadFailed" };
      }
    } catch {
      return { ok: false, error: "m.signin.loadFailed" };
    }
    setStatus("loading");
    await loadMe();
    return { ok: true };
  }, [loadMe]);

  const signOut = useCallback(async () => {
    await getSupabase().auth.signOut().catch(() => undefined);
    await wipeLocal();
    await kvRemove(ME_KEY);
    signedOut();
  }, [signedOut, wipeLocal]);

  const selectShop = useCallback((id: string) => { setShopId(id); void kvSet(SHOP_KEY, id); }, []);

  const value = useMemo<SessionApi>(() => ({
    status, problem, user: me?.user ?? null, memberships: me?.memberships ?? [],
    shop: me?.memberships.find((m) => m.shopId === shopId) ?? null,
    selectShop, signIn, signOut, reload: async () => { setStatus("loading"); await loadMe(); },
  }), [status, problem, me, shopId, selectShop, signIn, signOut, loadMe]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSession must be used inside SessionProvider");
  return c;
}
