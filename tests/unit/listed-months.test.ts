import { describe, expect, it } from "vitest";
import { listedMonths, type ReportIndexRow } from "@/features/reports/report";

const row = (month: string, over: Partial<ReportIndexRow> = {}): ReportIndexRow => ({
  month, estimatedSales: null, daysCalculated: 0, daysReview: 0, status: "pending", waitingFor: null, recalculated: false, lastExport: null, ...over,
});

describe("which months the report list shows", () => {
  it("always shows the current month, even before it has a figure", () => {
    expect(listedMonths([row("2026-11", { status: "in_progress" })]).map((r) => r.month)).toEqual(["2026-11"]);
  });

  it("hides earlier months that have no figures at all (they would be empty rows)", () => {
    const rows = [row("2026-11", { status: "in_progress" }), row("2026-10"), row("2026-09"), row("2026-08", { status: "complete" })];
    expect(listedMonths(rows).map((r) => r.month)).toEqual(["2026-11"]);
  });

  it("keeps earlier months that do have figures, complete or still waiting for their closing count", () => {
    const rows = [
      row("2026-11", { status: "in_progress", estimatedSales: "1200.00" }),
      row("2026-10", { status: "complete", estimatedSales: "30000.00" }),
      row("2026-09", { status: "pending", estimatedSales: "500.00", waitingFor: "2026-10-01" }),
      row("2026-08"),
    ];
    expect(listedMonths(rows).map((r) => r.month)).toEqual(["2026-11", "2026-10", "2026-09"]);
  });

  it("a real figure of zero is still a figure (not hidden)", () => {
    expect(listedMonths([row("2026-10", { status: "complete", estimatedSales: "0.00" })])).toHaveLength(1);
  });

  it("keeps the order and does not change the rows", () => {
    const rows = [row("2026-11", { status: "in_progress" }), row("2026-10", { estimatedSales: "5.00" })];
    expect(listedMonths(rows)).toEqual(rows);
  });
});
