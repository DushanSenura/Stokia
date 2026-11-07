/** Minimal RFC 4180 CSV parser/serializer with spreadsheet formula-injection protection. */

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * Neutralise cells that Excel/Sheets would execute as formulas (=, +, -, @, tab, CR).
 * Plain numbers are left alone so numeric columns stay numeric.
 */
export function sanitizeCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (PLAIN_NUMBER.test(s)) return s;
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export function toCsv(rows: unknown[][]): string {
  const esc = (v: unknown) => {
    const s = sanitizeCell(v);
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return "\uFEFF" + rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}
