import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MovementForm } from "@/components/movements/movement-forms";
import { SalesTable } from "@/components/stock/sales-table";
import { createTranslator } from "@/i18n";
import { I18nProvider } from "@/providers/i18n-provider";
import type { SalesRow } from "@/server/repositories/inventory";

const record = vi.fn();
vi.mock("@/server/actions/movements", () => ({
  recordMovementAction: (...a: unknown[]) => record(...a),
  recordRepackingAction: vi.fn(),
  reverseMovementAction: vi.fn(),
}));

const hit = { id: "00000000-0000-4000-8000-000000000001", label: "Chilli Powder 250 g", sku: "CHL-250", baseUnit: "packet", units: [{ id: "00000000-0000-4000-8000-0000000000b1", name: "Bundle", multiplier: "12" }] };

beforeEach(() => {
  record.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ hits: [hit] }) })));
});

const setup = () => render(<I18nProvider locale="en"><MovementForm defaultLocal="2026-11-06T09:00" /></I18nProvider>);
const keyOf = (fd: FormData) => String(fd.get("key"));

async function pickProduct() {
  await userEvent.type(screen.getByLabelText("Product"), "chilli");
  await userEvent.click(await screen.findByRole("button", { name: /Chilli Powder 250 g/ }, { timeout: 2000 }));
}

describe("MovementForm", () => {
  it("picks a product via type-ahead, offers its packaging units, and submits the chosen unit and quantity", async () => {
    record.mockResolvedValue({ success: "mv.recorded" });
    setup();
    await pickProduct();
    expect(screen.getByRole("option", { name: /Bundle \(× 12\)/ })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Unit"), "Bundle (× 12)");
    await userEvent.type(screen.getByLabelText("Quantity"), "2");
    await userEvent.type(screen.getByLabelText("Reason"), "Delivery");
    await userEvent.click(screen.getByRole("button", { name: "Save movement" }));

    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    const fd = record.mock.calls[0][1] as FormData;
    expect(Object.fromEntries([...fd.entries()].filter(([k]) => k !== "key"))).toMatchObject({
      variant_id: hit.id, type: "stock_received", quantity: "2", unit_id: hit.units[0].id, when: "now", reason: "Delivery",
    });
    expect(await screen.findByText(/Movement saved/)).toBeInTheDocument();
  });

  it("keeps the SAME idempotency key when a save fails, so a retry can never record it twice", async () => {
    record.mockResolvedValueOnce({ error: "auth.error.generic" }).mockResolvedValueOnce({ error: "auth.error.generic" });
    setup();
    await pickProduct();
    await userEvent.type(screen.getByLabelText("Quantity"), "5");
    await userEvent.type(screen.getByLabelText("Reason"), "Delivery");
    await userEvent.click(screen.getByRole("button", { name: "Save movement" }));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "Save movement" }));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(2));
    expect(keyOf(record.mock.calls[1][1])).toBe(keyOf(record.mock.calls[0][1]));
  });

  it("uses a NEW key for the next movement after a successful save", async () => {
    record.mockResolvedValue({ success: "mv.recorded" });
    setup();
    await pickProduct();
    await userEvent.type(screen.getByLabelText("Quantity"), "5");
    await userEvent.type(screen.getByLabelText("Reason"), "A");
    await userEvent.click(screen.getByRole("button", { name: "Save movement" }));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    await screen.findByText(/Movement saved/);
    await userEvent.type(screen.getByLabelText("Quantity"), "6");
    await userEvent.type(screen.getByLabelText("Reason"), "B");
    await userEvent.click(screen.getByRole("button", { name: "Save movement" }));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(2));
    expect(keyOf(record.mock.calls[1][1])).not.toBe(keyOf(record.mock.calls[0][1]));
  });

  it("shows direction choices only for manual adjustments, and explains the timing choice", async () => {
    setup();
    expect(screen.queryByText("Direction")).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("What happened?"), "manual_adjustment");
    expect(screen.getByText("Direction")).toBeInTheDocument();
    expect(screen.getByText(/Before this morning's count/)).toBeInTheDocument();
    expect(screen.getByText(/The time decides which day's sales this affects/)).toBeInTheDocument();
  });

  it("shows server field errors next to the field", async () => {
    record.mockResolvedValue({ fieldErrors: { quantity: "mv.err.quantity" } });
    setup();
    await pickProduct();
    await userEvent.type(screen.getByLabelText("Quantity"), "0");
    await userEvent.click(screen.getByRole("button", { name: "Save movement" }));
    expect(await screen.findByText("Enter a quantity above zero.")).toBeInTheDocument();
  });
});

describe("SalesTable", () => {
  const t = createTranslator("en");
  const row = (over: Partial<SalesRow>): SalesRow => ({
    variant_id: "v", sales_date: "2026-11-01", inferred_base_units_sold: "28.000", estimated_sales_amount: "4200.00", price_reference: "150.00",
    calculation_status: "calculated", calculation_revision: 1, pending_reason: null,
    breakdown: { opening: 100, closing: 72, received: 0, returns: 0, damaged: 0, other_out: 0, adjustments: 0 },
    product_variants: { sku: "CHL-250", size_value: "250", size_unit: "g", base_inventory_unit: "packet", products: { name: "Chilli Powder" } }, ...over,
  });
  const show = (rows: SalesRow[]) => render(<SalesTable rows={rows} t={t} />);

  it("explains a calculated row with every number that went into it", () => {
    show([row({})]);
    expect(screen.getByText("28 packet")).toBeInTheDocument();
    expect(screen.getByText("Rs. 4,200.00")).toBeInTheDocument();
    expect(screen.getByText("Calculated")).toBeInTheDocument();
  });
  it("needs review: no units, no money, and a plain-language reason", () => {
    show([row({ calculation_status: "needs_review", inferred_base_units_sold: null, estimated_sales_amount: null, pending_reason: "stock_increase_unexplained", breakdown: { opening: 50, closing: 80, received: 0, returns: 0, damaged: 0, other_out: 0, adjustments: 0 } })]);
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(screen.getByText(/no delivery, return or adjustment explains it/)).toBeInTheDocument();
    expect(screen.queryByText(/Rs\./)).not.toBeInTheDocument();
  });
  it("pending shows dashes and the reason, never zero", () => {
    show([row({ calculation_status: "pending", inferred_base_units_sold: null, estimated_sales_amount: null, breakdown: null, pending_reason: "awaiting_next_count" })]);
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText(/Waiting for the next morning's count/)).toBeInTheDocument();
    expect(screen.queryByText("0 packet")).not.toBeInTheDocument();
  });
  it("shows the revision once a day has been recalculated; labels a missing price", () => {
    show([row({ calculation_status: "recalculated", calculation_revision: 3, estimated_sales_amount: null })]);
    expect(screen.getByText("Recalculated")).toBeInTheDocument();
    expect(screen.getByText("Revision 3")).toBeInTheDocument();
    expect(screen.getByText("No selling price")).toBeInTheDocument();
  });
  it("empty state", () => {
    show([]);
    expect(screen.getByText(/No sales results yet/)).toBeInTheDocument();
  });
});
