import { formatBusinessDate, formatMonth } from "@/lib/dates/business";
import type { DashAlert } from "./summary";
import type { Locale, MessageKey, Translator } from "@/i18n";

/** Human sentence for an alert. Dates and months in the params are formatted for the viewer's language. */
export function alertText(a: DashAlert, t: Translator, locale: Locale): string {
  const params: Record<string, string | number> = { ...a.params };
  if (typeof params.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.date)) params.date = formatBusinessDate(params.date, locale);
  if (typeof params.month === "string" && /^\d{4}-\d{2}$/.test(params.month)) params.month = formatMonth(params.month, locale);
  return t(`alert.${a.id}` as MessageKey, params);
}
