import type { Locale, MessageKey, Translator } from "@/i18n";
import { formatBusinessDate } from "@/lib/dates/business";
import type { ReportNote } from "./report";

/** One sentence for a report note, with any date formatted for the reader's language. Shared by the web report and the phone app. */
export function noteSentence(n: ReportNote, t: Translator, locale: Locale): string {
  const p: Record<string, string | number> = { ...n.params };
  if (typeof p.date === "string" && p.date) p.date = formatBusinessDate(p.date, locale);
  return t(`rep.note.${n.code}` as MessageKey, p);
}
