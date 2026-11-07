import { describe, expect, it } from "vitest";
import { formatBusinessDate, formatMonth, SINHALA_MONTHS, SINHALA_TRADITIONAL_MONTHS } from "@/lib/dates/business";

describe("Sinhala month names", () => {
  it("has twelve of each, spelled as the shop owner wrote them", () => {
    expect(SINHALA_MONTHS).toHaveLength(12);
    expect(SINHALA_TRADITIONAL_MONTHS).toHaveLength(12);
    expect(SINHALA_MONTHS[0]).toBe("ජනවාරි");
    expect(SINHALA_MONTHS[9]).toBe("ඔක්තෝම්බර්");
    expect(SINHALA_TRADITIONAL_MONTHS[0]).toBe("දුරුතු");
    expect(SINHALA_TRADITIONAL_MONTHS[8]).toBe("බිනව");
  });

  it("writes every month of a date in Sinhala, whatever the device's own Sinhala data says", () => {
    for (let m = 1; m <= 12; m++) {
      const date = `2026-${String(m).padStart(2, "0")}-07`;
      const long = formatBusinessDate(date, "si");
      expect(long, date).toContain(SINHALA_MONTHS[m - 1]);
      expect(formatBusinessDate(date, "si", { day: "numeric", month: "short" }), date).toContain(SINHALA_MONTHS[m - 1]);
      expect(formatMonth(`2026-${String(m).padStart(2, "0")}`, "si"), date).toContain(SINHALA_MONTHS[m - 1]);
    }
  });

  it("keeps the day and year, and leaves English alone", () => {
    const text = formatBusinessDate("2026-11-07", "si");
    expect(text).toContain("2026");
    expect(text).toContain("7");
    expect(formatBusinessDate("2026-11-07", "en")).toBe("7 November 2026");
    expect(formatMonth("2026-06", "en")).toBe("June 2026");
  });

  it("leaves numeric months numeric", () => {
    expect(formatBusinessDate("2026-11-07", "si", { day: "2-digit", month: "2-digit", year: "numeric" })).not.toMatch(/[඀-෿]/);
  });
});
