import { apiError, authenticate, json, membershipFor, preflight, readJson } from "@/server/api/v1";
import { clearBreakdownCore } from "@/server/services/sales-breakdown";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/**
 * `POST /api/v1/sales-breakdown/clear`  { shopId, variantId, date, reason, key }
 * "I do not know the box sales after all": removes the breakdown (its history stays) and the day returns to the plain estimate.
 */
export async function POST(request: Request) {
  const a = await authenticate(request);
  if (!a.ok) return a.response;
  const body = await readJson(request);
  if (!body) return apiError(request, 400, "bad_request");
  const m = membershipFor(request, a.ctx, body.shopId, "inventory.write");
  if (!m.ok) return m.response;
  try {
    return json(request, await clearBreakdownCore({ supabase: a.ctx.supabase, shopId: m.membership.shopId },
      { variantId: str(body.variantId) ?? "", date: str(body.date) ?? "", reason: str(body.reason) ?? "" }, str(body.key) ?? ""));
  } catch {
    return apiError(request, 500, "record_failed");
  }
}
