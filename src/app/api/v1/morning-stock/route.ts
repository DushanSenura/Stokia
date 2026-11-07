import { apiError, authenticate, json, membershipFor, preflight } from "@/server/api/v1";
import { can } from "@/server/permissions";
import { loadMorningStock } from "@/server/services/morning-stock";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/** `GET /api/v1/morning-stock?shop=<id>[&date=YYYY-MM-DD]`: the products to count, previous counts, prices and any draft. */
export async function GET(request: Request) {
  const a = await authenticate(request);
  if (!a.ok) return a.response;
  const url = new URL(request.url);
  const m = membershipFor(request, a.ctx, url.searchParams.get("shop"));
  if (!m.ok) return m.response;

  try {
    const data = await loadMorningStock(a.ctx.supabase, m.membership, url.searchParams.get("date") ?? undefined);
    return json(request, { ok: true, shop: m.membership, canWrite: can(m.membership.role, "inventory.write"), ...data });
  } catch {
    return apiError(request, 500, "load_failed"); // never a stack trace or a database message
  }
}
