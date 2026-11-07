import "server-only";
import { valuesFromLine, type EntryItem, type FieldValues } from "@/features/inventory/count-entry";
import { daysBetween, isBusinessDate, salesDateFor } from "@/lib/dates/business";
import { shopLocalDate } from "@/lib/dates/format";
import type { createClient } from "@/lib/supabase/server";
import { getLines, getSessionByDate, loadEntryItems } from "@/server/repositories/inventory";

type Supa = Awaited<ReturnType<typeof createClient>>;

export interface MorningStockData {
  businessDate: string;
  salesDate: string;
  /** Set when that morning's count is already confirmed: it is final here (changes go through correction approval). */
  confirmedSessionId: string | null;
  items: EntryItem[];
  initialValues: Record<string, FieldValues>;
  session: { id: string; revision: number } | null;
  previousDate: string | null;
  /** Calendar days between the previous confirmed count and this one (1 = consecutive mornings). */
  gapDays: number;
  truncated: boolean;
}

/**
 * Everything the morning stock screen needs, for the web page and the phone API alike. The count date is the shop's own
 * calendar date (not the server's), never in the future, and never confused with the sales date it calculates.
 */
export async function loadMorningStock(
  supabase: Supa,
  shop: { shopId: string; timezone: string },
  requestedDate?: string,
): Promise<MorningStockData> {
  const today = shopLocalDate(new Date(), shop.timezone);
  const businessDate = requestedDate && isBusinessDate(requestedDate) && requestedDate <= today ? requestedDate : today;
  const salesDate = salesDateFor(businessDate);

  const session = await getSessionByDate(supabase, shop.shopId, businessDate);
  if (session && session.status !== "draft") {
    return { businessDate, salesDate, confirmedSessionId: session.id, items: [], initialValues: {}, session: { id: session.id, revision: session.revision }, previousDate: null, gapDays: 0, truncated: false };
  }

  const { items, previous, truncated } = await loadEntryItems(supabase, shop.shopId, businessDate, shop.timezone);

  const initialValues: Record<string, FieldValues> = {};
  if (session) {
    const byId = new Map(items.map((i) => [i.variantId, i]));
    for (const line of await getLines(supabase, session.id)) {
      const item = byId.get(line.variant_id);
      if (item && line.count_status === "counted") initialValues[line.variant_id] = valuesFromLine(item, line);
    }
  }

  return {
    businessDate, salesDate, confirmedSessionId: null, items, initialValues,
    session: session ? { id: session.id, revision: session.revision } : null,
    previousDate: previous?.business_date ?? null,
    gapDays: previous ? daysBetween(previous.business_date, businessDate) : 0,
    truncated,
  };
}
