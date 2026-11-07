import "fake-indexeddb/auto";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MorningStockEntry, type MorningStockProps } from "@/components/stock/morning-stock-entry";
import type { EntryItem } from "@/features/inventory/count-entry";
import { clearAllLocalDrafts, clearLocalDraft, loadLocalDraft, saveLocalDraft } from "@/lib/offline/draft-store";
import { I18nProvider } from "@/providers/i18n-provider";

const save = vi.fn();
vi.mock("@/server/actions/inventory", () => ({
  saveDraftAction: (...a: unknown[]) => save(...a),
  confirmCountAction: vi.fn().mockResolvedValue({ ok: true, sessionId: "s1", revision: 9, counted: 1, confirmed: true }),
  discardDraftAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

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
const setup = (over?: Partial<MorningStockProps>) => render(<I18nProvider locale="en"><MorningStockEntry {...props(over)} /></I18nProvider>);
const field = () => screen.getByLabelText(/Remaining now \(bottle\)/);
const oilValues = (n: string) => ({ [oil.variantId]: { __base: n } });

beforeEach(async () => {
  save.mockReset().mockImplementation(async (p: { revision: number | null; items: unknown[] }) => ({ ok: true, sessionId: "s1", revision: (p.revision ?? 0) + 2, counted: p.items.length }));
  window.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  await clearAllLocalDrafts();
});

describe("device draft store (IndexedDB)", () => {
  it("round-trips a draft and keeps scopes and dates apart", async () => {
    await saveLocalDraft({ scope: SCOPE, businessDate: DATE, values: oilValues("4"), baseRevision: null });
    expect((await loadLocalDraft(SCOPE, DATE))?.values).toEqual(oilValues("4"));
    expect(await loadLocalDraft("shop1:other-user", DATE)).toBeNull(); // another account on the same device sees nothing
    expect(await loadLocalDraft(SCOPE, "2026-11-03")).toBeNull();
  });
  it("clear removes one draft; clearAll removes everything", async () => {
    await saveLocalDraft({ scope: SCOPE, businessDate: DATE, values: oilValues("4"), baseRevision: 1 });
    await saveLocalDraft({ scope: SCOPE, businessDate: "2026-11-03", values: oilValues("5"), baseRevision: 1 });
    await clearLocalDraft(SCOPE, DATE);
    expect(await loadLocalDraft(SCOPE, DATE)).toBeNull();
    expect(await loadLocalDraft(SCOPE, "2026-11-03")).not.toBeNull();
    await clearAllLocalDrafts();
    expect(await loadLocalDraft(SCOPE, "2026-11-03")).toBeNull();
  });
  it("a save queued before a clear can never resurrect the draft", async () => {
    void saveLocalDraft({ scope: SCOPE, businessDate: DATE, values: oilValues("4"), baseRevision: null });
    await clearLocalDraft(SCOPE, DATE);
    expect(await loadLocalDraft(SCOPE, DATE)).toBeNull();
  });
  it("drafts older than 14 days are dropped", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    await saveLocalDraft({ scope: SCOPE, businessDate: DATE, values: oilValues("4"), baseRevision: null });
    vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    expect(await loadLocalDraft(SCOPE, DATE)).toBeNull();
    vi.useRealTimers();
  });
  it("without IndexedDB everything is a quiet no-op", async () => {
    const real = globalThis.indexedDB;
    // @ts-expect-error simulate a blocked/unsupported browser
    delete globalThis.indexedDB;
    try {
      expect(await saveLocalDraft({ scope: SCOPE, businessDate: DATE, values: oilValues("4"), baseRevision: null })).toBe(false);
      expect(await loadLocalDraft(SCOPE, DATE)).toBeNull();
    } finally { globalThis.indexedDB = real; }
  });
});

describe("Morning stock: protecting entries on this device", () => {
  it("keeps typed entries on the device before the server has them", async () => {
    save.mockImplementation(() => new Promise(() => {})); // the network never answers
    setup();
    await userEvent.type(field(), "4");
    await waitFor(async () => expect((await loadLocalDraft(SCOPE, DATE))?.values).toEqual(oilValues("4")));
  });

  it("restores entries after a reload when the server copy is the one they were based on, then saves them", async () => {
    await saveLocalDraft({ scope: SCOPE, businessDate: DATE, values: oilValues("7"), baseRevision: null });
    setup();
    await waitFor(() => expect(field()).toHaveValue("7"));
    expect(screen.getByText(/We restored entries that were only saved on this device/)).toBeInTheDocument();
    await waitFor(() => expect(save).toHaveBeenCalled(), { timeout: 4000 });
    await waitFor(async () => expect(await loadLocalDraft(SCOPE, DATE)).toBeNull()); // the server has them: the device copy is gone
  });

  it("offers a choice instead of overwriting when the saved count moved on", async () => {
    await saveLocalDraft({ scope: SCOPE, businessDate: DATE, values: oilValues("7"), baseRevision: 2 });
    setup({ session: { id: "s1", revision: 5 }, initialValues: oilValues("3") });
    expect(await screen.findByText("This device has entries that are not in the saved count")).toBeInTheDocument();
    expect(field()).toHaveValue("3"); // nothing was replaced silently
    await userEvent.click(screen.getByRole("button", { name: "Use this device's entries" }));
    expect(field()).toHaveValue("7");
  });

  it("'Keep the saved count' deletes the device copy", async () => {
    await saveLocalDraft({ scope: SCOPE, businessDate: DATE, values: oilValues("7"), baseRevision: 2 });
    setup({ session: { id: "s1", revision: 5 }, initialValues: oilValues("3") });
    await userEvent.click(await screen.findByRole("button", { name: "Keep the saved count" }));
    expect(field()).toHaveValue("3");
    await waitFor(async () => expect(await loadLocalDraft(SCOPE, DATE)).toBeNull());
  });

  it("a device copy identical to the saved count is silently discarded", async () => {
    await saveLocalDraft({ scope: SCOPE, businessDate: DATE, values: oilValues("3"), baseRevision: 5 });
    setup({ session: { id: "s1", revision: 5 }, initialValues: oilValues("3") });
    await waitFor(async () => expect(await loadLocalDraft(SCOPE, DATE)).toBeNull());
    expect(screen.queryByText(/restored entries/)).not.toBeInTheDocument();
  });

  it("tells the person when they are offline, and saves as soon as the connection returns", async () => {
    setup();
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    await act(async () => { window.dispatchEvent(new Event("offline")); });
    expect(screen.getByText(/You are offline/)).toBeInTheDocument();
    await userEvent.type(field(), "4");
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    save.mockClear();
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(screen.queryByText(/You are offline/)).not.toBeInTheDocument();
  });

  it("does not touch the device when no scope is given (read-only roles, previews)", async () => {
    setup({ draftScope: undefined });
    await userEvent.type(field(), "4");
    await new Promise((r) => setTimeout(r, 450));
    expect(await loadLocalDraft(SCOPE, DATE)).toBeNull();
  });
});
