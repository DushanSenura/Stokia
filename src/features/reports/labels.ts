/**
 * English wording for the exported files (PDF / Excel / CSV). Exports are always English so a file means the same
 * thing to an accountant or a bank, whichever language the shop owner uses in the app. (Product names are kept as typed.)
 */
import { formatBusinessDate, formatMonth } from "@/lib/dates/business";
import type { ExportFormat, MonthlyReport, ReportNote } from "./report";

export const TITLE = "Stokia Monthly Report";
export const TAGLINE = "Count Today. Know Yesterday.";
export const CURRENCY_LABEL = "LKR (Sri Lankan Rupees)";

/** The statement that must accompany every figure: what these numbers are, and what they are not. */
export const BASIS =
  "Units sold are INFERRED from morning stock counts (opening + recorded movements - closing). Sales values are ESTIMATED SALES: inferred units x the selling price on each sales date. " +
  "They are not confirmed cash receipts: discounts, special prices, credit sales and refunds are not visible in stock counts. Closing stock is valued at purchase cost, not selling price.";

export const STATUS_LABEL = { in_progress: "In progress", pending: "Pending (waiting for closing count)", complete: "Complete" } as const;

export function noteText(n: ReportNote): string {
  const p = n.params;
  switch (n.code) {
    case "in_progress": return "This month is still in progress. Figures run up to the latest confirmed count and will change.";
    case "waiting_closing_count": return `The last day of the month is calculated by the ${formatBusinessDate(String(p.date))} count, which has not been confirmed yet. Totals are incomplete.`;
    case "recalculated": return "Some days were recalculated after their first calculation (a late movement or a corrected count). Figures here are the latest.";
    case "days_review": return `Product-days needing review: ${p.count} (stock rose with nothing recorded). They are left out of sales.`;
    case "days_pending": return `Product-days that could not be calculated: ${p.count} (a morning count was missing). They are left out of sales.`;
    case "without_opening": return `Products with no opening count: ${p.count}. They are left out of the opening stock totals.`;
    case "without_closing": return `Products with no closing count: ${p.count}. They are left out of the closing stock totals.`;
    case "uncosted": return `Products in stock with no purchase cost: ${p.count}. They are not in the closing stock value, so it is a minimum.`;
    case "packaging_stale": return `Product-days with a box breakdown that no longer fits after a count or movement changed: ${p.count}. They are valued as estimates with unknown packaging until the breakdown is confirmed or changed.`;
  }
}

/** Wording for the split of Estimated Sales by certainty of the packaging mix. */
export const PACKAGING_BASIS =
  "Estimated Sales are split by how certain the packaging mix is. KNOWN: box or pack sales were entered, so each day uses the package prices in force on that day. " +
  "ESTIMATED, PACKAGING UNKNOWN: the product can be sold in packages but no box sales were entered, so the whole inferred quantity is valued at the single-unit price. " +
  "STANDARD: the product has no sellable packaging. The three groups add up to Estimated Sales and are never blended into one unlabelled figure.";
export const BUCKET_LABEL = { known: "Known packaging breakdown", unknown: "Estimated, packaging unknown", standard: "Products without sellable packaging" } as const;

/** True when the report has anything to say about packaging (some product can be sold in packages, or a breakdown was recorded). */
export const hasPackagingSection = (r: MonthlyReport) => r.packaging.known.productDays > 0 || r.packaging.unknown.productDays > 0;

export const unitsText = (units: Record<string, string>) => Object.entries(units).map(([u, q]) => `${Number(q)} ${u}`).join(" + ") || "-";

export function periodText(r: MonthlyReport): string {
  return `${formatBusinessDate(r.period.from)} to ${formatBusinessDate(r.period.to)}`;
}

export function monthTitle(r: MonthlyReport): string {
  return `${TITLE}: ${formatMonth(r.month)}`;
}

export function generatedText(r: MonthlyReport): string {
  const d = new Date(r.generatedAt);
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: r.timezone, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${f} (${r.timezone})`;
}

export function statusText(r: MonthlyReport): string {
  const parts: string[] = [STATUS_LABEL[r.status.kind]];
  if (r.recalculated) parts.push("Recalculated");
  if (r.lastExport) parts.push(r.lastExport.stale ? "Changed since last export" : "Exported");
  return parts.join(", ");
}

export const FORMAT_NAME: Record<ExportFormat, string> = { pdf: "PDF", xlsx: "Excel", csv: "CSV", print: "Print" };

/** A file name safe on every operating system. */
export function reportFileName(r: MonthlyReport, ext: "pdf" | "xlsx" | "csv"): string {
  const shop = r.shopName.normalize("NFKD").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 40) || "shop";
  return `stokia-report-${r.month}-${shop}.${ext}`.toLowerCase();
}
