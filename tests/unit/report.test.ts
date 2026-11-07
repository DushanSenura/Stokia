// @vitest-environment node
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildMonthlyReport, reportStatus, type BuildInput, type ReportVariantRow } from "@/features/reports/report";
import { noteText, reportFileName } from "@/features/reports/labels";
import { parseCsv } from "@/lib/exports/csv";
import { reportToCsv } from "@/lib/exports/report-csv";
import { pdfSafe, reportToPdf } from "@/lib/exports/report-pdf";
import { reportToXlsx } from "@/lib/exports/report-xlsx";

const row = (o: Partial<ReportVariantRow> & { variant_id: string; product_name: string }): ReportVariantRow => ({
  product_id: `p-${o.variant_id}`, product_code: o.product_name.toUpperCase(), category_id: "c1", category_name: "Spices", sku: `${o.variant_id}-1`, size_value: "250", size_unit: "g",
  base_unit: "packet", is_active: true, opening: "1000", closing: "800", received: "0", returned_in: "0", damaged_out: "0", other_out: "0", adjustments: "0",
  units_sold: "200", estimated_amount: "30000.00", days_calculated: 30, days_review: 0, days_pending: 0, max_revision: 1, closing_cost: "100", closing_value: "80000.00", ...o,
});

const rows: ReportVariantRow[] = [
  row({ variant_id: "a", product_name: "Chilli" }),
  row({ variant_id: "b", product_name: "Oil", category_id: "c2", category_name: "Oils", base_unit: "bottle", size_value: "1", size_unit: "l", opening: "400", closing: "270", received: "0", damaged_out: "2", units_sold: "128", estimated_amount: "38400.00", closing_cost: "250", closing_value: "67500.00" }),
  row({ variant_id: "c", product_name: "Gamma", opening: "500", closing: "345", units_sold: "155", estimated_amount: "7750.00", days_calculated: 29, days_review: 1, closing_cost: null, closing_value: null }), // 500-345-155 = 0? (see below)
  row({ variant_id: "d", product_name: "Epsilon", opening: null, closing: "20", units_sold: "0", estimated_amount: "0.00", days_calculated: 0, days_pending: 30, closing_cost: "20", closing_value: "400.00" }),
];

const base = (over: Partial<BuildInput> = {}): BuildInput => ({
  month: "2026-10", today: "2026-11-06", shopName: "Perera Stores", timezone: "Asia/Colombo", generatedAt: "2026-11-06T08:30:00.000Z",
  rows, daily: [{ sales_date: "2026-10-01", base_unit: "packet", units_sold: "10", estimated_amount: "1500.00", calculated_count: 1, needs_review_count: 0, pending_count: 0 }],
  hasClosingCount: true, fingerprint: "fp-now", exports: [], lowStock: [{ name: "Sugar", size: "1 kg", sku: "SUG-1", unit: "packet", quantity: "0", threshold: "20" }], ...over,
});

describe("report status (month boundary rule)", () => {
  it("October is complete only once the Nov 1 count is confirmed; until then pending", () => {
    expect(reportStatus("2026-10", "2026-11-06", true)).toEqual({ kind: "complete", waitingFor: null });
    expect(reportStatus("2026-10", "2026-11-06", false)).toEqual({ kind: "pending", waitingFor: "2026-11-01" });
  });
  it("the current month is always in progress, even if a later count somehow exists", () => {
    expect(reportStatus("2026-11", "2026-11-06", true)).toEqual({ kind: "in_progress", waitingFor: null });
  });
  it("December's closing count is January 1 of the next year", () => {
    expect(reportStatus("2026-12", "2027-01-05", false).waitingFor).toBe("2027-01-01");
  });
});

describe("buildMonthlyReport", () => {
  const r = buildMonthlyReport(base());
  it("money adds across products; quantities are totalled per unit and never mixed", () => {
    expect(r.totals.estimatedSales).toBe("76150.00");
    expect(r.stock.map((u) => u.unit)).toEqual(["bottle", "packet"]);
    const packet = r.stock.find((u) => u.unit === "packet")!, bottle = r.stock.find((u) => u.unit === "bottle")!;
    expect(packet).toMatchObject({ variants: 3, opening: "1500", closing: "1165", unitsSold: "355", withoutOpening: 1 });
    expect(bottle).toMatchObject({ variants: 1, opening: "400", closing: "270", damagedOut: "2", unitsSold: "128" });
  });
  it("closing stock value is the value of the CLOSING counts at cost; unpriced products are flagged, not guessed", () => {
    expect(r.totals.closingValue).toBe("147900.00");               // 80,000 + 67,500 + 400 (Gamma has no cost)
    expect(r.variants.find((v) => v.productName === "Gamma")!.flags.uncosted).toBe(true);
    expect(r.totals.uncostedVariants).toBe(1);
    expect(r.notes.some((n) => n.code === "uncosted")).toBe(true);
  });
  it("opening + movements - closing - sold = 0 for a fully calculated product, and exposes the gap otherwise", () => {
    expect(r.variants.find((v) => v.productName === "Chilli")!.unreconciled).toBe("0");
    expect(r.variants.find((v) => v.productName === "Oil")!.unreconciled).toBe("0");   // 400 - 2 - 270 - 128
    expect(r.variants.find((v) => v.productName === "Gamma")!.unreconciled).toBe("0");
    expect(r.variants.find((v) => v.productName === "Epsilon")!.unreconciled).toBeNull(); // no opening count: cannot be reconciled
    const gap = buildMonthlyReport(base({ rows: [row({ variant_id: "g", product_name: "Gap", units_sold: "175", days_review: 1 })] }));
    expect(gap.variants[0].unreconciled).toBe("25");   // 1000 - 800 - 175: the quantity sitting in a day that needed review
  });
  it("flags products with missing counts, review days and pending days (pending days only matter once the month is closed)", () => {
    const eps = r.variants.find((v) => v.productName === "Epsilon")!;
    expect(eps.flags).toMatchObject({ missingOpening: true, pendingDays: true, missingClosing: false });
    expect(r.variants.find((v) => v.productName === "Gamma")!.flags.review).toBe(true);
    const open = buildMonthlyReport(base({ month: "2026-11" }));
    expect(open.variants.find((v) => v.productName === "Epsilon")!.flags.pendingDays).toBe(false);
  });
  it("explains the caveats in notes", () => {
    const codes = r.notes.map((n) => n.code);
    expect(codes).toEqual(expect.arrayContaining(["days_review", "days_pending", "without_opening", "uncosted"]));
    expect(codes).not.toContain("in_progress");
    expect(buildMonthlyReport(base({ month: "2026-11" })).notes[0].code).toBe("in_progress");
    expect(buildMonthlyReport(base({ hasClosingCount: false })).notes[0]).toMatchObject({ code: "waiting_closing_count", params: { date: "2026-11-01" } });
  });
  it("is 'recalculated' when any day was recomputed after its first calculation", () => {
    expect(r.recalculated).toBe(false);
    expect(buildMonthlyReport(base({ rows: [row({ variant_id: "a", product_name: "Chilli", max_revision: 3 })] })).recalculated).toBe(true);
  });
  it("tracks exports: the latest one, and whether the figures changed after it", () => {
    const e = (at: string, fp: string, format: "pdf" | "csv" = "pdf") => ({ format, exported_at: at, fingerprint: fp });
    expect(buildMonthlyReport(base()).lastExport).toBeNull();
    expect(buildMonthlyReport(base({ exports: [e("2026-11-02T00:00:00Z", "fp-now")] })).lastExport).toEqual({ format: "pdf", at: "2026-11-02T00:00:00Z", stale: false });
    expect(buildMonthlyReport(base({ exports: [e("2026-11-02T00:00:00Z", "old-fp")] })).lastExport?.stale).toBe(true);
    const latest = buildMonthlyReport(base({ exports: [e("2026-11-01T00:00:00Z", "old-fp"), e("2026-11-05T00:00:00Z", "fp-now", "csv")] })).lastExport;
    expect(latest).toMatchObject({ format: "csv", stale: false });
  });
  it("rolls variants up into products and categories (by money) and builds the day-by-day series", () => {
    expect(r.categories.map((c) => c.name)).toEqual(["Oils", "Spices"]); // 38,400 vs 30,000 + 7,750
    expect(r.products).toHaveLength(4);
    expect(r.daily).toHaveLength(31);
    expect(r.daily[0]).toMatchObject({ key: "2026-10-01", amount: 1500, status: "calculated" });
    expect(r.period).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(r.closingCountDate).toBe("2026-11-01");
  });
  it("keeps products that have no sales and no counts out of the totals (empty report is valid)", () => {
    const empty = buildMonthlyReport(base({ rows: [], daily: [] }));
    expect(empty.totals).toMatchObject({ estimatedSales: "0.00", closingValue: "0.00" });
    expect(empty.stock).toEqual([]);
  });
});

describe("CSV export", () => {
  const csv = reportToCsv(buildMonthlyReport(base()));
  const table = parseCsv(csv);
  it("starts with a self-explanatory header block: brand, shop, period, generated time, currency and the basis", () => {
    const text = csv;
    for (const must of ["Stokia Monthly Report", "Perera Stores", "1 October 2026 to 31 October 2026", "LKR (Sri Lankan Rupees)", "ESTIMATED SALES", "not confirmed cash receipts", "Generated"]) expect(text).toContain(must);
    expect(table[0][0]).toContain("Stokia Monthly Report");
  });
  it("has one data row per size under a clear header, with numbers as plain numbers", () => {
    const h = table.findIndex((r) => r[0] === "category");
    expect(table[h]).toContain("units_sold_inferred");
    expect(table.slice(h + 1)).toHaveLength(4);
    const chilli = table[h + 1];
    expect(chilli[table[h].indexOf("estimated_sales_lkr")]).toBe("30000.00");
    expect(chilli[table[h].indexOf("opening_stock")]).toBe("1000");
  });
  it("leaves missing counts BLANK (never zero)", () => {
    const h = table.findIndex((r) => r[0] === "category");
    const eps = table.slice(h + 1).find((r) => r[1] === "Epsilon")!;
    expect(eps[table[h].indexOf("opening_stock")]).toBe("");
  });
  it("neutralises spreadsheet formulas in every text field (formula injection)", () => {
    const evil = reportToCsv(buildMonthlyReport(base({ shopName: '=cmd|"/c calc"!A1', rows: [row({ variant_id: "x", product_name: '=HYPERLINK("http://evil","click")', category_name: "+SUM(1)", sku: "@x" })] })));
    const cells = parseCsv(evil).flat();
    expect(cells.some((c) => c.startsWith("=") || c.startsWith("+") || c.startsWith("@"))).toBe(false);
    expect(cells).toContain(`'=HYPERLINK("http://evil","click")`);
  });
});

describe("Excel export", () => {
  it("is a real workbook with branded Summary, Products, Categories, Daily sales and Low stock sheets", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await reportToXlsx(buildMonthlyReport(base()))) as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "Products", "Categories", "Daily sales", "Low stock"]);
    expect(wb.creator).toBe("Stokia");
    const s = wb.getWorksheet("Summary")!;
    const all = s.getSheetValues().flat().map(String).join("|");
    for (const must of ["Stokia", "Stokia Monthly Report: October 2026", "Perera Stores", "LKR (Sri Lankan Rupees)", "ESTIMATED SALES", "Estimated Sales (LKR)"]) expect(all).toContain(must);
  });
  it("writes quantities and money as real numbers (so they can be totalled), blanks for uncounted stock", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await reportToXlsx(buildMonthlyReport(base()))) as unknown as ArrayBuffer);
    const p = wb.getWorksheet("Products")!;
    const header = (p.getRow(1).values as unknown[]).map(String);
    const col = (name: string) => header.indexOf(name);
    const chilli = p.getRow(2);
    expect(typeof chilli.getCell(col("Estimated Sales (LKR)")).value).toBe("number");
    expect(chilli.getCell(col("Estimated Sales (LKR)")).value).toBe(30000);
    expect(chilli.getCell(col("Opening")).value).toBe(1000);
    const eps = p.getRow(5);
    expect(eps.getCell(col("Opening")).value ?? null).toBeNull();
    expect(p.getRow(2).getCell(col("Estimated Sales (LKR)")).numFmt).toBe("#,##0.00");
    expect(p.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  });
  it("neutralises formulas in text cells", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await reportToXlsx(buildMonthlyReport(base({ rows: [row({ variant_id: "x", product_name: "=1+1", sku: "-2+3" })] })))) as unknown as ArrayBuffer);
    const p = wb.getWorksheet("Products")!;
    expect(String(p.getRow(2).getCell(1).value)).toBe("'=1+1");
    expect(String(p.getRow(2).getCell(3).value)).toBe("'-2+3");
  });
  it("keeps Sinhala text intact (unlike the PDF)", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await reportToXlsx(buildMonthlyReport(base({ rows: [row({ variant_id: "x", product_name: "මිරිස් කුඩු" })] })))) as unknown as ArrayBuffer);
    expect(wb.getWorksheet("Products")!.getRow(2).getCell(1).value).toBe("මිරිස් කුඩු");
  });
});

describe("PDF export", () => {
  // PDF text strings escape parentheses and backslashes; undo that so we can search the visible text
  const text = (u8: Uint8Array) => Buffer.from(u8).toString("latin1").replaceAll("\\(", "(").replaceAll("\\)", ")");
  it("is a PDF with the brand, shop, title, period, generated time, currency, status and the 'not cash' statement", () => {
    const pdf = reportToPdf(buildMonthlyReport(base()));
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe("%PDF-");
    const t = text(pdf);
    for (const must of ["Stokia", "Perera Stores", "Stokia Monthly Report: October 2026", "1 October 2026 to 31 October 2026", "LKR (Sri Lankan Rupees)", "ESTIMATED SALES", "not confirmed cash", "Generated", "Complete", "Estimated Sales", "Low-stock items"]) expect(t, must).toContain(must);
  });
  it("labels an incomplete month clearly", () => {
    const t = text(reportToPdf(buildMonthlyReport(base({ hasClosingCount: false }))));
    expect(t).toContain("Pending (waiting for closing count)");
    expect(t).toContain(noteText({ code: "waiting_closing_count", params: { date: "2026-11-01" } }).slice(0, 40));
  });
  it("paginates a long product list and numbers the pages", () => {
    const many = Array.from({ length: 160 }, (_, i) => row({ variant_id: `v${i}`, product_name: `Product ${i}` }));
    const t = text(reportToPdf(buildMonthlyReport(base({ rows: many }))));
    expect((t.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(2);
    expect(t).toMatch(/Page 1 of \d+/);
  });
  it("cannot draw Sinhala with its built-in font: it substitutes '?' and SAYS so instead of printing garbage", () => {
    expect(pdfSafe("මිරිස්")).toBe("??????");
    expect(pdfSafe("Café – Rs. 5")).toBe("Café - Rs. 5");
    const t = text(reportToPdf(buildMonthlyReport(base({ rows: [row({ variant_id: "x", product_name: "මිරිස් කුඩු" })] }))));
    expect(t).toContain("could not be shown in this PDF");
    expect(t).toContain("Excel and CSV exports keep every character");
  });
});

describe("file names", () => {
  it("are safe on every operating system", () => {
    const r = buildMonthlyReport(base({ shopName: 'Perera / Sons: "Stores"?' }));
    expect(reportFileName(r, "pdf")).toBe("stokia-report-2026-10-perera-sons-stores.pdf");
    expect(reportFileName(buildMonthlyReport(base({ shopName: "මිරිස්" })), "csv")).toBe("stokia-report-2026-10-shop.csv");
  });
});
