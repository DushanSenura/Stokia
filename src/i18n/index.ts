import { en, type MessageKey } from "./en";
import { si } from "./si";

export type { MessageKey };
export const LOCALES = ["en", "si"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "stokia-locale";

export const LOCALE_LABELS: Record<Locale, string> = { en: "English", si: "සිංහල" };

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

export type Translator = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Build a translator. Missing Sinhala keys fall back to English. */
export function createTranslator(locale: Locale): Translator {
  const dict = locale === "si" ? si : {};
  return (key, vars) => {
    let s: string = (dict as Partial<Record<MessageKey, string>>)[key] ?? en[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };
}
