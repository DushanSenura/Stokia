import "fake-indexeddb/auto";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MorningStockEntry, type MorningStockProps } from "@/components/stock/morning-stock-entry";
import { ToastProvider } from "@/components/ui/toast";
import type { EntryItem } from "@/features/inventory/count-entry";
import { clearAllLocalDrafts, loadLocalDraft } from "@/lib/offline/draft-store";
import { clearAllQueued, enqueueCount, listQueued, syncQueue } from "@/lib/offline/sync-queue";
import { I18nProvider } from "@/providers/i18n-provider";
import { SyncProvider } from "@/providers/sync-provider";

const save = vi.fn();
const confirm = vi.fn();
vi.mock("@/server/actions/inventory", () => ({
  saveDraftAction: (...a: unknown[]) => save(...a),
  confirmCountAction: (...a: unknown[]) => confirm(...a),
  discardDraftAction: vi.fn(),
  variantLabelsAction: vi.fn().mockResolvedValue({}),
}));
const router = { refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const oil: EntryItem = {
  variantId: "00000000-0000-4000-8000-000000000002", productName: "Coconut Oil", productCode: "OIL", category: "Oils", sizeLabel: "1 L",
  sku: "OIL-1L", baseUnit: "bottle", units: [], previousBase: "10", sellingPrice: "200",
};
const SCOPE = "shop1:user1";
const DATE = "2026-11-02";
const props = (over: Partial<MorningStockProps> = {}): MorningStockProps => ({
  shopName: "Perera Stores", businessDate: DATE, salesDate: "2026-11-01", items: [oil], initialValues: {},
  session: null, previousDate: "2026-11-01", gapDays: 1, readOnly: false, truncated: false, draftScope: SCOPE, ...over,
});
const setup = (over?: Partial<MorningStockProps>, withSync = true) => {
  const form = <MorningStockEntry {...props(over)} />;
  return render(<I18nProvider locale="en"><ToastProvider>{withSync ? <SyncProvider scope={SCOPE}>{form}</SyncProvider> : form}</ToastProvider></I18nProvider>);
};
const setOnline = (value: boolean) => Object.defineProperty(window.navigator, "onLine", { value, configurable: true });

/** Count 4 bottles, go to the review screen and press Confirm. */
async function confirmCount() {
  await userEvent.type(screen.getByLabelText(/Remaining now \(bottle\)/), "4");
  await userEvent.click(screen.getByRole("button", { name: "Review and confirm" }));
  await userEvent.click(await screen.findByRole("button", { name: "Confirm count" }));
}

beforeEach(async () => {
  save.mockReset().mockImplementation(async (p: { revision: number | null; items: unknown[] }) => ({ ok: true, sessionId: "s1", revision: (p.revision ?? 0) + 2, counted: p.items.length }));
  confirm.mockReset().mockResolvedValue({ ok: true, sessionId: "s1", revision: 9, counted: 1, confirmed: true });
  router.refresh.mockReset();
  window.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  setOnline(true);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await clearAllQueued();
  await clearAllLocalDrafts();
});
afterEach(() => vi.restoreAllMocks());

describe("confirming a count with a connection", () => {
  it("is unchanged: the server confirms, nothing is queued", async () => {
    setup();
    await confirmCount();
    expect(await screen.findByText("Stock saved.")).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][2]).toMatch(/^[0-9a-f-]{8,}$/); // an idempotency key travels with every confirmation
    expect(await listQueued(SCOPE)).toEqual([]);
  });
});

describe("confirming offline", () => {
  it("keeps the count on this device, says it is NOT confirmed, and never calls the server", async () => {
    setup();
    await userEvent.type(screen.getByLabelText(/Remaining now \(bottle\)/), "4");
    setOnline(false);
    await userEvent.click(screen.getByRole("button", { name: "Review and confirm" }));
    await userEvent.click(await screen.findByRole("button", { name: "Confirm count" }));

    expect(await screen.findByRole("heading", { name: "Saved on this device" })).toBeInTheDocument();
    expect(screen.getByText(/It is NOT confirmed yet/)).toBeInTheDocument();
    expect(screen.queryByText("Stock saved.")).not.toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();

    const [queued] = await listQueued(SCOPE);
    expect(queued).toMatchObject({
      businessDate: DATE, state: "pending", attempts: 0, ack: false,
      payload: { businessDate: DATE, revision: null }, // no server draft was ever acknowledged
      labels: { [oil.variantId]: { name: "Coconut Oil 1 L", unit: "bottle" } },
      yours: { [oil.variantId]: "4" },
    });
    expect(queued.key.length).toBeGreaterThanOrEqual(8);
    expect(await loadLocalDraft(SCOPE, DATE)).toBeNull(); // the queue now owns the numbers
  });

  it("a request that gets no answer is queued under the SAME key it was sent with, so a count the server did apply is never applied twice", async () => {
    confirm.mockRejectedValue(new TypeError("Failed to fetch"));
    setup();
    await confirmCount();
    expect(await screen.findByRole("heading", { name: "Saved on this device" })).toBeInTheDocument();
    const sentKey = confirm.mock.calls[0][2];
    const [queued] = await listQueued(SCOPE);
    expect(queued.key).toBe(sentKey);
  });

  it("refuses to replace a count that may already have reached the server, and tells the person where to look", async () => {
    await enqueueCount({
      scope: SCOPE, businessDate: DATE, ack: true, key: "key-earlier-aaaaaaa", labels: {}, yours: {},
      payload: { businessDate: DATE, revision: null, items: [] },
    });
    await syncQueue(SCOPE, async () => { throw new Error("no answer"); }); // marks it as attempted
    setOnline(false);
    setup();
    await confirmCount();
    expect(await screen.findByText(/already waiting to be sent/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Saved on this device" })).not.toBeInTheDocument();
    expect((await listQueued(SCOPE))[0].key).toBe("key-earlier-aaaaaaa");
  });

  it("without a place to keep it, says so instead of pretending the count was saved", async () => {
    setOnline(false);
    setup({ draftScope: undefined }, false);
    await confirmCount();
    expect(await screen.findByText(/could not be saved on the device/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Saved on this device" })).not.toBeInTheDocument();
  });
});

describe("starting offline (the draft cannot be saved to the server)", () => {
  const field = () => screen.getByLabelText(/Remaining now \(bottle\)/);

  it("still reaches the review and confirm screens, without calling the server, and queues the count", async () => {
    setOnline(false);
    setup();
    await userEvent.type(field(), "4");
    await userEvent.click(screen.getByRole("button", { name: "Review and confirm" }));
    await userEvent.click(await screen.findByRole("button", { name: "Confirm count" }));
    expect(await screen.findByRole("heading", { name: "Saved on this device" })).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    const [queued] = await listQueued(SCOPE);
    expect(queued.payload.revision).toBeNull(); // the server never acknowledged a draft, so the base revision is still "none"
  });

  it("a save that gets no answer does not block the review either", async () => {
    save.mockRejectedValue(new TypeError("Failed to fetch"));
    setup();
    await userEvent.type(field(), "4");
    await userEvent.click(screen.getByRole("button", { name: "Review and confirm" }));
    expect(await screen.findByText("Review your count")).toBeInTheDocument();
  });

  it("but a refusal from the server (not a missing connection) still stops the review", async () => {
    save.mockResolvedValue({ ok: false, error: "ms.err.COUNT_OUT_OF_ORDER" });
    setup();
    await userEvent.type(field(), "4");
    await userEvent.click(screen.getByRole("button", { name: "Review and confirm" }));
    expect(await screen.findByText(/Counts must be entered in order/)).toBeInTheDocument();
    expect(screen.queryByText("Review your count")).not.toBeInTheDocument();
  });

  it("once queued, the connection coming back does NOT create a server draft that would put the queued copy in conflict with itself", async () => {
    setOnline(false);
    setup();
    await userEvent.type(field(), "4");
    await userEvent.click(screen.getByRole("button", { name: "Review and confirm" }));
    await userEvent.click(await screen.findByRole("button", { name: "Confirm count" }));
    await screen.findByRole("heading", { name: "Saved on this device" });

    setOnline(true);
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await new Promise((r) => setTimeout(r, 1700)); // longer than the autosave delay
    expect(save).not.toHaveBeenCalled();
  });
});

describe("another device confirmed first", () => {
  it("keeps this device's numbers next to the server's copy, and explains why they were not applied", async () => {
    confirm.mockResolvedValue({
      ok: false, error: "ms.conflictConfirmed", conflict: true,
      conflictInfo: { reason: "already_confirmed", server: { sessionId: "s9", revision: 3, status: "confirmed", by: "Nimal", confirmedAt: null, lines: [{ variantId: oil.variantId, quantity: "7.000" }] } },
    });
    setup();
    await confirmCount();
    expect(await screen.findByText(/already confirmed from another device, so your numbers were not applied/)).toBeInTheDocument();
    await waitFor(async () => expect(await listQueued(SCOPE)).toHaveLength(1));
    const [c] = await listQueued(SCOPE);
    expect(c).toMatchObject({ state: "conflict", yours: { [oil.variantId]: "4" }, conflict: { reason: "already_confirmed", server: { revision: 3 } } });
    expect(screen.queryByText("Stock saved.")).not.toBeInTheDocument();
  });
});
