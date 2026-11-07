import type { MessageKey } from "@/i18n";
import type { MobileKey } from "./mobile-strings";

/** Pure types only (no React Native imports), so helpers and tests can use them without pulling in the app. */
export type Key = MessageKey | MobileKey;
export type T = (key: Key, vars?: Record<string, string | number>) => string;
