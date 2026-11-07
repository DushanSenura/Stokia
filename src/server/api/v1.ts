import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { getSupabaseEnv } from "@/lib/supabase/env";
import { can, type Capability, type Role } from "@/server/permissions";

/**
 * Shared plumbing for the versioned JSON API (/api/v1) that the native phone apps call. The web app does not use it: it keeps
 * its Server Actions. Both reach the same services (`count-submit.ts`, `morning-stock.ts`), so behaviour cannot differ.
 *
 *  - Authentication is a Supabase access token in `Authorization: Bearer ...` (a phone has no cookie session). The token is
 *    validated with Supabase Auth on every request, and the same token is forwarded to the database, so Row Level Security
 *    applies exactly as it does for the web app. The service-role key is never involved.
 *  - Responses are never cached.
 *  - Cross-origin access is OFF unless `STOKIA_API_ALLOWED_ORIGINS` lists an origin. Native apps do not need CORS; it exists
 *    only so a browser-based test build of the phone app can talk to this server.
 */
export interface Membership { shopId: string; shopName: string; timezone: string; role: Role }
export interface ApiContext {
  supabase: SupabaseClient;
  userId: string;
  email: string | null;
  displayName: string;
  memberships: Membership[];
}

function allowedOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const allowed = (process.env.STOKIA_API_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

/** Headers every API answer carries: never cached, and cross-origin permission only for an explicitly allowed origin. */
export function apiHeaders(request: Request, extra?: Record<string, string>) {
  const h: Record<string, string> = { "Cache-Control": "no-store", Vary: "Origin", ...extra };
  const origin = allowedOrigin(request);
  if (origin) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Headers"] = "authorization, content-type";
    h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    h["Access-Control-Expose-Headers"] = "content-disposition";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}
const headersFor = apiHeaders;

export const json = (request: Request, body: unknown, status = 200) => NextResponse.json(body, { status, headers: headersFor(request) });
export const apiError = (request: Request, status: number, code: string) => json(request, { ok: false, error: code }, status);
/** Answer a CORS preflight (only ever successful for an allowed origin). */
export const preflight = (request: Request) => new NextResponse(null, { status: 204, headers: headersFor(request) });

export async function authenticate(request: Request): Promise<{ ok: true; ctx: ApiContext } | { ok: false; response: NextResponse }> {
  const env = getSupabaseEnv();
  if (!env) return { ok: false, response: apiError(request, 503, "not_configured") };

  const header = request.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  if (!token) return { ok: false, response: apiError(request, 401, "not_signed_in") };

  const supabase = createClient(env.url, env.key, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return { ok: false, response: apiError(request, 401, "not_signed_in") };

  const [{ data: rows }, { data: profile }] = await Promise.all([
    supabase.from("shop_memberships").select("role, shops(id, name, timezone)").eq("user_id", user.id).eq("status", "active"),
    supabase.from("user_profiles").select("display_name").eq("id", user.id).maybeSingle(),
  ]);

  const memberships: Membership[] = [];
  for (const r of (rows ?? []) as unknown as { role: Role; shops: { id: string; name: string; timezone: string } | { id: string; name: string; timezone: string }[] | null }[]) {
    const shop = Array.isArray(r.shops) ? r.shops[0] : r.shops;
    if (shop) memberships.push({ shopId: shop.id, shopName: shop.name, timezone: shop.timezone, role: r.role });
  }
  return {
    ok: true,
    ctx: { supabase, userId: user.id, email: user.email ?? null, displayName: profile?.display_name || user.email?.split("@")[0] || "", memberships },
  };
}

/** The caller's membership of `shopId`, if they hold a role that grants `capability` (default: any role). */
export function membershipFor(request: Request, ctx: ApiContext, shopId: unknown, capability?: Capability): { ok: true; membership: Membership } | { ok: false; response: NextResponse } {
  const m = typeof shopId === "string" ? ctx.memberships.find((x) => x.shopId === shopId) : undefined;
  if (!m) return { ok: false, response: apiError(request, 403, "forbidden") }; // not a member (or a malformed id): same answer, nothing is revealed
  if (capability && !can(m.role, capability)) return { ok: false, response: apiError(request, 403, "forbidden") };
  return { ok: true, membership: m };
}

/** Read a JSON body safely; anything unreadable is a plain 400. */
export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
