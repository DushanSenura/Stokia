import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MorningStockEntry } from "@/components/stock/morning-stock-entry";
import type { EntryItem } from "@/features/inventory/count-entry";
import { buildPayloadItems, summarize } from "@/features/inventory/count-entry";
import { I18nProvider } from "@/providers/i18n-provider";

vi.mock("@/server/actions/inventory", () => ({ saveDraftAction: vi.fn().mockResolvedValue({ ok: true, sessionId: "s", revision: 2, counted: 1 }), confirmCountAction: vi.fn(), discardDraftAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const N = 3000;
const items: EntryItem[] = Array.from({ length: N }, (_, i) => ({
  variantId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, productName: `Product ${i}`, productCode: `P${i}`, category: `Cat ${i % 40}`, sizeLabel: "1 kg",
  sku: `SKU-${i}`, baseUnit: "packet", units: [{ id: `00000000-0000-4000-8000-b${String(i).padStart(11, "0")}`, name: "Bundle", parentId: null, factor: 12 }],
  previousBase: "100", sellingPrice: "150",
}));

describe("large catalog in the browser", () => {
  it("shows only a window of rows, not 3,000 cards", () => {
    render(<I18nProvider locale="en"><MorningStockEntry shopName="Big Mart" businessDate="2026-11-02" salesDate="2026-11-01" items={items} initialValues={{}} session={null} previousDate="2026-11-01" gapDays={1} readOnly={false} truncated={false} /></I18nProvider>);
    expect(screen.getAllByLabelText(/Loose packet/)).toHaveLength(40);
    expect(screen.getAllByText("0 of 3000 counted").length).toBeGreaterThan(0);
  });

  it("typing stays responsive with 3,000 products", async () => {
    render(<I18nProvider locale="en"><MorningStockEntry shopName="Big Mart" businessDate="2026-11-02" salesDate="2026-11-01" items={items} initialValues={{}} session={null} previousDate="2026-11-01" gapDays={1} readOnly={false} truncated={false} /></I18nProvider>);
    const field = screen.getAllByLabelText(/Loose packet/)[0];
    const t0 = performance.now();
    await userEvent.type(field, "12345");
    const perKey = (performance.now() - t0) / 5;
    console.log(`[perf] morning stock keystroke with ${N} items: ${Math.round(perKey)} ms`);
    expect(perKey).toBeLessThan(400);
    expect(screen.getAllByText("1 of 3000 counted").length).toBeGreaterThan(0);
  });

  it("whole-catalog calculations are fast and linear", () => {
    const values: Record<string, Record<string, string>> = {};
    for (const it of items) values[it.variantId] = { __base: "90" };
    const t0 = performance.now();
    const s = summarize(items, values);
    const payload = buildPayloadItems(items, values);
    const ms = performance.now() - t0;
    console.log(`[perf] summarize + build payload for ${N} items: ${Math.round(ms)} ms`);
    expect(s.counted).toBe(N);
    expect(payload).toHaveLength(N);
    expect(ms).toBeLessThan(1500);
  });
});
