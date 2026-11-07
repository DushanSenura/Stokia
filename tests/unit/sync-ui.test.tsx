import "fake-indexeddb/auto";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncBanner } from "@/components/sync/sync-banner";
import { ToastProvider } from "@/components/ui/toast";
import { BASE_KEY } from "@/features/inventory/count-entry";
import { loadLocalDraft, clearAllLocalDrafts } from "@/lib/offline/draft-store";
import { clearAllQueued, enqueueConflict, enqueueCount, listQueued, syncQueue, type NewQueuedCount } from "@/lib/offline/sync-queue";
import { I18nProvider } from "@/providers/i18n-provider";
import { SyncProvider } from "@/providers/sync-provider";
import type { CountConflict, CountResult } from "@/server/actions/inventory";

const confirm = vi.fn();
const labels = vi.fn();
vi.mock("@/server/actions/inventory", () => ({
  confirmCountAction: (...a: unknown[]) => confirm(...a),
  variantLabelsAction: (...a: unknown[]) => labels(...a),
}));
const router = { refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const SCOPE = "shop1:user1";
const DATE = "2026-11-02";
const V1 = "00000000-0000-4000-8000-000000000001";
const V2 = "00000000-0000-4000-8000-000000000002";

const entry = (date = DATE, over: Partial<NewQueuedCount> = {}): NewQueuedCount => ({
  scope: SCOPE, businessDate: date, ack: true, key: `key-${date}-original`,
  payload: { businessDate: date, revision: null, items: [{ variantId: V1, entries: [{ unitId: null, quantity: "4" }] }] },
  labels: { [V1]: { name: "Coconut Oil 1 L", unit: "bottle" } }, yours: { [V1]: "4" }, ...over,
});
const serverCopy = (status: "draft" | "confirmed", revision = 5): NonNullable<CountConflict["server"]> => ({
  sessionId: "s9", revision, status, by: "Nimal", confirmedAt: null,
  lines: [{ variantId: V1, quantity: "7.000" }, { variantId: V2, quantity: "3.000" }],
});
const ok: CountResult = { ok: true, sessionId: "s1", revision: 3, counted: 1, confirmed: true };

const setOnline = (value: boolean) => Object.defineProperty(window.navigator, "onLine", { value, configurable: true });
const ui = () => render(
  <I18nProvider locale="en"><ToastProvider><SyncProvider scope={SCOPE}><SyncBanner /></SyncProvider></ToastProvider></I18nProvider>,
);

beforeEach(async () => {
  confirm.mockReset().mockResolvedValue(ok);
  labels.mockReset().mockResolvedValue({ [V2]: "Rice 1 kg" });
  router.refresh.mockReset(); router.push.mockReset();
  setOnline(true);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await clearAllQueued();
  await clearAllLocalDrafts();
});
afterEach(() => vi.restoreAllMocks());

describe("nothing waiting", () => {
  it("renders nothing when online and no count is waiting", async () => {
    ui();
    await act(async () => {});
    expect(screen.queryByTestId("sync-banner")).not.toBeInTheDocument();
  });

  it("says so when offline, even with nothing waiting", async () => {
    setOnline(false);
    ui();
    expect(await screen.findByText(/You are offline/)).toBeInTheDocument();
  });
});

describe("a count waiting to be sent", () => {
  it("is shown as saved on this device and NOT confirmed, is sent automatically, and is cleared only by the server's answer", async () => {
    await enqueueCount(entry());
    let answer!: (r: CountResult) => void;
    confirm.mockReturnValue(new Promise<CountResult>((r) => { answer = r; }));
    ui();

    expect(await screen.findByText(/Count for 2 November 2026: saved on this device, not confirmed yet/)).toBeInTheDocument();
    expect(screen.queryByText(/was sent and confirmed/)).not.toBeInTheDocument();
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    const [payload, ack, key, device] = confirm.mock.calls[0];
    expect(payload).toMatchObject({ businessDate: DATE, revision: null });
    expect(ack).toBe(true);
    expect(key).toBe("key-2026-11-02-original");
    expect(typeof device).toBe("string");
    // while the server has not answered, the count is still listed as waiting
    expect(screen.getByRole("button", { name: /Sending/ })).toBeDisabled();
    expect(await listQueued(SCOPE)).toHaveLength(1);

    await act(async () => { answer(ok); });
    await waitFor(() => expect(screen.queryByTestId("sync-banner")).not.toBeInTheDocument());
    expect(await screen.findByText("Count for 2 November 2026 was sent and confirmed.")).toBeInTheDocument();
    expect(router.refresh).toHaveBeenCalled();
    expect(await listQueued(SCOPE)).toEqual([]);
  });

  it("offline: does not even try, and 'Send now' is disabled until the connection is back", async () => {
    setOnline(false);
    await enqueueCount(entry());
    ui();
    expect(await screen.findByText(/saved on this device, not confirmed yet/)).toBeInTheDocument();
    expect(screen.getByText(/You are offline/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send now" })).toBeDisabled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("with no answer from the server it stays queued, shows the attempt, and a later 'Send now' replays the same key", async () => {
    await enqueueCount(entry());
    confirm.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(ok);
    ui();
    expect(await screen.findByText("Attempts: 1")).toBeInTheDocument();
    expect(screen.getByText(/saved on this device, not confirmed yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(screen.queryByTestId("sync-banner")).not.toBeInTheDocument());
    expect(confirm.mock.calls.map((c) => c[2])).toEqual(["key-2026-11-02-original", "key-2026-11-02-original"]);
  });

  it("a later morning waits behind an unresolved earlier one", async () => {
    await enqueueConflict(entry("2026-11-02"), "ms.conflictConfirmed", { reason: "already_confirmed", server: serverCopy("confirmed") });
    await enqueueCount(entry("2026-11-03"));
    ui();
    expect(await screen.findByText(/Waiting for an earlier count to be sorted out first/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send now" })).toBeDisabled();
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("conflict: another device already confirmed that morning", () => {
  beforeEach(async () => {
    await enqueueConflict(entry(), "ms.conflictConfirmed", { reason: "already_confirmed", server: serverCopy("confirmed") });
  });

  it("explains that nothing was overwritten and shows both sets of numbers side by side", async () => {
    ui();
    expect(await screen.findByText(/does not match what is already saved. Nothing was overwritten/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Review and decide" }));

    const dialog = await screen.findByRole("dialog", { name: "Counts do not match" });
    expect(within(dialog).getByText(/already confirmed from another device, so yours was not applied/)).toBeInTheDocument();
    expect(within(dialog).getByText("Saved by Nimal")).toBeInTheDocument();
    expect(within(dialog).getByRole("columnheader", { name: "Your numbers" })).toBeInTheDocument();
    expect(within(dialog).getByRole("columnheader", { name: "On the server" })).toBeInTheDocument();

    const oil = within(dialog).getByRole("row", { name: /Coconut Oil 1 L/ });
    expect(within(oil).getByText("4 bottle")).toBeInTheDocument();
    expect(within(oil).getByText("7 bottle")).toBeInTheDocument();
    expect(within(oil).getByText("Different")).toBeInTheDocument();

    // a product only the server counted: its name is fetched, and this device's side reads "Not counted"
    const rice = await within(dialog).findByRole("row", { name: /Rice 1 kg/ });
    expect(within(rice).getByText("Not counted")).toBeInTheDocument();
    expect(labels).toHaveBeenCalledWith([V2]);
  });

  it("offers no way to overwrite a confirmed count: only keep the server's, or go and look at it", async () => {
    ui();
    await userEvent.click(await screen.findByRole("button", { name: "Review and decide" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Use my numbers" })).not.toBeInTheDocument();
    expect(within(dialog).getByText(/ask an owner to correct the confirmed count/)).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "View this count" })).toHaveAttribute("href", "/stock-history/s9");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("'Keep the server's numbers' asks first, then drops this device's copy", async () => {
    ui();
    await userEvent.click(await screen.findByRole("button", { name: "Review and decide" }));
    await userEvent.click(await screen.findByRole("button", { name: "Keep the server's numbers" }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("2 November 2026"));
    await waitFor(() => expect(screen.queryByTestId("sync-banner")).not.toBeInTheDocument());
    expect(await listQueued(SCOPE)).toEqual([]);
  });

  it("declining the question keeps this device's numbers", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    ui();
    await userEvent.click(await screen.findByRole("button", { name: "Review and decide" }));
    await userEvent.click(await screen.findByRole("button", { name: "Keep the server's numbers" }));
    expect(await listQueued(SCOPE)).toHaveLength(1);
  });

  it("Escape closes the screen without deciding anything", async () => {
    ui();
    await userEvent.click(await screen.findByRole("button", { name: "Review and decide" }));
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await listQueued(SCOPE)).toHaveLength(1);
  });
});

describe("conflict: another device saved a different draft", () => {
  it("'Use my numbers' resends on top of the server's revision under a new key, and the server's answer clears it", async () => {
    await enqueueConflict(entry(), "ms.conflict", { reason: "revision", server: serverCopy("draft", 7) });
    ui();
    await userEvent.click(await screen.findByRole("button", { name: "Review and decide" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Another device saved different numbers/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Use my numbers" }));

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    const [payload, , key] = confirm.mock.calls[0];
    expect(payload.revision).toBe(7);
    expect(key).not.toBe("key-2026-11-02-original");
    await waitFor(() => expect(screen.queryByTestId("sync-banner")).not.toBeInTheDocument());
  });

  it("if the server conflicts again the person sees it again (nothing is silently dropped)", async () => {
    await enqueueConflict(entry(), "ms.conflict", { reason: "revision", server: serverCopy("draft", 7) });
    confirm.mockResolvedValue({ ok: false, error: "ms.conflict", conflict: true, conflictInfo: { reason: "revision", server: serverCopy("draft", 9) } });
    ui();
    await userEvent.click(await screen.findByRole("button", { name: "Review and decide" }));
    await userEvent.click(await screen.findByRole("button", { name: "Use my numbers" }));
    expect(await screen.findByText(/does not match what is already saved/)).toBeInTheDocument();
    expect((await listQueued(SCOPE))[0]).toMatchObject({ state: "conflict", conflict: { server: { revision: 9 } } });
  });
});

describe("a count the server refused", () => {
  beforeEach(async () => {
    await enqueueCount(entry());
    await syncQueue(SCOPE, async () => ({ ok: false, error: "ms.err.COUNT_OUT_OF_ORDER" }));
  });

  it("is kept, with the reason, and never retried silently", async () => {
    ui();
    expect(await screen.findByText(/Count for 2 November 2026 could not be saved/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("'Edit again' puts the numbers back in the form and takes the person there", async () => {
    ui();
    await userEvent.click(await screen.findByRole("button", { name: "Edit again" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/morning-stock?date=2026-11-02"));
    expect((await loadLocalDraft(SCOPE, DATE))?.values).toEqual({ [V1]: { [BASE_KEY]: "4" } });
    expect(await listQueued(SCOPE)).toEqual([]);
  });

  it("'Try again' sends it again; 'Discard mine' asks first", async () => {
    ui();
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("sync-banner")).not.toBeInTheDocument());
  });

  it("'Discard mine' removes it only after the person agrees", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    ui();
    await userEvent.click(await screen.findByRole("button", { name: "Discard mine" }));
    expect(await listQueued(SCOPE)).toHaveLength(1);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "Discard mine" }));
    await waitFor(async () => expect(await listQueued(SCOPE)).toEqual([]));
  });
});
