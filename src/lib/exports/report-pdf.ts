import { jsPDF } from "jspdf";
import autoTable, { type CellDef } from "jspdf-autotable";
import { BASIS, BUCKET_LABEL, CURRENCY_LABEL, generatedText, hasPackagingSection, monthTitle, noteText, PACKAGING_BASIS, periodText, statusText, TAGLINE, unitsText } from "@/features/reports/labels";
import type { MonthlyReport } from "@/features/reports/report";
import { formatBusinessDate } from "@/lib/dates/business";
import { formatLkr } from "@/lib/formatting/money";

const EMERALD: [number, number, number] = [31, 107, 80];
const INK: [number, number, number] = [31, 42, 36];
const MUTED: [number, number, number] = [102, 117, 109];
export const MAX_PDF_VARIANTS = 2000;

/** Replacement count, so the report can say honestly that some characters could not be drawn. */
let replaced = 0;
const REPLACEMENTS: Record<string, string> = { "—": "-", "–": "-", "‘": "'", "’": "'", "“": '"', "”": '"', "…": "...", "•": "-", "×": "x", "≤": "<=", "≥": ">=", "−": "-", "₨": "Rs." };

/**
 * The PDF uses the built-in Helvetica (Latin) font, which cannot draw Sinhala/Tamil letters. Anything it cannot draw is
 * replaced with "?" and counted, and the report says so; the Excel and CSV exports keep every character.
 */
export function pdfSafe(text: string | null | undefined): string {
  let out = "";
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0)!;
    if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) out += ch;
    else if (REPLACEMENTS[ch]) out += REPLACEMENTS[ch];
    else if (code === 9 || code === 10) out += " ";
    else { out += "?"; replaced++; }
  }
  return out;
}

const q = (v: string | null) => (v === null ? "-" : Number(v).toLocaleString("en-US", { maximumFractionDigits: 3 }));
const money = (v: string | null) => (v === null ? "-" : formatLkr(v).replace("Rs. ", ""));
const right = (content: string): CellDef => ({ content: pdfSafe(content), styles: { halign: "right" } });

export function reportToPdf(r: MonthlyReport): Uint8Array {
  replaced = 0;
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4", compress: false });
  doc.setProperties({ title: pdfSafe(monthTitle(r)), subject: pdfSafe(`${r.shopName}, ${r.month}`), author: "Stokia", creator: "Stokia" });
  const W = doc.internal.pageSize.getWidth();
  const M = 36;
  let y = M;

  // ---- branded header ----
  doc.setFillColor(...EMERALD); doc.roundedRect(M, y, 28, 28, 6, 6, "F");
  doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.text("S", M + 14, y + 20, { align: "center" });
  doc.setTextColor(...EMERALD); doc.setFontSize(20); doc.text("Stokia", M + 38, y + 16);
  doc.setTextColor(...MUTED); doc.setFont("helvetica", "italic"); doc.setFontSize(9); doc.text(pdfSafe(TAGLINE), M + 38, y + 29);
  doc.setTextColor(...INK); doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.text(pdfSafe(monthTitle(r)), W - M, y + 14, { align: "right" });
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...MUTED); doc.text(pdfSafe(r.shopName), W - M, y + 28, { align: "right" });
  y += 46;

  autoTable(doc, {
    startY: y, theme: "plain", margin: { left: M, right: M }, styles: { fontSize: 8.5, cellPadding: 2, textColor: INK },
    columnStyles: { 0: { fontStyle: "bold", cellWidth: 90 }, 2: { fontStyle: "bold", cellWidth: 90 } },
    body: [
      ["Period", pdfSafe(periodText(r)), "Month status", pdfSafe(statusText(r))],
      ["Generated", pdfSafe(generatedText(r)), "Currency", pdfSafe(CURRENCY_LABEL)],
      ["Opening count", pdfSafe(formatBusinessDate(r.openingCountDate)), "Closing count", pdfSafe(formatBusinessDate(r.closingCountDate))],
    ],
  });
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;

  // basis statement
  const basisLines = doc.splitTextToSize(pdfSafe(BASIS), W - 2 * M - 16) as string[];
  const boxH = basisLines.length * 10.5 + 12;
  doc.setFillColor(221, 242, 231); doc.roundedRect(M, y, W - 2 * M, boxH, 6, 6, "F");
  doc.setFont("helvetica", "italic"); doc.setFontSize(8.5); doc.setTextColor(...INK); doc.text(basisLines, M + 8, y + 14);
  y += boxH + 10;

  // headline figures
  autoTable(doc, {
    startY: y, theme: "grid", margin: { left: M, right: M }, styles: { fontSize: 10, cellPadding: 6, lineColor: [217, 227, 221] },
    head: [["Estimated Sales (not confirmed cash)", "Closing stock value at purchase cost", "Product-days calculated", "Needs review", "Pending"]],
    headStyles: { fillColor: EMERALD, textColor: 255, fontSize: 8.5 },
    body: [[{ content: formatLkr(r.totals.estimatedSales), styles: { fontStyle: "bold", fontSize: 13 } }, { content: formatLkr(r.totals.closingValue), styles: { fontStyle: "bold", fontSize: 13 } }, String(r.totals.daysCalculated), String(r.totals.daysReview), String(r.totals.daysPending)]],
  });
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 14;

  const heading = (title: string, sub?: string) => {
    if (y > doc.internal.pageSize.getHeight() - 90) { doc.addPage(); y = M; }
    doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(...INK); doc.text(pdfSafe(title), M, y);
    if (sub) { doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...MUTED); doc.text(pdfSafe(sub), M, y + 11); }
    y += sub ? 16 : 8;
  };
  const table = (opts: Parameters<typeof autoTable>[1]) => {
    autoTable(doc, { margin: { left: M, right: M }, theme: "striped", styles: { fontSize: 7.5, cellPadding: 3, textColor: INK, overflow: "linebreak" }, headStyles: { fillColor: EMERALD, textColor: 255, halign: "center" }, alternateRowStyles: { fillColor: [238, 242, 239] }, ...opts, startY: y });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 14;
  };

  // ---- notes ----
  if (r.notes.length) {
    heading("Notes");
    table({ theme: "plain", head: [], body: r.notes.map((n) => [pdfSafe(`- ${noteText(n)}`)]), styles: { fontSize: 8.5, cellPadding: 2 } });
  }

  // ---- Estimated Sales by certainty of the packaging mix ----
  if (hasPackagingSection(r)) {
    const p = r.packaging;
    heading("Estimated Sales by certainty of packaging", PACKAGING_BASIS.slice(0, 140) + "...");
    table({
      head: [["Basis", "Product-days", "Units sold (inferred)", "Estimated Sales (Rs.)"]],
      body: [
        ...(["known", "unknown", "standard"] as const).map((b) => [pdfSafe(BUCKET_LABEL[b]), right(String(p[b].productDays)), pdfSafe(unitsText(p[b].units)), right(money(p[b].amount))]),
        [{ content: "Total (equals Estimated Sales)", styles: { fontStyle: "bold" } }, "", "", { content: pdfSafe(money(p.total)), styles: { fontStyle: "bold", halign: "right" } }],
      ],
    });
    if (p.knownProducts.length) {
      heading("Known packaging breakdown by product", "Packages entered by the owner; the rest of each day's inferred sales is valued per single unit.");
      table({
        head: [["Product", "SKU", "Days", "Units sold", "Packages sold", "Estimated Sales (Rs.)"]],
        body: p.knownProducts.map((k) => [pdfSafe(k.name), pdfSafe(k.sku), right(String(k.days)), right(`${q(k.unitsSold)} ${pdfSafe(k.unit)}`), pdfSafe(k.packages.map((x) => `${q(x.quantity)} ${x.name}`).join(" + ")), right(money(k.amount))]),
      });
    }
  }

  // ---- stock by unit ----
  heading("Stock by counted unit", "Quantities are shown per unit; packets, bottles and other units are never added together. Opening = count on the 1st; closing = count on the 1st of the next month.");
  table({
    head: [["Unit", "Products", "Opening", "Received", "Cust. returns", "Damaged / lost", "Supplier returns", "Adjustments", "Closing", "Units sold (inferred)", "Unreconciled"]],
    body: r.stock.map((u) => [pdfSafe(u.unit), right(String(u.variants)), right(q(u.opening)), right(q(u.received)), right(q(u.returnedIn)), right(q(u.damagedOut)), right(q(u.otherOut)), right(q(u.adjustments)), right(q(u.closing)), right(q(u.unitsSold)), right(q(u.unreconciled))]),
  });

  // ---- categories ----
  heading("Category summary");
  table({
    head: [["Category", "Products", "Sizes", "Units sold (per unit)", "Estimated Sales (Rs.)", "Share (%)"]],
    body: r.categories.map((c) => [pdfSafe(c.name ?? "Uncategorised"), right(String(c.products)), right(String(c.variants)), pdfSafe(Object.entries(c.units).map(([u, v]) => `${q(v)} ${u}`).join(" + ") || "-"), right(money(c.amount)), right(c.sharePct.toFixed(1))]),
  });

  // ---- products / sizes ----
  const shown = r.variants.slice(0, MAX_PDF_VARIANTS);
  heading("Products and sizes", shown.length < r.variants.length ? `Showing the first ${shown.length} of ${r.variants.length} sizes. The Excel and CSV exports contain every row.` : "One row per size. Stock is shown in each size's own counted unit.");
  table({
    styles: { fontSize: 6.8, cellPadding: 2.4, textColor: INK },
    head: [["Product", "Size", "SKU", "Unit", "Opening", "Recv.", "Ret.", "Dmg/lost", "Sup. ret.", "Adj.", "Closing", "Units sold", "Est. sales (Rs.)", "Closing value (Rs.)", "Notes"]],
    body: shown.map((v) => [
      pdfSafe(v.productName), pdfSafe(v.size), pdfSafe(v.sku), pdfSafe(v.unit),
      right(q(v.opening)), right(q(v.received)), right(q(v.returnedIn)), right(q(v.damagedOut)), right(q(v.otherOut)), right(q(v.adjustments)), right(q(v.closing)),
      right(q(v.unitsSold)), right(money(v.estimatedAmount)), right(money(v.closingValue)),
      pdfSafe([v.flags.missingOpening && "no opening", v.flags.missingClosing && "no closing", v.flags.review && "review", v.flags.pendingDays && "pending", v.flags.uncosted && "no cost"].filter(Boolean).join(", ")),
    ]),
  });

  // ---- daily sales ----
  heading("Daily Estimated Sales", "A dash means no figure for that day (pending or not counted), not zero sales.");
  table({
    head: [["Date", "Estimated Sales (Rs.)", "Units sold (per unit)", "Status"]],
    body: r.daily.filter((d) => d.status !== "none").map((d) => [pdfSafe(formatBusinessDate(d.key, "en", { day: "numeric", month: "short" })), right(d.amount === null ? "-" : money(String(d.amount))), pdfSafe(Object.entries(d.units).map(([u, v]) => `${q(v)} ${u}`).join(" + ") || "-"), d.status === "partial" ? "Partly calculated" : d.status === "review" ? "Needs review" : d.status === "pending" ? "Pending" : "Calculated"]),
  });

  // ---- low stock ----
  heading("Low-stock items", "From the latest confirmed count: quantity at or below the product's low-stock level.");
  table({
    head: [["Product", "Size", "SKU", "Counted in", "Quantity", "Level"]],
    body: r.lowStock.length ? r.lowStock.map((x) => [pdfSafe(x.name), pdfSafe(x.size), pdfSafe(x.sku), pdfSafe(x.unit), right(q(x.quantity)), right(q(x.threshold))]) : [[{ content: "No products are at or below their low-stock level.", colSpan: 6 }]],
  });

  if (replaced > 0) {
    doc.setFont("helvetica", "italic"); doc.setFontSize(8); doc.setTextColor(...MUTED);
    doc.text(pdfSafe(`${replaced} character(s) could not be shown in this PDF (shown as "?"). The Excel and CSV exports keep every character.`), M, y);
  }

  // ---- footer on every page ----
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    const H = doc.internal.pageSize.getHeight();
    doc.setDrawColor(217, 227, 221); doc.line(M, H - 28, W - M, H - 28);
    doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
    doc.text(pdfSafe(`Stokia  |  ${r.shopName}  |  ${r.month}  |  Generated ${generatedText(r)}  |  Estimated Sales are not confirmed cash`), M, H - 16);
    doc.text(`Page ${p} of ${pages}`, W - M, H - 16, { align: "right" });
  }
  return new Uint8Array(doc.output("arraybuffer"));
}
