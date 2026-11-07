// @vitest-environment node
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildPackagingReport, emptyPackagingReport, type PackagingRow } from "@/features/reports/packaging-report";
import { buildMonthlyReport, exportTotals, type BuildInput, type ReportVariantRow } from "@/features/reports/report";
import { hasPackagingSection, noteText } from "@/features/reports/labels";
import { parseCsv } from "@/lib/exports/csv";
import { reportToCsv } from "@/lib/exports/report-csv";
import { reportToPdf } from "@/lib/exports/report-pdf";
import { reportToXlsx } from "@/lib/exports/report-xlsx";

/**
 * Choco (Piece Rs. 30, Box of 20 = Rs. 550) over four October days, plus a plain product with no sellable packaging:
 *   5 Oct  145 pieces, 4 boxes entered          KNOWN     4 x 550 + 65 x 30  = 4,150.00
 *   6 Oct  100 pieces, nothing entered          UNKNOWN   100 x 30           = 3,000.00 (an estimate)
 *   7 Oct   60 pieces, 1 box entered            KNOWN     1 x 550 + 40 x 30  = 1,750.00
 *   5 Oct  Plain: 10 units                      STANDARD  10 x 10            =   100.00
 */
const line = (name: string, isBase: boolean, quantity: number, baseUnits: number, price: number) => ({ name, is_base_unit: isBase, quantity, base_units: baseUnits, unit_price: price, amount: quantity * price });
const choco = (date: string, units: string, amount: string, bucket: PackagingRow["bucket"], lines: PackagingRow["lines"], status: PackagingRow["packaging_status"] = bucket === "known" ? "known" : "unknown"): PackagingRow =>
  ({ sales_date: date, variant_id: "choco", product_name: "Choco", sku: "CHOCO-1", base_unit: "piece", units_sold: units, estimated_amount: amount, bucket, packaging_status: status, lines });
const rows: PackagingRow[] = [
  choco("2026-10-05", "145", "4150.00", "known", [line("Box", false, 4, 80, 550), line("piece", true, 65, 65, 30)]),
  choco("2026-10-06", "100", "3000.00", "unknown", null),
  choco("2026-10-07", "60", "1750.00", "known", [line("Box", false, 1, 20, 550), line("piece", true, 40, 40, 30)]),
  { sales_date: "2026-10-05", variant_id: "plain", product_name: "Plain", sku: "PLAIN-1", base_unit: "unit", units_sold: "10", estimated_amount: "100.00", bucket: "standard", packaging_status: "unknown", lines: null },
];

describe("buildPackagingReport", () => {
  const p = buildPackagingReport(rows);

  it("splits Estimated Sales into known, unknown and standard, and they add up to the whole", () => {
    expect(p.known.amount).toBe("5900.00");
    expect(p.unknown.amount).toBe("3000.00");
    expect(p.standard.amount).toBe("100.00");
    expect(p.total).toBe("9000.00");
    expect(p.known.productDays).toBe(2);
    expect(p.unknown.productDays).toBe(1);
    expect(p.standard.productDays).toBe(1);
  });

  it("totals quantities per base unit only (pieces and units are never added together)", () => {
    expect(p.known.units).toEqual({ piece: "205" });
    expect(p.unknown.units).toEqual({ piece: "100" });
    expect(p.standard.units).toEqual({ unit: "10" });
  });

  it("sums the packages sold per product over the month, boxes first then single units", () => {
    expect(p.knownProducts).toHaveLength(1);
    expect(p.knownProducts[0]).toMatchObject({ name: "Choco", days: 2, unitsSold: "205", amount: "5900.00" });
    expect(p.knownProducts[0].packages).toEqual([
      { name: "Box", isBaseUnit: false, quantity: "5", amount: "2750.00" },
      { name: "piece", isBaseUnit: true, quantity: "105", amount: "3150.00" },
    ]);
  });

  it("lists only the days that have a known breakdown, with known and estimated amounts side by side", () => {
    expect(p.daily).toEqual([
      { date: "2026-10-05", known: "4150.00", estimated: "100.00" },
      { date: "2026-10-07", known: "1750.00", estimated: "0.00" },
    ]); // 6 Oct (unknown only) is not listed
  });

  it("counts breakdowns that no longer fit as stale, and values them as unknown", () => {
    const withStale = buildPackagingReport([...rows, choco("2026-10-08", "35", "1050.00", "unknown", null, "stale")]);
    expect(withStale.staleDays).toBe(1);
    expect(withStale.unknown.amount).toBe("4050.00");
    expect(withStale.knownProducts[0].days).toBe(2); // the stale day is not in the known breakdown
  });

  it("is empty (and says nothing) when no product sells in packages", () => {
    const e = buildPackagingReport([]);
    expect(e).toEqual(emptyPackagingReport());
    expect(e.total).toBe("0.00");
  });

  it("a known day worth nothing is still a known day", () => {
    const z = buildPackagingReport([choco("2026-10-09", "0", "0.00", "known", [])]);
    expect(z.known.productDays).toBe(1);
    expect(z.daily).toEqual([{ date: "2026-10-09", known: "0.00", estimated: "0.00" }]);
  });

  it("no floating-point drift on awkward amounts", () => {
    const d = buildPackagingReport([choco("2026-10-01", "3", "0.30", "known", [line("Box", false, 3, 3, 0.1)]), choco("2026-10-02", "3", "0.60", "unknown", null)]);
    expect(d.total).toBe("0.90");
  });
});

const row = (o: Partial<ReportVariantRow> & { variant_id: string; product_name: string }): ReportVariantRow => ({
  product_id: `p-${o.variant_id}`, product_code: o.product_name.toUpperCase(), category_id: "c1", category_name: "Sweets", sku: `${o.variant_id}-1`, size_value: null, size_unit: null,
  base_unit: "piece", is_active: true, opening: "1000", closing: "500", received: "0", returned_in: "0", damaged_out: "0", other_out: "0", adjustments: "0",
  units_sold: "305", estimated_amount: "8900.00", days_calculated: 3, days_review: 0, days_pending: 0, max_revision: 1, closing_cost: "20", closing_value: "10000.00", ...o,
});
const input = (over: Partial<BuildInput> = {}): BuildInput => ({
  month: "2026-10", today: "2026-11-06", shopName: "Perera Stores", timezone: "Asia/Colombo", generatedAt: "2026-11-06T08:30:00.000Z",
  rows: [row({ variant_id: "choco", product_name: "Choco" }), row({ variant_id: "plain", product_name: "Plain", base_unit: "unit", units_sold: "10", estimated_amount: "100.00" })],
  daily: [{ sales_date: "2026-10-05", base_unit: "piece", units_sold: "145", estimated_amount: "4250.00", calculated_count: 2, needs_review_count: 0, pending_count: 0 }],
  hasClosingCount: true, fingerprint: "fp", exports: [], lowStock: [], packaging: rows, ...over,
});

describe("the monthly report carries the split", () => {
  it("includes it, and its three amounts equal the report's own Estimated Sales when the data agrees", () => {
    const r = buildMonthlyReport(input());
    expect(r.packaging.total).toBe("9000.00");
    expect(r.totals.estimatedSales).toBe("9000.00");
    expect(exportTotals(r).estimatedSalesByCertainty).toEqual({ known: "5900.00", unknown: "3000.00", standard: "100.00" });
  });

  it("a report built without packaging rows simply has no packaging section (nothing changes for shops that do not use it)", () => {
    const r = buildMonthlyReport(input({ packaging: undefined }));
    expect(r.packaging).toEqual(emptyPackagingReport());
    expect(hasPackagingSection(r)).toBe(false);
    expect(r.notes.find((n) => n.code === "packaging_stale")).toBeUndefined();
  });

  it("a shop whose products are all standard has no section either", () => {
    const only = rows.filter((x) => x.bucket === "standard");
    expect(hasPackagingSection(buildMonthlyReport(input({ packaging: only })))).toBe(false);
  });

  it("adds a note when a breakdown no longer fits", () => {
    const r = buildMonthlyReport(input({ packaging: [...rows, choco("2026-10-08", "35", "1050.00", "unknown", null, "stale")] }));
    const n = r.notes.find((x) => x.code === "packaging_stale");
    expect(n).toEqual({ code: "packaging_stale", params: { count: 1 } });
    expect(noteText(n!)).toMatch(/no longer fits/);
  });
});

describe("the exports show known and estimated apart", () => {
  const r = buildMonthlyReport(input());

  it("CSV: a labelled split that adds up, the known products with their packages, and the known days", () => {
    const csv = reportToCsv(r);
    const cells = parseCsv(csv);
    const find = (label: string) => cells.find((c) => c[0] === label);
    expect(find("Known packaging breakdown")).toEqual(["Known packaging breakdown", "2", "205 piece", "5900.00"]);
    expect(find("Estimated, packaging unknown")).toEqual(["Estimated, packaging unknown", "1", "100 piece", "3000.00"]);
    expect(find("Products without sellable packaging")).toEqual(["Products without sellable packaging", "1", "10 unit", "100.00"]);
    expect(find("Total (equals Estimated Sales)")?.[3]).toBe("9000.00");
    expect(cells.find((c) => c[0] === "Choco" && c[5]?.includes("5 Box"))).toBeTruthy();
    expect(csv).toContain("Days with a known breakdown");
    expect(csv).toMatch(/KNOWN: box or pack sales were entered/);
  });

  it("CSV: no packaging block at all when the shop does not use packaging prices", () => {
    const csv = reportToCsv(buildMonthlyReport(input({ packaging: undefined })));
    expect(csv).not.toContain("Estimated Sales by certainty");
    expect(csv).not.toContain("Known packaging breakdown");
  });

  it("Excel: a Packaging sheet with the same figures as real numbers; absent when not used", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await reportToXlsx(r)) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Packaging")!;
    expect(ws).toBeTruthy();
    const rowOf = (label: string) => { let found: ExcelJS.Row | undefined; ws.eachRow((x) => { if (x.getCell(1).value === label) found = x; }); return found; };
    expect(rowOf("Known packaging breakdown")!.getCell(4).value).toBe(5900);
    expect(rowOf("Estimated, packaging unknown")!.getCell(4).value).toBe(3000);
    expect(rowOf("Total (equals Estimated Sales)")!.getCell(4).value).toBe(9000);

    const none = new ExcelJS.Workbook();
    await none.xlsx.load((await reportToXlsx(buildMonthlyReport(input({ packaging: undefined })))) as unknown as ArrayBuffer);
    expect(none.getWorksheet("Packaging")).toBeUndefined();
  });

  it("PDF: still builds, and is longer with the packaging section than without", () => {
    const withSection = reportToPdf(r);
    const without = reportToPdf(buildMonthlyReport(input({ packaging: undefined })));
    expect(Buffer.from(withSection.subarray(0, 4)).toString()).toBe("%PDF");
    expect(withSection.length).toBeGreaterThan(without.length);
  });
});
