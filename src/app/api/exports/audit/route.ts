import { NextResponse, type NextRequest } from "next/server";
import { addDays, dayStartInstant, isBusinessDate } from "@/lib/dates/business";
import { shopLocalDate } from "@/lib/dates/format";
import { toCsv } from "@/lib/exports/csv";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/server/permissions";
import { AUDIT_PAGE_SIZE, listAudit } from "@/server/repositories/settings";
import { getSessionContext } from "@/server/services/session";

const MAX_ROWS = 5000;

/** Audit log export. Owner only (the database refuses everyone else too). Text cells are guarded against spreadsheet formula injection. */
export async function GET(request: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx.user || !ctx.membership) return new NextResponse("Unauthorized", { status: 401 });
  if (!can(ctx.membership.role, "audit.read")) return new NextResponse("Forbidden", { status: 403 });
  const m = ctx.membership;
  const p = request.nextUrl.searchParams;
  const from = isBusinessDate(p.get("from")) ? p.get("from")! : undefined;
  const to = isBusinessDate(p.get("to")) ? p.get("to")! : undefined;
  const supabase = await createClient();

  const rows: unknown[][] = [["when_utc", "who", "action", "entity", "entity_id", "before", "after"]];
  for (let page = 1; rows.length <= MAX_ROWS; page++) {
    const r = await listAudit(supabase, m.shopId, {
      page, action: p.get("action") || undefined, entity: p.get("entity") || undefined, user: p.get("user") || undefined,
      from: from ? dayStartInstant(from, m.timezone) : undefined, to: to ? dayStartInstant(addDays(to, 1), m.timezone) : undefined,
    });
    for (const a of r.rows) rows.push([a.createdAt, a.user, a.action, a.entityType, a.entityId ?? "", a.before ? JSON.stringify(a.before) : "", a.after ? JSON.stringify(a.after) : ""]);
    if (r.rows.length < AUDIT_PAGE_SIZE) break;
  }
  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="stokia-audit-${shopLocalDate(new Date(), m.timezone)}.csv"`,
    },
  });
}
