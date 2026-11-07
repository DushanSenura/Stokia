import { apiError, authenticate, json, membershipFor, preflight } from "@/server/api/v1";
import { loadProductCatalog } from "@/server/services/product-catalog";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/** `GET /api/v1/products?shop=<id>`: active products with price, packaging and last counted quantity (read-only, any shop member). */
export async function GET(request: Request) {
  const a = await authenticate(request);
  if (!a.ok) return a.response;
  const m = membershipFor(request, a.ctx, new URL(request.url).searchParams.get("shop"));
  if (!m.ok) return m.response;
  try {
    return json(request, { ok: true, shop: m.membership, ...(await loadProductCatalog(a.ctx.supabase, m.membership)) });
  } catch {
    return apiError(request, 500, "load_failed");
  }
}
