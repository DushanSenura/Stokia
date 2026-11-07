import { describe, expect, it } from "vitest";
import { parseCsv, sanitizeCell, toCsv } from "@/lib/exports/csv";

describe("csv", () => {
  it("parses quotes, commas, escaped quotes, CRLF and BOM", () => {
    expect(parseCsv('\uFEFFa,b\r\n"x,1","say ""hi"""\r\n')).toEqual([["a", "b"], ["x,1", 'say "hi"']]);
  });
  it("handles embedded newlines in quoted cells and skips blank lines", () => {
    expect(parseCsv('a,b\n"l1\nl2",2\n\n')).toEqual([["a", "b"], ["l1\nl2", "2"]]);
  });
  it("neutralises formula injection but keeps plain numbers", () => {
    for (const bad of ["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\tx"]) expect(sanitizeCell(bad).startsWith("'")).toBe(true);
    expect(sanitizeCell("-5")).toBe("-5");
    expect(sanitizeCell("150.50")).toBe("150.50");
    expect(sanitizeCell("Rice")).toBe("Rice");
  });
  it("round-trips through toCsv/parseCsv", () => {
    const rows = [["name", "note"], ['A "x"', "a,b"]];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
  it("toCsv sanitises", () => expect(toCsv([["=HYPERLINK(1)"]])).toContain("'=HYPERLINK(1)"));
});
