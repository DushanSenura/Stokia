import { apiError, authenticate, json, membershipFor, preflight, readJson } from "@/server/api/v1";
import { reverseMovementCore } from "@/server/services/movement-submit";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `POST /api/v1/movements/reverse`  { shopId, movementId, reason, key }
 *
 * Nothing is deleted: a matching entry cancels the original at its original time and the affected sales are recalculated.
 * Retrying with the same key is safe. Only owners and stock managers may reverse, and the database checks that again.
 */
export async function POST(request: Request) {
  const a = await authenticate(request);
  if (!a.ok) return a.response;
  const body = await readJson(request);
  if (!body) return apiError(request, 400, "bad_request");
  const m = membershipFor(request, a.ctx, body.shopId, "inventory.write");
  if (!m.ok) return m.response;
  if (typeof body.movementId !== "string" || !UUID.test(body.movementId)) return apiError(request, 400, "bad_request");

  try {
    const result = await reverseMovementCore({ supabase: a.ctx.supabase, shopId: m.membership.shopId }, body.movementId, { reason: body.reason, key: body.key });
    return json(request, result);
  } catch {
    return apiError(request, 500, "reverse_failed");
  }
}
