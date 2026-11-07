import { apiError, authenticate, json, membershipFor, preflight } from "@/server/api/v1";
import { loadBreakdownHistory } from "@/server/services/sales-breakdown";
import { isBusinessDate } from "@/lib/dates/business";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `GET /api/v1/sales-breakdown/history?shop=<id>&variant=<id>&date=<sales date>`: who changed what and why, oldest first. Any member. */
export async function GET(request: Request) {
  const a = await authenticate(request);
  if (!a.ok) return a.response;
  const url = new URL(request.url);
  const m = membershipFor(request, a.ctx, url.searchParams.get("shop"));
  if (!m.ok) return m.response;
  const variant = url.searchParams.get("variant");
  const date = url.searchParams.get("date");
  if (!variant || !UUID.test(variant) || !isBusinessDate(date)) return apiError(request, 400, "bad_request");
  try {
    return json(request, { ok: true, history: await loadBreakdownHistory({ supabase: a.ctx.supabase, shopId: m.membership.shopId }, variant, date) });
  } catch {
    return apiError(request, 500, "load_failed");
  }
}
