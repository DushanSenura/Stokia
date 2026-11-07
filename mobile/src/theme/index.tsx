import { StatusBar } from "expo-status-bar";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useColorScheme } from "react-native";
import { kvGet, kvSet } from "~/lib/kv";

/** Stokia "Calm Commerce" tokens, matching the web app. Text/background pairs meet WCAG AA contrast. */
export interface Palette {
  bg: string; surface: string; surfaceSoft: string; border: string; text: string; muted: string;
  action: string; actionText: string; primary: string; mint: string; mintText: string;
  warning: string; warningSoft: string; danger: string; dangerSoft: string; info: string; infoSoft: string; success: string; successSoft: string;
}

export const palettes: Record<"light" | "dark", Palette> = {
  light: {
    bg: "#F8FAF8", surface: "#FFFFFF", surfaceSoft: "#EEF3EF", border: "#DFE7E2", text: "#1F2A24", muted: "#566359",
    action: "#1F6B50", actionText: "#FFFFFF", primary: "#2F8F6B", mint: "#DDF2E7", mintText: "#14513A",
    warning: "#8A5A00", warningSoft: "#FDF0D2", danger: "#A32018", dangerSoft: "#FDE4E1", info: "#1F5F99", infoSoft: "#E0EDF9", success: "#1E6B47", successSoft: "#DDF2E7",
  },
  dark: {
    bg: "#0E1512", surface: "#16201B", surfaceSoft: "#1D2A23", border: "#27352D", text: "#E9F1EC", muted: "#A8B8AE",
    action: "#7DB79A", actionText: "#0E1512", primary: "#7DB79A", mint: "#1B3A2D", mintText: "#CDEBDD",
    warning: "#F0C060", warningSoft: "#3B2F10", danger: "#F4A9A2", dangerSoft: "#451A16", info: "#8EC1F0", infoSoft: "#142A40", success: "#8FD3B0", successSoft: "#173626",
  },
};

export type ThemePref = "system" | "light" | "dark";
interface ThemeApi { colors: Palette; scheme: "light" | "dark"; pref: ThemePref; setPref: (p: ThemePref) => void }
const Ctx = createContext<ThemeApi | null>(null);
const KEY = "pref.theme";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [pref, setPrefState] = useState<ThemePref>("system");

  useEffect(() => {
    let live = true;
    void kvGet(KEY).then((v) => { if (live && (v === "light" || v === "dark")) setPrefState(v); });
    return () => { live = false; };
  }, []);

  const setPref = useCallback((p: ThemePref) => { setPrefState(p); void kvSet(KEY, p); }, []);
  const scheme: "light" | "dark" = pref === "system" ? (system === "dark" ? "dark" : "light") : pref;
  const value = useMemo<ThemeApi>(() => ({ colors: palettes[scheme], scheme, pref, setPref }), [scheme, pref, setPref]);
  return (
    <Ctx.Provider value={value}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      {children}
    </Ctx.Provider>
  );
}

export function useTheme(): ThemeApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useTheme must be used inside ThemeProvider");
  return c;
}
