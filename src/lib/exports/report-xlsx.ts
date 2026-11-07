import ExcelJS from "exceljs";
import { BASIS, CURRENCY_LABEL, generatedText, monthTitle, noteText, periodText, statusText, TAGLINE } from "@/features/reports/labels";
import type { MonthlyReport } from "@/features/reports/report";
import { formatBusinessDate } from "@/lib/dates/business";
import { sanitizeCell } from "./csv";

const EMERALD = "FF1F6B50";
const MONEY = '#,##0.00';
const QTY = '#,##0.###';

/** Text is passed through the same formula-injection guard as CSV; numbers are real numbers so Excel can total them. */
const txt = (v: string | null | undefined) => sanitizeCell(v ?? "");
const num = (v: string | null) => (v === null ? null : Number(v));

function headerRow(ws: ExcelJS.Worksheet, row: number, cols: string[]) {
  const r = ws.getRow(row);
  cols.forEach((c, i) => {
    const cell = r.getCell(i + 1);
    cell.value = c;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: EMERALD } };
    cell.alignment = { vertical: "middle", horizontal: i === 0 ? "left" : "center", wrapText: true };
  });
  r.height = 32;
}

function fit(ws: ExcelJS.Worksheet, min = 10, max = 48) {
  ws.columns.forEach((col) => {
    let w = min;
    col.eachCell?.({ includeEmpty: false }, (cell) => { w = Math.max(w, Math.min(max, String(cell.value ?? "").length + 2)); });
    col.width = w;
  });
}

export async function reportToXlsx(r: MonthlyReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Stokia";
  wb.title = monthTitle(r);
  wb.subject = `${r.shopName}, ${r.month}`;
  wb.created = new Date(r.generatedAt);

  /* ---- Summary ---- */
  const s = wb.addWorksheet("Summary", { views: [{ showGridLines: false }] });
  s.getCell("A1").value = "Stokia"; s.getCell("A1").font = { bold: true, size: 20, color: { argb: EMERALD } };
  s.getCell("A2").value = TAGLINE; s.getCell("A2").font = { italic: true, color: { argb: "FF66756D" } };
  s.getCell("A3").value = txt(monthTitle(r)); s.getCell("A3").font = { bold: true, size: 14 };
  const meta: [string, string][] = [
    ["Shop", txt(r.shopName)], ["Period", periodText(r)], ["Month status", statusText(r)], ["Generated", generatedText(r)], ["Currency", CURRENCY_LABEL],
    ["Opening count", formatBusinessDate(r.openingCountDate)], ["Closing count", formatBusinessDate(r.closingCountDate)],
  ];
  meta.forEach(([k, v], i) => { s.getCell(`A${5 + i}`).value = k; s.getCell(`A${5 + i}`).font = { bold: true }; s.getCell(`B${5 + i}`).value = v; });
  let row = 5 + meta.length + 1;

  s.mergeCells(`A${row}:H${row}`);
  const basis = s.getCell(`A${row}`);
  basis.value = BASIS; basis.alignment = { wrapText: true, vertical: "top" }; basis.font = { italic: true };
  basis.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDF2E7" } };
  s.getRow(row).height = 62;
  row += 2;

  s.getCell(`A${row}`).value = "Estimated Sales (LKR)"; s.getCell(`A${row}`).font = { bold: true };
  s.getCell(`B${row}`).value = Number(r.totals.estimatedSales); s.getCell(`B${row}`).numFmt = MONEY; s.getCell(`B${row}`).font = { bold: true, size: 13 };
  row++;
  s.getCell(`A${row}`).value = "Closing stock value at cost (LKR)"; s.getCell(`A${row}`).font = { bold: true };
  s.getCell(`B${row}`).value = Number(r.totals.closingValue); s.getCell(`B${row}`).numFmt = MONEY; s.getCell(`B${row}`).font = { bold: true, size: 13 };
  row += 2;

  s.getCell(`A${row}`).value = "Stock by counted unit (quantities are never added across different units)"; s.getCell(`A${row}`).font = { bold: true, size: 12 };
  row++;
  headerRow(s, row, ["Unit", "Products", "Opening", "Received", "Customer returns", "Damaged / lost", "Supplier returns", "Adjustments", "Closing", "Units sold (inferred)", "Unreconciled"]);
  row++;
  for (const u of r.stock) {
    s.getRow(row).values = [txt(u.unit), u.variants, Number(u.opening), Number(u.received), Number(u.returnedIn), Number(u.damagedOut), Number(u.otherOut), Number(u.adjustments), Number(u.closing), Number(u.unitsSold), Number(u.unreconciled)];
    for (let c = 3; c <= 11; c++) s.getCell(row, c).numFmt = QTY;
    row++;
  }
  row++;
  if (r.notes.length) {
    s.getCell(`A${row}`).value = "Notes"; s.getCell(`A${row}`).font = { bold: true, size: 12 }; row++;
    for (const n of r.notes) { s.mergeCells(`A${row}:H${row}`); s.getCell(`A${row}`).value = noteText(n); s.getCell(`A${row}`).alignment = { wrapText: true, vertical: "top" }; s.getRow(row).height = 32; row++; }
  }
  s.getColumn(1).width = 36; s.getColumn(2).width = 28;
  for (let c = 3; c <= 11; c++) s.getColumn(c).width = 16;

  /* ---- Products (one row per size) ---- */
  const p = wb.addWorksheet("Products", { views: [{ state: "frozen", ySplit: 1, xSplit: 2 }] });
  headerRow(p, 1, ["Product", "Size", "SKU", "Category", "Counted in", "Opening", "Received", "Customer returns", "Damaged / lost", "Supplier returns", "Adjustments", "Closing", "Units sold (inferred)", "Estimated Sales (LKR)", "Closing value at cost (LKR)", "Days calculated", "Days needs review", "Days pending", "Unreconciled", "Flags"]);
  r.variants.forEach((v, i) => {
    const flags = [v.flags.missingOpening && "no opening count", v.flags.missingClosing && "no closing count", v.flags.review && "needs review", v.flags.pendingDays && "pending days", v.flags.uncosted && "no purchase cost"].filter(Boolean).join("; ");
    p.getRow(i + 2).values = [txt(v.productName), txt(v.size), txt(v.sku), txt(v.categoryName), txt(v.unit), num(v.opening), num(v.received), num(v.returnedIn), num(v.damagedOut), num(v.otherOut), num(v.adjustments), num(v.closing), num(v.unitsSold), num(v.estimatedAmount), num(v.closingValue), v.daysCalculated, v.daysReview, v.daysPending, num(v.unreconciled), txt(flags)];
  });
  for (let c = 6; c <= 13; c++) p.getColumn(c).numFmt = QTY;
  p.getColumn(14).numFmt = MONEY; p.getColumn(15).numFmt = MONEY; p.getColumn(19).numFmt = QTY;
  p.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 20 } };
  fit(p);

  /* ---- Categories ---- */
  const c = wb.addWorksheet("Categories", { views: [{ state: "frozen", ySplit: 1 }] });
  headerRow(c, 1, ["Category", "Products", "Sizes", "Units sold (per unit)", "Estimated Sales (LKR)", "Share of Estimated Sales (%)"]);
  r.categories.forEach((x, i) => {
    c.getRow(i + 2).values = [txt(x.name ?? "Uncategorised"), x.products, x.variants, Object.entries(x.units).map(([u, q]) => `${Number(q)} ${u}`).join(" + "), Number(x.amount), x.sharePct];
  });
  c.getColumn(5).numFmt = MONEY; c.getColumn(6).numFmt = "0.0";
  fit(c);

  /* ---- Daily sales ---- */
  const d = wb.addWorksheet("Daily sales", { views: [{ state: "frozen", ySplit: 1 }] });
  headerRow(d, 1, ["Sales date", "Estimated Sales (LKR)", "Units sold (per unit)", "Status", "Products calculated", "Needs review", "Pending"]);
  r.daily.forEach((x, i) => {
    d.getRow(i + 2).values = [x.key, x.amount, Object.entries(x.units).map(([u, q]) => `${Number(q)} ${u}`).join(" + "), x.status === "none" ? "No data" : x.status === "partial" ? "Partly calculated" : x.status === "review" ? "Needs review" : x.status === "pending" ? "Pending" : "Calculated", x.calculated, x.needsReview, x.pending];
  });
  d.getColumn(2).numFmt = MONEY;
  fit(d);

  /* ---- Low stock ---- */
  const l = wb.addWorksheet("Low stock", { views: [{ state: "frozen", ySplit: 1 }] });
  headerRow(l, 1, ["Product", "Size", "SKU", "Counted in", "Quantity at latest count", "Low-stock level"]);
  r.lowStock.forEach((x, i) => { l.getRow(i + 2).values = [txt(x.name), txt(x.size), txt(x.sku), txt(x.unit), Number(x.quantity), Number(x.threshold)]; });
  fit(l);

  for (const ws of wb.worksheets) {
    ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
    ws.headerFooter = { oddFooter: `&LStokia - ${r.shopName.replace(/&/g, "and")} - ${r.month}&RPage &P of &N` };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
