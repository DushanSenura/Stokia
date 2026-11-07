/**
 * Business dates are plain calendar dates ("YYYY-MM-DD") in the SHOP's timezone.
 * They are manipulated as strings/UTC-midnight so the machine's timezone can never shift them.
 *
 * Core rule: the morning count on date D calculates the sales of date D-1 (the sales date).
 */
import { TZDate } from "@date-fns/tz";

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isBusinessDate(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; // rejects 2026-02-31
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000);
}

/** The day whose sales a count on `countDate` calculates. */
export const salesDateFor = (countDate: string): string => addDays(countDate, -1);

export function formatBusinessDate(date: string, locale: "en" | "si" = "en", opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" }): string {
  return new Intl.DateTimeFormat(locale === "si" ? "si-LK" : "en-GB", { timeZone: "UTC", ...opts }).format(new Date(`${date}T00:00:00Z`));
}

/**
 * The instant used to look up the selling price for a sales date: noon in the shop's timezone.
 * (A price changed mid-day cannot be split from stock counts alone, so we pick one fixed,
 * documented instant instead of the "latest" price.)
 */
export function priceInstantForSalesDate(salesDate: string, timeZone: string): Date {
  const [y, m, d] = salesDate.split("-").map(Number);
  return new Date(new TZDate(y, m - 1, d, 12, 0, 0, timeZone).getTime());
}

/** 00:00 on a business date in the shop's timezone, as an instant (used for date-range filters on timestamps). */
export function dayStartInstant(date: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(new TZDate(y, m - 1, d, 0, 0, 0, timeZone).getTime());
}

/** "YYYY-MM-DDTHH:mm" typed in the shop's timezone -> instant. Returns null when malformed. */
export function localDateTimeToInstant(local: string, timeZone: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m || !isBusinessDate(m[1])) return null;
  const [hh, mm] = [Number(m[2]), Number(m[3])];
  if (hh > 23 || mm > 59) return null;
  const [y, mo, d] = m[1].split("-").map(Number);
  return new Date(new TZDate(y, mo - 1, d, hh, mm, 0, timeZone).getTime());
}

// ---------- months ("YYYY-MM") ----------
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonth = (v: unknown): v is string => typeof v === "string" && MONTH_RE.test(v);
export const monthOf = (date: string): string => date.slice(0, 7);
export const firstOfMonth = (month: string): string => `${month}-01`;

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

export function lastOfMonth(month: string): string {
  return addDays(firstOfMonth(addMonths(month, 1)), -1);
}

export function daysInMonth(month: string): number {
  return Number(lastOfMonth(month).slice(8, 10));
}

export function formatMonth(month: string, locale: "en" | "si" = "en", style: "long" | "short" = "long"): string {
  return new Intl.DateTimeFormat(locale === "si" ? "si-LK" : "en-GB", { timeZone: "UTC", month: style, year: "numeric" }).format(new Date(`${firstOfMonth(month)}T00:00:00Z`));
}

/** The current wall-clock time in the shop's timezone as "YYYY-MM-DDTHH:mm" (for datetime-local inputs). */
export function nowLocalInput(timeZone: string, at: Date = new Date()): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}
