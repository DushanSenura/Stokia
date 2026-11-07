import { NextResponse, type NextRequest } from "next/server";
import { shopLocalDate } from "@/lib/dates/format";
import { isBusinessDate } from "@/lib/dates/business";
import { toCsv } from "@/lib/exports/csv";
import { createClient } from "@/lib/supabase/server";
import { exportCountLines } from "@/server/repositories/inventory";
import { getSessionContext } from "@/server/services/session";

/** Count history export (any shop member). Quantities are base units; "not_counted" rows have an empty quantity. */
export async function GET(request: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx.user || !ctx.membership) return new NextResponse("Unauthorized", { status: 401 });
  const p = request.nextUrl.searchParams;
  const from = isBusinessDate(p.get("from")) ? p.get("from")! : undefined;
  const to = isBusinessDate(p.get("to")) ? p.get("to")! : undefined;

  const rows = await exportCountLines(await createClient(), { from, to });
  const csv = toCsv([
    ["count_date", "count_status", "sku", "product", "size", "counted_in", "line_status", "quantity_base_units", "entered_as"],
    ...rows.map((r) => [r.date, r.status, r.sku, r.product, r.size, r.unit, r.countStatus, r.quantity === null ? "" : Number(r.quantity), r.enteredAs]),
  ]);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="stokia-stock-history-${shopLocalDate(new Date(), ctx.membership.timezone)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
