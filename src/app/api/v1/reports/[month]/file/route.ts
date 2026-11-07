import { NextResponse } from "next/server";
import { shopLocalDate } from "@/lib/dates/format";
import { apiError, apiHeaders, authenticate, membershipFor, preflight } from "@/server/api/v1";
import { validReportMonth } from "@/server/repositories/reports";
import { buildReportFile, isReportFormat } from "@/server/services/report-file";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

/**
 * `GET /api/v1/reports/<YYYY-MM>/file?shop=<id>&format=pdf|xlsx|csv`: the same file the web app downloads, for the phone's share
 * sheet. Any shop member may export what they can see; the export is logged exactly as on the web.
 */
export async function GET(request: Request, { params }: { params: Promise<{ month: string }> }) {
  const a = await authenticate(request);
  if (!a.ok) return a.response;
  const url = new URL(request.url);
  const m = membershipFor(request, a.ctx, url.searchParams.get("shop"));
  if (!m.ok) return m.response;
  const { month } = await params;
  const format = url.searchParams.get("format");
  const { shopId, shopName, timezone } = m.membership;

  if (!isReportFormat(format)) return apiError(request, 400, "unknown_format");
  if (!validReportMonth(month, shopLocalDate(new Date(), timezone))) return apiError(request, 400, "invalid_month");

  const file = await buildReportFile(a.ctx.supabase, { shopId, shopName, timezone }, month, format);
  if (!file.ok) return apiError(request, 500, "export_failed");
  return new NextResponse(file.body, {
    headers: apiHeaders(request, {
      "Content-Type": file.type,
      "Content-Disposition": `attachment; filename="${file.fileName}"`,
      "X-Content-Type-Options": "nosniff",
    }),
  });
}
