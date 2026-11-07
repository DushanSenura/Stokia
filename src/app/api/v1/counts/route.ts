import { apiError, authenticate, json, membershipFor, preflight, readJson } from "@/server/api/v1";
import { submitCountCore } from "@/server/services/count-submit";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/**
 * `POST /api/v1/counts`  { shopId, count, ackMissing, idempotencyKey, device? }
 *
 * Save and confirm a morning count in one transaction. Retrying with the same `idempotencyKey` returns the original answer
 * and applies nothing twice; a conflict with another device's count is a normal 200 answer (`ok: false, conflict: true`) that
 * carries the server's copy. Nothing is ever overwritten.
 */
export async function POST(request: Request) {
  const a = await authenticate(request);
  if (!a.ok) return a.response;
  const body = await readJson(request);
  if (!body) return apiError(request, 400, "bad_request");

  const m = membershipFor(request, a.ctx, body.shopId, "inventory.write");
  if (!m.ok) return m.response;

  try {
    const device = typeof body.device === "string" ? body.device : undefined;
    const result = await submitCountCore({ supabase: a.ctx.supabase, shopId: m.membership.shopId }, body.count, body.ackMissing === true, body.idempotencyKey, device);
    return json(request, result);
  } catch {
    return apiError(request, 500, "submit_failed"); // the phone treats this like "no answer" and replays the same key
  }
}
