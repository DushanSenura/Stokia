import { NextResponse } from "next/server";
import { backupChunks } from "@/features/data/backup";
import { shopLocalDate } from "@/lib/dates/format";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/server/permissions";
import { backupSource, recordBackup } from "@/server/repositories/data";
import { getSessionContext } from "@/server/services/session";

export const dynamic = "force-dynamic";

/** Full-data backup of the owner's shop, streamed (a year of counts is too big to hold in memory). Owner only; every download is audited. */
export async function GET() {
  const ctx = await getSessionContext();
  if (!ctx.user || !ctx.membership) return new NextResponse("Unauthorized", { status: 401 });
  const m = ctx.membership;
  if (!can(m.role, "data.manage")) return new NextResponse("Forbidden", { status: 403 });

  const supabase = await createClient();
  const gen = backupChunks(
    backupSource(supabase, m.shopId),
    { shopId: m.shopId, shopName: m.shopName, exportedAt: new Date().toISOString() },
    (f) => recordBackup(supabase, m.shopId, f.counts, f.checksum), // runs on completion AND on failure/cancel (checksum "incomplete")
  );
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await gen.next();
        if (done) controller.close(); else controller.enqueue(enc.encode(value));
      } catch (e) { controller.error(e); }
    },
    async cancel() { await gen.return(undefined); },
  });
  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="stokia-backup-${shopLocalDate(new Date(), m.timezone)}.json"`,
    },
  });
}
