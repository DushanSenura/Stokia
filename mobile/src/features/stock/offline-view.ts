import { daysBetween, isBusinessDate, salesDateFor } from "@/lib/dates/business";
import { shopLocalDate } from "@/lib/dates/format";
import type { MorningStockResponse } from "../../lib/api-client"; // relative on purpose: the web project's tests import this file directly

/**
 * Counting with no connection: rebuild the morning-stock screen from the copy saved on the phone the last time it was online.
 *
 * What is recomputed from the phone's own clock: today's date in the SHOP's time zone, and the sales date it calculates (always the
 * day before; never confused with the count date). What is kept: the products, their packaging, the previous count and prices.
 * What is NOT trusted: whether the day was confirmed meanwhile, or what the server's draft looks like now. If another device got
 * there first, the server says so when the count is sent, and nothing is overwritten.
 */
export function offlineView(cached: MorningStockResponse, shop: { timezone: string }, requestedDate?: string, now: Date = new Date()): MorningStockResponse {
  const today = shopLocalDate(now, shop.timezone);
  const businessDate = requestedDate && isBusinessDate(requestedDate) && requestedDate <= today ? requestedDate : today;
  const sameDay = cached.businessDate === businessDate;
  return {
    ...cached,
    businessDate,
    salesDate: salesDateFor(businessDate),
    confirmedSessionId: null,
    // A draft saved for another morning says nothing about this one.
    session: sameDay ? cached.session : null,
    initialValues: sameDay ? cached.initialValues : {},
    gapDays: cached.previousDate ? daysBetween(cached.previousDate, businessDate) : 0,
  };
}
