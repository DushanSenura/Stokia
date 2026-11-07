import { apiError, authenticate, json, membershipFor, preflight, readJson } from "@/server/api/v1";
import { variantLabels } from "@/server/services/count-submit";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/** `POST /api/v1/variant-labels` { shopId, ids }: product names for the conflict screen. */
export async function POST(request: Request) {
  const a = await authenticate(request);
  if (!a.ok) return a.response;
  const body = await readJson(request);
  if (!body) return apiError(request, 400, "bad_request");
  const m = membershipFor(request, a.ctx, body.shopId, "inventory.write");
  if (!m.ok) return m.response;
  return json(request, { ok: true, labels: await variantLabels({ supabase: a.ctx.supabase, shopId: m.membership.shopId }, body.ids) });
}
