import type { BreakdownDraft } from "@/features/sales/breakdown-types";
import { apiError, authenticate, json, membershipFor, preflight, readJson } from "@/server/api/v1";
import { loadBreakdownDay, saveBreakdownCore } from "@/server/services/sales-breakdown";
import { can } from "@/server/permissions";
import { isBusinessDate } from "@/lib/dates/business";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/**
 * `GET /api/v1/sales-breakdown?shop=<id>&date=<sales date>`: the products whose sales on that day can be split into whole packages,
 * with the prices in force that day and any breakdown already recorded. Read-only, any shop member.
 */
export async function GET(request: Request) {
  const a = await authenticate(request);
  if (!a.ok) return a.response;
  const url = new URL(request.url);
  const m = membershipFor(request, a.ctx, url.searchParams.get("shop"));
  if (!m.ok) return m.response;
  const date = url.searchParams.get("date");
  if (!isBusinessDate(date)) return apiError(request, 400, "bad_request");
  try {
    const day = await loadBreakdownDay({ supabase: a.ctx.supabase, shopId: m.membership.shopId }, m.membership.timezone, date);
    return json(request, { ok: true, shop: m.membership, canWrite: can(m.membership.role, "inventory.write"), day });
  } catch {
    return apiError(request, 500, "load_failed");
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/**
 * `POST /api/v1/sales-breakdown`  { shopId, draft: { variantId, date, lines: [{ unitId, quantity }], reason?, expectedRevision? }, key }
 *
 * Records (or changes) the known whole-package sales of one product on one day. Retrying with the same `key` is safe: the database
 * returns the original answer and records nothing twice. A refusal (a rule, a missing reason, a changed revision) is a normal 200
 * answer with `ok: false`; only owners and stock managers may record. This never changes stock.
 */
export async function POST(request: Request) {
  const a = await authenticate(request);
  if (!a.ok) return a.response;
  const body = await readJson(request);
  if (!body) return apiError(request, 400, "bad_request");
  const m = membershipFor(request, a.ctx, body.shopId, "inventory.write");
  if (!m.ok) return m.response;

  const d = body.draft && typeof body.draft === "object" ? (body.draft as Record<string, unknown>) : null;
  if (!d || !Array.isArray(d.lines)) return apiError(request, 400, "bad_request");
  const draft: BreakdownDraft = {
    variantId: str(d.variantId) ?? "", date: str(d.date) ?? "",
    // anything that is not a string is dropped, so the shared validation refuses it
    lines: d.lines.map((l) => ({ unitId: str((l as Record<string, unknown>)?.unitId) ?? "", quantity: str((l as Record<string, unknown>)?.quantity) ?? "" })),
    reason: str(d.reason), expectedRevision: typeof d.expectedRevision === "number" && Number.isInteger(d.expectedRevision) ? d.expectedRevision : null,
  };
  try {
    return json(request, await saveBreakdownCore({ supabase: a.ctx.supabase, shopId: m.membership.shopId }, m.membership.timezone, draft, str(body.key) ?? ""));
  } catch {
    return apiError(request, 500, "record_failed"); // no answer: the phone retries with the same key
  }
}
