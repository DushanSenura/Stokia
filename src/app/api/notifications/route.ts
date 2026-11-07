import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { alertsFrom, loadAlertInputs } from "@/server/repositories/dashboard";
import { getSessionContext } from "@/server/services/session";

/** Derived notifications for the bell (nothing is stored: they reflect the current state of counts, reviews and stock). */
export async function GET() {
  const ctx = await getSessionContext();
  if (!ctx.user || !ctx.membership) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const inputs = await loadAlertInputs(await createClient(), { shopId: ctx.membership.shopId, timezone: ctx.membership.timezone });
  return NextResponse.json({ alerts: alertsFrom(inputs) }, { headers: { "Cache-Control": "no-store" } });
}
