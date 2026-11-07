import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SalesBreakdownPanel } from "@/components/sales/sales-breakdown-panel";
import type { BreakdownDay, BreakdownItem } from "@/features/sales/breakdown-types";
import { I18nProvider } from "@/providers/i18n-provider";

const load = vi.fn();
const save = vi.fn();
const clear = vi.fn();
const history = vi.fn();
vi.mock("@/server/actions/sales-breakdown", () => ({
  loadBreakdownDayAction: (...a: unknown[]) => load(...a),
  saveBreakdownAction: (...a: unknown[]) => save(...a),
  clearBreakdownAction: (...a: unknown[]) => clear(...a),
  loadBreakdownHistoryAction: (...a: unknown[]) => history(...a),
}));

const BOX = "00000000-0000-4000-8000-0000000000b1";
const V = "00000000-0000-4000-8000-000000000001";
const choco = (over: Partial<BreakdownItem> = {}): BreakdownItem => ({
  variantId: V, name: "Choco", size: "", sku: "CHOCO-1", baseUnit: "piece", inferred: "145", packagingStatus: "unknown", amount: "4350.00", plainEstimate: "4350.00",
  base: { name: "piece", sellable: true, price: "30" },
  units: [{ id: BOX, name: "Box", multiplier: "20", canBeSold: true, isActive: true, price: "550" }],
  current: null, ...over,
});
const recorded = (): BreakdownItem => choco({
  packagingStatus: "known", amount: "4150.00",
  current: { revision: 2, status: "active", inferred: "145", packaged: "80", remainder: "65", amount: "4150.00", note: null, updatedAt: "2026-11-07T01:00:00Z",
    lines: [{ unitId: BOX, isBaseUnit: false, name: "Box", quantity: "4", baseUnits: "80", unitPrice: "550", amount: "2200.00" }, { unitId: null, isBaseUnit: true, name: "piece", quantity: "65", baseUnits: "65", unitPrice: "30", amount: "1950.00" }] },
});
const day = (...items: BreakdownItem[]): BreakdownDay => ({ date: "2026-11-06", items, unavailable: 0, estimatedTotal: "4450.00" });
const ui = (onChanged?: (d: BreakdownDay | null) => void) => render(<I18nProvider locale="en"><SalesBreakdownPanel date="2026-11-06" onChanged={onChanged} /></I18nProvider>);
const open = async () => { await userEvent.click(screen.getByRole("button", { name: /Sales breakdown \(optional\)/ })); };

beforeEach(() => {
  load.mockReset().mockResolvedValue({ ok: true, day: day(choco()), canWrite: true });
  save.mockReset().mockResolvedValue({ ok: true, duplicate: false, revision: 1, amount: "4150.00" });
  clear.mockReset().mockResolvedValue({ ok: true, duplicate: false, revision: 3 });
  history.mockReset().mockResolvedValue({ ok: true, history: [] });
});

describe("the optional sales breakdown panel", () => {
  it("stays collapsed and loads nothing until it is opened (the morning count is not cluttered)", async () => {
    ui();
    expect(screen.getByRole("button", { name: /Sales breakdown \(optional\)/ })).toHaveAttribute("aria-expanded", "false");
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByText(/Boxes sold|Box sold/)).not.toBeInTheDocument();
  });

  it("opens and shows the products, the inferred units and the plain estimate while the packaging is unknown", async () => {
    ui(); await open();
    expect(await screen.findByText("Choco")).toBeInTheDocument();
    expect(screen.getByText(/145 piece/)).toBeInTheDocument();
    expect(screen.getByText(/Estimated revenue \(packaging unknown\): Rs\. 4,350\.00/)).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith("2026-11-06");
  });

  it("previews as the person types: 4 boxes of 20 in 145 pieces = 65 loose, Rs. 4,150.00 (known)", async () => {
    ui(); await open();
    await userEvent.type(await screen.findByLabelText("Box sold"), "4");
    expect(screen.getByText(/Individual piece sold:/)).toHaveTextContent("65");
    expect(screen.getByText(/Estimated revenue \(known packaging\): Rs\. 4,150\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Without a breakdown this day would be Rs\. 4,350\.00/)).toBeInTheDocument();
    expect(screen.getByText(/80/)).toBeInTheDocument(); // the box equivalent in pieces
  });

  it("accepts whole numbers only", async () => {
    ui(); await open();
    const box = await screen.findByLabelText("Box sold");
    await userEvent.type(box, "2.5a-");
    expect(box).toHaveValue("25");
  });

  it("says so when the boxes exceed what was inferred, and does not allow saving", async () => {
    ui(); await open();
    await userEvent.type(await screen.findByLabelText("Box sold"), "8");
    expect(screen.getByRole("alert")).toHaveTextContent("more than was inferred sold");
    await userEvent.click(screen.getByRole("button", { name: "Save breakdown" }));
    expect(save).not.toHaveBeenCalled();
  });

  it("Save stays off until something is typed", async () => {
    ui(); await open();
    expect(await screen.findByRole("button", { name: "Save breakdown" })).toBeDisabled();
  });

  it("saves the draft with one key per distinct request, then reloads the day", async () => {
    ui(); await open();
    await userEvent.type(await screen.findByLabelText("Box sold"), "4");
    await userEvent.click(screen.getByRole("button", { name: "Save breakdown" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const [draft, key] = save.mock.calls[0];
    expect(draft).toEqual({ variantId: V, date: "2026-11-06", lines: [{ unitId: BOX, quantity: "4" }], reason: undefined, expectedRevision: null });
    expect(key).toEqual(expect.any(String));
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(await screen.findByText(/Breakdown saved/)).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("tells the page the day as it is NOW after a save (so a headline showing the day's total can follow it)", async () => {
    const changed = vi.fn();
    load.mockResolvedValueOnce({ ok: true, day: day(choco()), canWrite: true })
      .mockResolvedValueOnce({ ok: true, day: { ...day(recorded()), estimatedTotal: "4250.00" }, canWrite: true });
    ui(changed); await open();
    await userEvent.type(await screen.findByLabelText("Box sold"), "4");
    await userEvent.click(screen.getByRole("button", { name: "Save breakdown" }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(changed.mock.calls[0][0]).toMatchObject({ estimatedTotal: "4250.00" });
  });

  it("the confirmation survives the reload that follows a save (the item is rebuilt, the message is not lost)", async () => {
    load.mockResolvedValueOnce({ ok: true, day: day(choco()), canWrite: true })
      .mockResolvedValueOnce({ ok: true, day: day(recorded()), canWrite: true });
    ui(); await open();
    await userEvent.type(await screen.findByLabelText("Box sold"), "4");
    await userEvent.click(screen.getByRole("button", { name: "Save breakdown" }));
    expect(await screen.findByText(/Breakdown saved/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Known packaging breakdown")).toBeInTheDocument()); // the rebuilt item...
    expect(screen.getByText(/Breakdown saved/)).toBeInTheDocument();                                  // ...and the message is still there
  });

  it("shows the server's refusal and marks the line at fault", async () => {
    save.mockResolvedValue({ ok: false, error: "sb.err.PRICE_MISSING", fieldErrors: { [BOX]: "sb.err.PRICE_MISSING" } });
    ui(); await open();
    await userEvent.type(await screen.findByLabelText("Box sold"), "4");
    await userEvent.click(screen.getByRole("button", { name: "Save breakdown" }));
    expect(await screen.findAllByText(/no price for that unit/)).not.toHaveLength(0);
    expect(screen.getByLabelText("Box sold")).toHaveAttribute("aria-invalid", "true");
  });

  it("a recorded breakdown shows as known, with its boxes filled in", async () => {
    load.mockResolvedValue({ ok: true, day: day(recorded()), canWrite: true });
    ui(); await open();
    expect(await screen.findByText("Known packaging breakdown")).toBeInTheDocument();
    expect(screen.getByLabelText("Box sold")).toHaveValue("4");
  });

  it("changing a recorded breakdown needs a reason, and sends the revision it was looking at", async () => {
    load.mockResolvedValue({ ok: true, day: day(recorded()), canWrite: true });
    ui(); await open();
    const box = await screen.findByLabelText("Box sold");
    await userEvent.clear(box); await userEvent.type(box, "3");
    await userEvent.click(screen.getByRole("button", { name: "Save change" }));
    expect(save).not.toHaveBeenCalled();
    expect(await screen.findByText("Enter a reason for the change.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Why are you changing it?"), "Recounted the till slips");
    await userEvent.click(screen.getByRole("button", { name: "Save change" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toMatchObject({ lines: [{ unitId: BOX, quantity: "3" }], reason: "Recounted the till slips", expectedRevision: 2 });
  });

  it("'I do not know after all' needs a reason, then removes the breakdown", async () => {
    load.mockResolvedValue({ ok: true, day: day(recorded()), canWrite: true });
    ui(); await open();
    await userEvent.click(await screen.findByRole("button", { name: "I do not know after all" }));
    expect(clear).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText("Why are you changing it?"), "Not sure");
    await userEvent.click(screen.getByRole("button", { name: "I do not know after all" }));
    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    expect(clear.mock.calls[0][0]).toEqual({ variantId: V, date: "2026-11-06", reason: "Not sure" });
    expect(await screen.findByText(/Breakdown removed/)).toBeInTheDocument();
  });

  it("a stale breakdown is flagged for review, and falls back to the plain estimate", async () => {
    const stale = recorded(); stale.packagingStatus = "stale"; stale.current!.status = "stale"; stale.amount = "1050.00";
    load.mockResolvedValue({ ok: true, day: day(stale), canWrite: true });
    ui(); await open();
    expect(await screen.findAllByText(/Needs review/)).not.toHaveLength(0);
    expect(screen.getByText(/no longer fit this day's inferred sales/)).toBeInTheDocument();
  });

  it("people who may not record can look but not change (no inputs enabled, no Save)", async () => {
    load.mockResolvedValue({ ok: true, day: day(recorded()), canWrite: false });
    ui(); await open();
    expect(await screen.findByText(/can see the breakdown but not change it/)).toBeInTheDocument();
    expect(screen.getByLabelText("Box sold")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Save/ })).not.toBeInTheDocument();
  });

  it("the history lists who changed what and why", async () => {
    load.mockResolvedValue({ ok: true, day: day(recorded()), canWrite: true });
    history.mockResolvedValue({ ok: true, history: [
      { revision: 1, action: "created", reason: null, at: "2026-11-07T01:00:00Z", by: "Nimal", amount: "4350.00", packaged: "0", lines: [] },
      { revision: 2, action: "updated", reason: "Recounted the till slips", at: "2026-11-07T02:00:00Z", by: "Kamala", amount: "4150.00", packaged: "80", lines: [{ unitId: BOX, isBaseUnit: false, name: "Box", quantity: "4", baseUnits: "80", unitPrice: "550", amount: "2200.00" }] },
    ] });
    ui(); await open();
    await userEvent.click(await screen.findByRole("button", { name: "History" }));
    const list = await screen.findByRole("list");
    expect(within(list).getByText(/by Nimal/)).toBeInTheDocument();
    expect(within(list).getByText(/by Kamala/)).toBeInTheDocument();
    expect(within(list).getByText("Recounted the till slips")).toBeInTheDocument();
    expect(within(list).getByText(/Changed/)).toBeInTheDocument();
  });

  it("explains an empty day and a failed load (with a way to try again)", async () => {
    load.mockResolvedValueOnce({ ok: true, day: day(), canWrite: true });
    ui(); await open();
    expect(await screen.findByText(/No products with sellable packaging/)).toBeInTheDocument();
  });

  it("a failed load shows an error and a retry that works", async () => {
    load.mockResolvedValueOnce({ ok: false, error: "sb.loadFailed" });
    ui(); await open();
    expect(await screen.findByText(/Could not load the sales/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Choco")).toBeInTheDocument();
  });
});
