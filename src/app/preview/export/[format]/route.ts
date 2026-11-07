import { NextResponse } from "next/server";
import { demoReport } from "@/features/reports/demo-data";
import { reportToCsv } from "@/lib/exports/report-csv";
import { reportToPdf } from "@/lib/exports/report-pdf";
import { reportToXlsx } from "@/lib/exports/report-xlsx";

/**
 * Serves the DEMO report through the real exporters, as built and bundled by Next.js, so tests can prove the PDF / Excel / CSV
 * generators work in the production build (not just under a test runner). 404 unless STOKIA_PREVIEW=1. No database, no login.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ format: string }> }) {
  if (process.env.STOKIA_PREVIEW !== "1") return new NextResponse("Not found", { status: 404 });
  const { format } = await params;
  const report = demoReport();
  if (format === "pdf") return new NextResponse(reportToPdf(report) as BodyInit, { headers: { "Content-Type": "application/pdf" } });
  if (format === "xlsx") return new NextResponse((await reportToXlsx(report)) as BodyInit, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
  if (format === "csv") return new NextResponse(reportToCsv(report), { headers: { "Content-Type": "text/csv; charset=utf-8" } });
  return new NextResponse("Unknown format", { status: 400 });
}
