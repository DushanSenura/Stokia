import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Liveness + configuration readiness for the host's health check. Unauthenticated, so it returns only booleans:
 * never a key, a URL or a project name.
 */
export function GET() {
  const supabase = !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const siteUrl = !!process.env.NEXT_PUBLIC_SITE_URL;
  const ready = supabase && siteUrl;
  return NextResponse.json(
    { status: ready ? "ok" : "misconfigured", checks: { supabase, siteUrl, invitations: !!process.env.SUPABASE_SERVICE_ROLE_KEY } },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
