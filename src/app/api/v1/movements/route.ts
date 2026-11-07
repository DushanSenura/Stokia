import { apiError, authenticate, json, membershipFor, preflight, readJson } from "@/server/api/v1";
import { loadRecentMovements } from "@/server/services/movement-list";
import { recordMovementCore } from "@/server/services/movement-submit";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/** `GET /api/v1/movements?shop=<id>`: the most recent stock movements, newest first. Read-only, any shop member. */
export async function GET(request: Request) {
  const a = await authenticate(request);
  if (!a.ok) return a.response;
  const m = membershipFor(request, a.ctx, new URL(request.url).searchParams.get("shop"));
  if (!m.ok) return m.response;
  try {
    return json(request, { ok: true, shop: m.membership, recent: await loadRecentMovements(a.ctx.supabase) });
  } catch {
    return apiError(request, 500, "load_failed");
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/**
 * `POST /api/v1/movements`  { shopId, movement: { variantId, type, direction?, unitId, quantity, when, effectiveLocal?, countDate?, reason?, reference?, supplier?, cost? }, key }
 *
 * `when` is "now", "before_count" or "custom". A movement the phone saved while offline is sent later, so it carries the moment it was
 * entered: "custom" with `effectiveLocal` (shop-local "YYYY-MM-DDTHH:mm"), or "before_count" with `countDate` (the morning it belongs to).
 *
 * Records one movement. Retrying with the same `key` is safe: the database returns the original and applies nothing twice.
 * A refusal (a rule, a missing reason) is a normal 200 answer with `ok: false`; only owners and stock managers may record.
 */
export async function POST(request: Request) {
  const a = await authenticate(request);
  if (!a.ok) return a.response;
  const body = await readJson(request);
  if (!body) return apiError(request, 400, "bad_request");
  const m = membershipFor(request, a.ctx, body.shopId, "inventory.write");
  if (!m.ok) return m.response;

  const mv = body.movement && typeof body.movement === "object" ? (body.movement as Record<string, unknown>) : null;
  if (!mv) return apiError(request, 400, "bad_request");

  try {
    // Same validation as the web form: the phone's JSON is mapped onto the form's field names and goes through the same schema.
    const result = await recordMovementCore({ supabase: a.ctx.supabase, shopId: m.membership.shopId }, m.membership.timezone, {
      variant_id: str(mv.variantId), type: str(mv.type), direction: str(mv.direction), unit_id: str(mv.unitId), quantity: str(mv.quantity),
      when: str(mv.when) ?? "now", effective_local: str(mv.effectiveLocal), count_date: str(mv.countDate), reason: str(mv.reason), reference: str(mv.reference), supplier: str(mv.supplier), cost: str(mv.cost), key: str(body.key),
    });
    return json(request, result);
  } catch {
    return apiError(request, 500, "record_failed"); // no answer: the phone retries with the same key
  }
}
