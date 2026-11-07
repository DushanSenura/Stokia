import { BASIS, CURRENCY_LABEL, generatedText, noteText, periodText, statusText, TAGLINE, TITLE } from "@/features/reports/labels";
import type { MonthlyReport } from "@/features/reports/report";
import { toCsv } from "./csv";

const n = (v: string | null): string => (v === null ? "" : String(Number(v)));

/**
 * CSV: a labelled header block (so the file is self-explanatory when opened alone), then one row per product size.
 * Every text cell goes through the formula-injection guard in `toCsv`; numbers are written as plain numbers.
 */
export function reportToCsv(r: MonthlyReport): string {
  const rows: unknown[][] = [
    [`${TITLE} (${TAGLINE})`],
    ["Shop", r.shopName],
    ["Report month", r.month],
    ["Period", periodText(r)],
    ["Month status", statusText(r)],
    ["Generated", generatedText(r)],
    ["Currency", CURRENCY_LABEL],
    ["Basis", BASIS],
    ["Estimated Sales (LKR)", r.totals.estimatedSales],
    ["Closing stock value at purchase cost (LKR)", r.totals.closingValue],
    ...r.notes.map((x) => ["Note", noteText(x)]),
    [],
    [
      "category", "product", "product_code", "sku", "size", "counted_in_unit",
      "opening_stock", "stock_received", "customer_returns", "damaged_expired_discarded", "supplier_returns", "adjustments", "closing_stock",
      "units_sold_inferred", "estimated_sales_lkr", "closing_stock_value_at_cost_lkr",
      "days_calculated", "days_needs_review", "days_pending", "unreconciled_units", "flags",
    ],
    ...r.variants.map((v) => [
      v.categoryName ?? "", v.productName, v.productCode, v.sku, v.size, v.unit,
      n(v.opening), n(v.received), n(v.returnedIn), n(v.damagedOut), n(v.otherOut), n(v.adjustments), n(v.closing),
      n(v.unitsSold), v.estimatedAmount, v.closingValue ?? "",
      v.daysCalculated, v.daysReview, v.daysPending, v.unreconciled === null ? "" : n(v.unreconciled),
      [v.flags.missingOpening && "no opening count", v.flags.missingClosing && "no closing count", v.flags.review && "needs review", v.flags.pendingDays && "pending days", v.flags.uncosted && "no purchase cost"].filter(Boolean).join("; "),
    ]),
  ];
  return toCsv(rows);
}
