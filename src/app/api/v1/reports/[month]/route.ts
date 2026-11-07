import { shopLocalDate } from "@/lib/dates/format";
import { apiError, authenticate, json, membershipFor, preflight } from "@/server/api/v1";
import { loadMonthlyReport, validReportMonth } from "@/server/repositories/reports";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/**
 * `GET /api/v1/reports/<YYYY-MM>?shop=<id>`: the monthly report the web app shows, without the per-variant table (which can be
 * thousands of rows; the phone gets the per-product totals instead). Estimated sales are never confirmed revenue.
 */
export async function GET(request: Request, { params }: { params: Promise<{ month: string }> }) {
  const a = await authenticate(request);
  if (!a.ok) return a.response;
  const m = membershipFor(request, a.ctx, new URL(request.url).searchParams.get("shop"));
  if (!m.ok) return m.response;
  const { month } = await params;
  const { shopId, shopName, timezone } = m.membership;
  if (!validReportMonth(month, shopLocalDate(new Date(), timezone))) return apiError(request, 400, "invalid_month");

  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- `variants` is deliberately left out of the phone's copy
    const { variants, ...report } = await loadMonthlyReport(a.ctx.supabase, { shopId, shopName, timezone }, month);
    return json(request, { ok: true, report });
  } catch {
    return apiError(request, 500, "load_failed");
  }
}
