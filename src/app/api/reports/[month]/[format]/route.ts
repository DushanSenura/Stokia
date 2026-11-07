import { NextResponse, type NextRequest } from "next/server";
import { shopLocalDate } from "@/lib/dates/format";
import { validReportMonth } from "@/server/repositories/reports";
import { buildReportFile, isReportFormat } from "@/server/services/report-file";
import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/server/services/session";

/**
 * Report export. Any shop member (including viewers) may export what they can see. Every export is logged with the data
 * version, so the report can later say whether its figures changed after it was exported.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ month: string; format: string }> }) {
  const { month, format } = await params;
  const ctx = await getSessionContext();
  if (!ctx.user || !ctx.membership) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const m = ctx.membership;

  if (!isReportFormat(format)) return NextResponse.json({ error: "Unknown format" }, { status: 400 });
  if (!validReportMonth(month, shopLocalDate(new Date(), m.timezone))) return NextResponse.json({ error: "Invalid month" }, { status: 400 });

  const file = await buildReportFile(await createClient(), { shopId: m.shopId, shopName: m.shopName, timezone: m.timezone }, month, format);
  if (!file.ok) return NextResponse.json({ error: file.error }, { status: 500 });
  return new NextResponse(file.body, {
    headers: {
      "Content-Type": file.type,
      "Content-Disposition": `attachment; filename="${file.fileName}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
