import { salesDateFor } from "@/lib/dates/business";
import { shopLocalDate } from "@/lib/dates/format";
import { apiError, authenticate, json, membershipFor, preflight } from "@/server/api/v1";
import { getLatestConfirmedDate, getSalesForDate, getSessionByDate, summarizeSales } from "@/server/repositories/inventory";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/**
 * `GET /api/v1/home?shop=<id>`: what the phone's Home screen shows. The latest confirmed count on day D calculates sales for
 * day D-1, so that is the day the sales figure is for. Money is always "estimated".
 */
export async function GET(request: Request) {
  const a = await authenticate(request);
  if (!a.ok) return a.response;
  const m = membershipFor(request, a.ctx, new URL(request.url).searchParams.get("shop"));
  if (!m.ok) return m.response;
  const { shopId, timezone } = m.membership;

  try {
    const today = shopLocalDate(new Date(), timezone);
    const [session, latest] = await Promise.all([getSessionByDate(a.ctx.supabase, shopId, today), getLatestConfirmedDate(a.ctx.supabase, shopId)]);
    const todayStatus = !session ? "not_started" : session.status === "draft" ? "draft" : "confirmed";
    const salesDate = latest ? salesDateFor(latest) : null;
    const sales = salesDate ? summarizeSales(salesDate, await getSalesForDate(a.ctx.supabase, shopId, salesDate)) : null;
    return json(request, { ok: true, shop: m.membership, today, todayStatus, latestConfirmed: latest, salesDate, sales });
  } catch {
    return apiError(request, 500, "load_failed");
  }
}
