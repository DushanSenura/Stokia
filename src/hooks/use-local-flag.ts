"use client";

import { useCallback, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

/** Boolean preference persisted in localStorage (safe if storage is blocked). */
export function useLocalFlag(key: string): [boolean, (v: boolean | ((c: boolean) => boolean)) => void] {
  const value = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => {
      try {
        return localStorage.getItem(key) === "1";
      } catch {
        return false;
      }
    },
    () => false,
  );
  const set = useCallback(
    (v: boolean | ((c: boolean) => boolean)) => {
      try {
        const cur = localStorage.getItem(key) === "1";
        localStorage.setItem(key, (typeof v === "function" ? v(cur) : v) ? "1" : "0");
      } catch {}
      listeners.forEach((l) => l());
    },
    [key],
  );
  return [value, set];
}
