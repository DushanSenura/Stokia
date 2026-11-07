import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { createTranslator, type Locale } from "@/i18n";
import { kvGet, kvSet } from "~/lib/kv";
import { mobileEn, mobileSi, type MobileKey } from "./mobile-strings";
import type { Key, T } from "./types";

export type { Key, T };

const isMobileKey = (k: Key): k is MobileKey => k in mobileEn;

/** Phone-only wording first, then the web app's shared text (Sinhala falls back to English, key by key). */
export function createMobileTranslator(locale: Locale): T {
  const shared = createTranslator(locale);
  return (key, vars) => {
    if (!isMobileKey(key)) return shared(key, vars);
    let s: string = (locale === "si" ? mobileSi[key] : undefined) ?? mobileEn[key];
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
}

interface I18nApi { t: T; locale: Locale; setLocale: (l: Locale) => void }
const Ctx = createContext<I18nApi | null>(null);
const KEY = "pref.locale";

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");
  useEffect(() => {
    let live = true;
    void kvGet(KEY).then((v) => { if (live && (v === "en" || v === "si")) setLocaleState(v); });
    return () => { live = false; };
  }, []);
  const setLocale = useCallback((l: Locale) => { setLocaleState(l); void kvSet(KEY, l); }, []);
  const value = useMemo<I18nApi>(() => ({ t: createMobileTranslator(locale), locale, setLocale }), [locale, setLocale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useI18n must be used inside I18nProvider");
  return c;
}
