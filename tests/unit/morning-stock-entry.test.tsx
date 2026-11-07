import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MorningStockEntry, type MorningStockProps } from "@/components/stock/morning-stock-entry";
import type { EntryItem } from "@/features/inventory/count-entry";
import { I18nProvider } from "@/providers/i18n-provider";

const save = vi.fn();
const confirm = vi.fn();
vi.mock("@/server/actions/inventory", () => ({
  saveDraftAction: (...a: unknown[]) => save(...a),
  confirmCountAction: (...a: unknown[]) => confirm(...a),
  discardDraftAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const chilli: EntryItem = {
  variantId: "00000000-0000-4000-8000-000000000001", productName: "Chilli Powder", productCode: "CHL", category: "Spices", sizeLabel: "250 g",
  sku: "CHL-250", baseUnit: "packet", units: [{ id: "00000000-0000-4000-8000-0000000000b1", name: "Bundle", parentId: null, factor: 12 }],
  previousBase: "120", sellingPrice: "150",
};
const oil: EntryItem = {
  variantId: "00000000-0000-4000-8000-000000000002", productName: "Coconut Oil", productCode: "OIL", category: "Oils", sizeLabel: "1 L",
  sku: "OIL-1L", baseUnit: "bottle", units: [], previousBase: "10", sellingPrice: "200",
};
const props = (over: Partial<MorningStockProps> = {}): MorningStockProps => ({
  shopName: "Perera Stores", businessDate: "2026-11-02", salesDate: "2026-11-01", items: [chilli, oil], initialValues: {},
  session: null, previousDate: "2026-11-01", gapDays: 1, readOnly: false, truncated: false, ...over,
});
const setup = (over?: Partial<MorningStockProps>) => render(<I18nProvider locale="en"><MorningStockEntry {...props(over)} /></I18nProvider>);

beforeEach(() => {
  save.mockReset().mockImplementation(async (p: { revision: number | null; items: unknown[] }) => ({ ok: true, sessionId: "s1", revision: (p.revision ?? 0) + 2, counted: p.items.length }));
  confirm.mockReset().mockResolvedValue({ ok: true, sessionId: "s1", revision: 9, counted: 1, confirmed: true });
  window.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

const loose = () => screen.getByLabelText(/Loose packet/);
const oilField = () => screen.getByLabelText(/Remaining now \(bottle\)/);

describe("Morning stock entry", () => {
  it("shows the count date AND the sales date it calculates (count date is never the sales date)", () => {
    setup();
    expect(screen.getByText("Morning count: 2 November 2026")).toBeInTheDocument();
    expect(screen.getByText("Calculates sales for: 1 November 2026")).toBeInTheDocument();
    expect(screen.getByText("Not started")).toBeInTheDocument();
  });

  it("blank = not counted (progress 0), not zero", () => {
    setup();
    expect(screen.getAllByText("0 of 2 counted").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/A blank is not zero/)).toHaveLength(2);
  });

  it("Test A in the UI: previous 10 bottles, now 4 -> change -6, sold 6, Rs. 1,200.00", async () => {
    setup();
    await userEvent.type(oilField(), "4");
    expect(screen.getByText("Total: 4 bottle")).toBeInTheDocument();
    expect(screen.getByText("-6")).toBeInTheDocument();
    expect(screen.getByText("Rs. 1,200.00")).toBeInTheDocument();
    expect(screen.getAllByText("1 of 2 counted").length).toBeGreaterThan(0);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
  });

  it("Test D in the UI: previous 120 packets (10 bundles); 7 bundles + 5 loose = 89, sold 31", async () => {
    setup();
    expect(screen.getByText("10 Bundle (120 packet)")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/^Bundle/), "7");
    await userEvent.type(loose(), "5");
    expect(screen.getByText("Total: 89 packet")).toBeInTheDocument();
    expect(screen.getByText("Rs. 4,650.00")).toBeInTheDocument(); // 31 x 150
  });

  it("typing 0 is a real count (everything sold)", async () => {
    setup();
    await userEvent.type(oilField(), "0");
    expect(screen.getByText("Total: 0 bottle")).toBeInTheDocument();
    expect(screen.getByText("Rs. 2,000.00")).toBeInTheDocument();
  });

  it("Test F: an unexpected increase needs review and shows no sales value", async () => {
    setup();
    await userEvent.type(oilField(), "25");
    expect(screen.getByText(/Needs review. No sales are estimated/)).toBeInTheDocument();
    expect(screen.queryByText(/Estimated Sales:/)).not.toBeInTheDocument();
    expect(screen.getByText("Needs review", { selector: "div,span" })).toBeInTheDocument(); // status badge
  });

  it("bundles accept whole numbers only; loose accepts up to 3 decimals", async () => {
    setup();
    await userEvent.type(screen.getByLabelText(/^Bundle/), "2.5");
    expect(screen.getByLabelText(/^Bundle/)).toHaveValue("25"); // '.' rejected while typing
    await userEvent.type(loose(), "1.2345");
    expect(loose()).toHaveValue("1.234");
    await userEvent.type(oilField(), "abc");
    expect(oilField()).toHaveValue("");
  });

  it("Enter jumps to the next field (keyboard entry)", async () => {
    setup();
    await userEvent.type(screen.getByLabelText(/^Bundle/), "3{Enter}");
    expect(loose()).toHaveFocus();
    await userEvent.type(loose(), "1{Enter}");
    expect(oilField()).toHaveFocus();
  });

  it("filters by search and by 'Not counted'", async () => {
    setup();
    await userEvent.type(screen.getByLabelText("Search products"), "oil");
    expect(screen.queryByText("Chilli Powder")).not.toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Search products"));
    await userEvent.type(oilField(), "4");
    await userEvent.click(screen.getByRole("button", { name: "Not counted" }));
    expect(screen.queryByText("Coconut Oil")).not.toBeInTheDocument();
    expect(screen.getByText("Chilli Powder")).toBeInTheDocument();
  });

  it("autosaves a draft shortly after typing, sending only filled rows", async () => {
    setup();
    await userEvent.type(oilField(), "4");
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(save.mock.calls[0][0]).toEqual({ businessDate: "2026-11-02", revision: null, items: [{ variantId: oil.variantId, entries: [{ unitId: null, quantity: "4" }] }] });
    await waitFor(() => expect(screen.getByText("Draft saved")).toBeInTheDocument());
  });

  it("does not save anything when nothing has been entered", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(save).not.toHaveBeenCalled();
  });

  it("shows a conflict banner when another device changed the count", async () => {
    save.mockResolvedValue({ ok: false, error: "ms.conflict", conflict: true });
    setup();
    await userEvent.type(oilField(), "4");
    await waitFor(() => expect(screen.getByText(/changed somewhere else/)).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByRole("button", { name: "Review and confirm" })).toBeDisabled();
  });

  it("restores a resumed draft", () => {
    setup({ session: { id: "s1", revision: 4 }, initialValues: { [oil.variantId]: { __base: "4" } } });
    expect(oilField()).toHaveValue("4");
    expect(screen.getByText("Draft")).toBeInTheDocument();
  });

  it("first count: explains opening stock and claims no sales", () => {
    setup({ previousDate: null, items: [{ ...chilli, previousBase: null }, { ...oil, previousBase: null }] });
    expect(screen.getByText(/first count. It sets your opening stock/)).toBeInTheDocument();
  });

  it("warns when days were skipped since the last confirmed count", () => {
    setup({ previousDate: "2026-10-30", gapDays: 3 });
    expect(screen.getByText(/last confirmed count was on 30 October 2026 \(3 days ago\)/)).toBeInTheDocument();
  });

  it("viewers cannot edit", () => {
    setup({ readOnly: true });
    expect(oilField()).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Review and confirm" })).not.toBeInTheDocument();
  });

  describe("review and confirm", () => {
    it("requires acknowledging uncounted products, then confirms and shows success", async () => {
      setup();
      await userEvent.type(oilField(), "4");
      await userEvent.click(screen.getByRole("button", { name: "Review and confirm" }));

      expect(await screen.findByText("Review your count")).toBeInTheDocument();
      const confirmBtn = screen.getByRole("button", { name: "Confirm count" });
      expect(confirmBtn).toBeDisabled(); // Chilli Powder not counted
      await userEvent.click(screen.getByRole("checkbox"));
      expect(confirmBtn).toBeEnabled();

      await userEvent.click(confirmBtn);
      expect(await screen.findByText("Stock saved.")).toBeInTheDocument();
      expect(confirm).toHaveBeenCalledTimes(1);
      const [payload, ack] = confirm.mock.calls[0];
      expect(ack).toBe(true);
      expect(payload.items).toEqual([{ variantId: oil.variantId, entries: [{ unitId: null, quantity: "4" }] }]);
      expect(screen.getByText(/Count for 2 November 2026 is confirmed/)).toBeInTheDocument();
    });

    it("a complete count needs no acknowledgement", async () => {
      setup();
      await userEvent.type(oilField(), "4");
      await userEvent.type(loose(), "100");
      await userEvent.click(screen.getByRole("button", { name: "Review and confirm" }));
      await screen.findByText("Review your count");
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Confirm count" })).toBeEnabled();
    });

    it("lists products that need review before confirming", async () => {
      setup();
      await userEvent.type(oilField(), "25");
      await userEvent.click(screen.getByRole("button", { name: "Review and confirm" }));
      const alert = (await screen.findAllByRole("alert")).find((a) => /Needs review/.test(a.textContent ?? ""))!;
      expect(within(alert).getByText(/Coconut Oil/)).toBeInTheDocument();
    });

    it("shows the server's error and stays on the review screen when confirm fails", async () => {
      confirm.mockResolvedValue({ ok: false, error: "ms.err.COUNT_OUT_OF_ORDER" });
      setup();
      await userEvent.type(oilField(), "4");
      await userEvent.click(screen.getByRole("button", { name: "Review and confirm" }));
      await userEvent.click(await screen.findByRole("checkbox"));
      await userEvent.click(screen.getByRole("button", { name: "Confirm count" }));
      expect(await screen.findByText(/Counts must be entered in order/)).toBeInTheDocument();
      expect(screen.queryByText("Stock saved.")).not.toBeInTheDocument();
    });

    it("success shows the sales the database calculated, with review/pending counts", async () => {
      confirm.mockResolvedValue({ ok: true, sessionId: "s1", revision: 9, counted: 2, confirmed: true,
        sales: { date: "2026-11-01", calculated: 5, needsReview: 1, pending: 2, estimatedTotal: "4200.00", unitsByBaseUnit: { packet: "28" } } });
      setup();
      await userEvent.type(oilField(), "4");
      await userEvent.type(loose(), "100");
      await userEvent.click(screen.getByRole("button", { name: "Review and confirm" }));
      await userEvent.click(await screen.findByRole("button", { name: "Confirm count" }));
      expect(await screen.findByText("Stock saved.")).toBeInTheDocument();
      expect(screen.getByText("Yesterday's sales are ready.")).toBeInTheDocument();
      expect(screen.getByText("Rs. 4,200.00")).toBeInTheDocument();
      expect(screen.getByText("28 packet")).toBeInTheDocument();
      expect(screen.getByText("1 products need review.")).toBeInTheDocument();
      expect(screen.getByText(/not confirmed cash received/)).toBeInTheDocument();
    });

    it("when a morning was skipped, success says the in-between days stay pending (no sales claimed)", async () => {
      confirm.mockResolvedValue({ ok: true, sessionId: "s1", revision: 9, counted: 1, confirmed: true,
        sales: { date: "2026-11-01", calculated: 0, needsReview: 0, pending: 2, estimatedTotal: "0.00", unitsByBaseUnit: {} } });
      setup({ previousDate: "2026-10-30", gapDays: 3 });
      await userEvent.type(oilField(), "4");
      await userEvent.type(loose(), "100");
      await userEvent.click(screen.getByRole("button", { name: "Review and confirm" }));
      await userEvent.click(await screen.findByRole("button", { name: "Confirm count" }));
      expect(await screen.findByText(/A morning count was skipped/)).toBeInTheDocument();
      expect(screen.queryByText("Yesterday's sales are ready.")).not.toBeInTheDocument();
    });

    it("first-count success does not claim any sales", async () => {
      setup({ previousDate: null, items: [{ ...oil, previousBase: null }] });
      await userEvent.type(oilField(), "40");
      await userEvent.click(screen.getByRole("button", { name: "Review and confirm" }));
      await userEvent.click(await screen.findByRole("button", { name: "Confirm count" }));
      expect(await screen.findByText(/Opening stock is set/)).toBeInTheDocument();
      expect(screen.queryByText(/Preliminary estimate/)).not.toBeInTheDocument();
    });
  });
});
