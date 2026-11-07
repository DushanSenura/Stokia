import "server-only";
import { reportFileName } from "@/features/reports/labels";
import { exportTotals } from "@/features/reports/report";
import { reportToCsv } from "@/lib/exports/report-csv";
import { reportToPdf } from "@/lib/exports/report-pdf";
import { reportToXlsx } from "@/lib/exports/report-xlsx";
import type { createClient } from "@/lib/supabase/server";
import { loadMonthlyReport, recordExport, type ShopInfo } from "@/server/repositories/reports";

/**
 * Build a monthly report file (PDF / Excel / CSV) and log the export. Shared by the web download route and the phone API, so both
 * produce the same file from the same figures and both leave the same audit record.
 */
type Supa = Awaited<ReturnType<typeof createClient>>;

export const REPORT_TYPES = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
} as const;
export type ReportFormat = keyof typeof REPORT_TYPES;
export const isReportFormat = (v: unknown): v is ReportFormat => typeof v === "string" && Object.prototype.hasOwnProperty.call(REPORT_TYPES, v);

export type ReportFileResult =
  | { ok: true; body: BodyInit; type: string; fileName: string }
  | { ok: false; error: string };

export async function buildReportFile(supabase: Supa, shop: ShopInfo, month: string, fmt: ReportFormat): Promise<ReportFileResult> {
  try {
    const report = await loadMonthlyReport(supabase, shop, month);
    const body = fmt === "csv" ? reportToCsv(report) : fmt === "pdf" ? reportToPdf(report) : await reportToXlsx(report);

    // Only after the file exists: an export that failed is not logged. If logging fails we refuse rather than hand out
    // an unlogged copy (the log is the audit trail).
    if (!(await recordExport(supabase, shop.shopId, report, fmt, exportTotals(report)))) {
      return { ok: false, error: "Could not record the export. Please try again." };
    }
    return { ok: true, body: body as BodyInit, type: REPORT_TYPES[fmt], fileName: reportFileName(report, fmt) };
  } catch {
    return { ok: false, error: "Could not build the report." };
  }
}
