"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from "react";

/**
 * Light / dark / system theme. Replaces `next-themes`, whose provider renders an inline <script> inside a client
 * component (React 19 logs "Encountered a script tag while rendering React component"). The no-flash script now lives in the
 * server layout (`ThemeScript`); this provider only keeps state, applies the class and remembers the choice.
 */
export type ThemePreference = "light" | "dark" | "system";
export const THEME_KEY = "theme";

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function readPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system"; // storage blocked: follow the device
  }
}
const systemDark = () => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;

function subscribe(cb: () => void) {
  listeners.add(cb);
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onStorage = (e: StorageEvent) => { if (e.key === THEME_KEY || e.key === null) cb(); };
  mq.addEventListener("change", cb);
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(cb); mq.removeEventListener("change", cb); window.removeEventListener("storage", onStorage); };
}

function apply(resolved: "light" | "dark", quiet: boolean) {
  const root = document.documentElement;
  let style: HTMLStyleElement | null = null;
  if (quiet) { // no colour transitions while the theme flips
    style = document.createElement("style");
    style.textContent = "*,*::before,*::after{transition:none!important}";
    document.head.appendChild(style);
  }
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
  if (style) { void getComputedStyle(document.body).opacity; setTimeout(() => style!.remove(), 1); }
}

interface ThemeApi { theme: ThemePreference; resolvedTheme: "light" | "dark" | undefined; setTheme: (t: ThemePreference) => void }
const Ctx = createContext<ThemeApi | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(subscribe, readPreference, () => "system" as ThemePreference);
  const dark = useSyncExternalStore(subscribe, systemDark, () => false);
  const resolved: "light" | "dark" = theme === "system" ? (dark ? "dark" : "light") : theme;

  useEffect(() => { apply(resolved, false); }, [resolved]);

  const setTheme = useCallback((t: ThemePreference) => {
    try { if (t === "system") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, t); } catch { /* choice lasts for this visit only */ }
    apply(t === "system" ? (systemDark() ? "dark" : "light") : t, true);
    emit();
  }, []);

  const value = useMemo<ThemeApi>(() => ({ theme, resolvedTheme: resolved, setTheme }), [theme, resolved, setTheme]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useTheme must be used inside ThemeProvider");
  return c;
}

/** Runs before first paint so there is no flash of the wrong theme. Rendered by the SERVER layout (scripts are fine there). */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");var d=t==="dark"||((t!=="light")&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light"}catch(e){}})()`;
