/** Timestamps are stored in UTC; people see them in the shop's timezone (default Asia/Colombo). */
export const DEFAULT_TZ = "Asia/Colombo";

export function formatShopDateTime(iso: string | Date, timeZone = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

/** The shop-local calendar date (YYYY-MM-DD) for an instant. Business dates are derived with this. */
export function shopLocalDate(instant: Date | string, timeZone = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}
