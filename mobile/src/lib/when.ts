import type { T } from "../i18n/types"; // relative on purpose: the web project's tests import this file directly

/** "5 min ago", for "showing what was saved on this phone". */
export function whenText(savedAt: number, t: T, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - savedAt) / 60_000));
  if (minutes < 1) return t("m.when.justNow");
  if (minutes < 60) return t("m.when.minutes", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("m.when.hours", { n: hours });
  return t("m.when.days", { n: Math.round(hours / 24) });
}
