import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ItemCard } from "@/components/stock/item-card";
import { evaluateItem, type EntryItem } from "@/features/inventory/count-entry";
import { normalizePackagingQuantity, resolveUnits, type PackUnit } from "@/lib/calculations/packaging";
import { I18nProvider } from "@/providers/i18n-provider";

/**
 * Choco: Box (1 box = 20 pieces) is sold only; Carton (1 carton = 10 boxes = 200 pieces) is counted.
 * A unit switched off for counting is hidden from the entry form but STAYS in the conversion chain (a carton is made of boxes).
 */
const BOX = "00000000-0000-4000-8000-0000000000b1";
const CARTON = "00000000-0000-4000-8000-0000000000b2";
const units: PackUnit[] = [
  { id: BOX, name: "Box", parentId: null, factor: "20", countable: false },
  { id: CARTON, name: "Carton", parentId: BOX, factor: "10", countable: true },
];
const item: EntryItem = {
  variantId: "00000000-0000-4000-8000-000000000001", productName: "Choco", productCode: "CHOCO", category: null, sizeLabel: "", sku: "CHOCO-1", baseUnit: "piece",
  units, previousBase: "400", sellingPrice: "30",
};

describe("units that are not used in stock counts", () => {
  it("the entry form offers the carton and the loose pieces, but not the box", () => {
    render(<I18nProvider locale="en"><ItemCard item={item} values={{}} state={evaluateItem(item, {})} disabled={false} onChange={vi.fn()} /></I18nProvider>);
    expect(screen.getByLabelText(/Carton/)).toBeInTheDocument();
    expect(screen.getAllByRole("textbox").length).toBe(2); // carton + loose pieces
    expect(screen.queryByLabelText(/^Box/)).not.toBeInTheDocument();
  });

  it("the conversion chain is intact: 2 cartons + 8 pieces = 408 (a carton is 10 boxes of 20 even though boxes are not counted)", () => {
    expect(resolveUnits(units, "piece")).toMatchObject({ ok: true });
    const r = normalizePackagingQuantity([{ unitId: CARTON, quantity: "2" }, { unitId: null, quantity: "8" }], units, "piece");
    expect(r).toMatchObject({ ok: true, counted: true, baseQuantity: "408" });
  });

  it("all units countable (the default, and every existing unit) shows every field, as before", () => {
    const all: EntryItem = { ...item, units: units.map((u) => ({ ...u, countable: undefined })) };
    render(<I18nProvider locale="en"><ItemCard item={all} values={{}} state={evaluateItem(all, {})} disabled={false} onChange={vi.fn()} /></I18nProvider>);
    expect(screen.getAllByRole("textbox").length).toBe(3);
  });
});
