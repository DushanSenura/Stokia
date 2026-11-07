import { apiError, authenticate, json, membershipFor, preflight } from "@/server/api/v1";
import { displayNames, listSessions } from "@/server/repositories/inventory";
import { loadReportIndex } from "@/server/repositories/reports";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const RECENT_COUNTS = 10;

/**
 * `GET /api/v1/reports?shop=<id>`: the last twelve months (status, estimated sales, flags) and the most recent confirmed counts.
 * Read-only, any shop member.
 */
export async function GET(request: Request) {
  const a = await authenticate(request);
  if (!a.ok) return a.response;
  const m = membershipFor(request, a.ctx, new URL(request.url).searchParams.get("shop"));
  if (!m.ok) return m.response;
  const { shopId, shopName, timezone } = m.membership;

  try {
    const [months, history] = await Promise.all([
      loadReportIndex(a.ctx.supabase, { shopId, shopName, timezone }),
      listSessions(a.ctx.supabase, { page: 1 }),
    ]);
    const rows = history.rows.filter((r) => r.status !== "draft").slice(0, RECENT_COUNTS);
    const people = await displayNames(a.ctx.supabase, rows.map((r) => r.confirmed_by));
    const recent = rows.map((r) => ({
      id: r.id, businessDate: r.business_date, status: r.status, confirmedAt: r.confirmed_at,
      by: r.confirmed_by ? people.get(r.confirmed_by) ?? null : null,
      counted: history.tally.get(r.id)?.counted ?? 0, notCounted: history.tally.get(r.id)?.notCounted ?? 0,
    }));
    return json(request, { ok: true, shop: m.membership, months, recent });
  } catch {
    return apiError(request, 500, "load_failed");
  }
}
