"use client";

import { useRouter } from "next/navigation";
import { SalesBreakdownPanel } from "./sales-breakdown-panel";

/**
 * The breakdown panel on the stock history page. That page also shows the day's sales table, so after a change the page is refreshed from
 * the browser (the actions deliberately do not revalidate: see src/server/actions/sales-breakdown.ts).
 */
export function HistorySalesBreakdown({ date, timezone }: { date: string; timezone: string }) {
  const router = useRouter();
  return <SalesBreakdownPanel date={date} timezone={timezone} onChanged={() => router.refresh()} />;
}
