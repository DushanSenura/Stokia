import { describe, expect, it } from "vitest";
import type { CatalogItem } from "@/features/inventory/catalog-types";
import type { MovementDraft } from "@/features/movements/phone-types";
import type { QueuedMovement } from "@/lib/offline/movement-queue";
import { blankForm, buildDraft, type FormState } from "../../mobile/src/features/movements/form";
import { queuedDraft, summaryOf, waitsForCount } from "../../mobile/src/features/movements/queued";

const TZ = "Asia/Colombo";
const BUNDLE = "00000000-0000-4000-8000-0000000000b1";
const item = {
  variantId: "00000000-0000-4000-8000-000000000001", productName: "Chilli Powder", size: "250 g", sku: "CHI-250", baseUnit: "packet",
  units: [{ id: BUNDLE, name: "Bundle", parentId: null, factor: "12" }],
} as unknown as CatalogItem;
const draft = (over: Partial<MovementDraft> = {}): MovementDraft => ({ variantId: item.variantId, type: "stock_received", unitId: null, quantity: "5", when: "now", reference: "INV-1", ...over });
// 2026-11-06 18:45 in Colombo (UTC+5:30) is 13:15 UTC
const entered = new Date("2026-11-06T13:15:30.000Z");

describe("queuedDraft: the moment is fixed when the movement is ENTERED", () => {
  it("'just now' becomes the shop-local minute it was entered, so sending it hours later lands at the right time", () => {
    expect(queuedDraft(draft(), TZ, entered)).toMatchObject({ when: "custom", effectiveLocal: "2026-11-06T18:45" });
  });

  it("uses the SHOP's time zone, not the phone's", () => {
    expect(queuedDraft(draft(), "America/New_York", entered)).toMatchObject({ effectiveLocal: "2026-11-06T08:15" });
  });

  it("'before the count' keeps its meaning and names the morning it was entered", () => {
    expect(queuedDraft(draft({ when: "before_count" }), TZ, entered)).toMatchObject({ when: "before_count", countDate: "2026-11-06" });
  });

  it("an entry made just after midnight in the shop belongs to the shop's new day, not UTC's", () => {
    const justAfterMidnight = new Date("2026-11-06T18:40:00.000Z"); // 00:10 on 7 Nov in Colombo
    expect(queuedDraft(draft({ when: "before_count" }), TZ, justAfterMidnight).countDate).toBe("2026-11-07");
    expect(queuedDraft(draft(), TZ, justAfterMidnight).effectiveLocal).toBe("2026-11-07T00:10");
  });

  it("changes nothing else about the movement", () => {
    const d = draft({ type: "manual_adjustment", direction: "out", reason: "Recount", supplier: undefined });
    const q = queuedDraft(d, TZ, entered);
    expect({ ...q, when: d.when, effectiveLocal: undefined }).toEqual({ ...d, effectiveLocal: undefined });
  });

  it("a chosen time, or an already-dated one, is left alone", () => {
    const custom = draft({ when: "custom", effectiveLocal: "2026-11-01T09:00" });
    expect(queuedDraft(custom, TZ, entered)).toBe(custom);
    expect(queuedDraft(draft({ when: "before_count", countDate: "2026-11-02" }), TZ, entered).countDate).toBe("2026-11-02");
  });
});

describe("summaryOf: what the 'waiting to send' list shows", () => {
  const form = (over: Partial<FormState> = {}): FormState => ({ ...blankForm(), item, quantity: "3", unitId: BUNDLE, reference: "INV-1", ...over });

  it("shows the product, what was entered, and the SIGNED effect in the base unit (3 bundles of 12 = +36 packets)", () => {
    expect(summaryOf(form())).toEqual({ label: "Chilli Powder 250 g", baseUnit: "packet", effect: "36", entered: "3 Bundle" });
  });

  it("stock that leaves is negative", () => {
    expect(summaryOf(form({ type: "damaged", unitId: null, quantity: "2" }))).toMatchObject({ effect: "-2", entered: "2 packet" });
    expect(summaryOf(form({ type: "manual_adjustment", direction: "out", unitId: null, quantity: "1" }))).toMatchObject({ effect: "-1" });
  });

  it("refuses an incomplete form rather than showing a wrong summary", () => {
    expect(() => summaryOf(form({ item: null }))).toThrow();
    expect(() => summaryOf(form({ quantity: "" }))).toThrow();
    expect(() => summaryOf(form({ type: "manual_adjustment", direction: undefined }))).toThrow();
  });

  it("a queued draft is built from the same form the person filled in", () => {
    const f = form({ when: "before_count" });
    expect(queuedDraft(buildDraft(f), TZ, entered)).toMatchObject({ variantId: item.variantId, quantity: "3", unitId: BUNDLE, when: "before_count", countDate: "2026-11-06" });
  });
});

describe("waitsForCount: a movement 'before the count' waits for that count if the count is still queued", () => {
  const e = (over: Partial<QueuedMovement["payload"]> = {}, createdAt = entered.getTime()): QueuedMovement => ({
    id: "k", key: "k", scope: "s", payload: draft({ when: "before_count", countDate: "2026-11-06", ...over }),
    summary: { label: "", baseUnit: "", effect: "1", entered: "" }, state: "pending", maybeSent: false, attempts: 1, createdAt, lastTriedAt: null,
  });
  const noCount = { ok: false as const, fieldErrors: { when: "mv.err.noCountToday" as const } };
  const today = (at: number) => new Date(at).toISOString().slice(0, 10);

  it("waits when that morning's count is queued on this phone", () => {
    expect(waitsForCount(e(), noCount, ["2026-11-06"], today)).toBe(true);
  });

  it("fails (does not wait forever) when no count for that morning is queued either", () => {
    expect(waitsForCount(e(), noCount, ["2026-11-01"], today)).toBe(false);
    expect(waitsForCount(e(), noCount, [], today)).toBe(false);
  });

  it("only applies to 'before the count' and only to the missing-count refusal", () => {
    expect(waitsForCount(e({ when: "custom" }), noCount, ["2026-11-06"], today)).toBe(false);
    expect(waitsForCount(e(), { ok: false, fieldErrors: { reason: "mv.err.reason" } }, ["2026-11-06"], today)).toBe(false);
    expect(waitsForCount(e(), { ok: false, error: "mv.err.INVALID_VARIANT" }, ["2026-11-06"], today)).toBe(false);
  });

  it("an entry without a stated morning uses the day it was entered", () => {
    expect(waitsForCount(e({ countDate: undefined }), noCount, [today(entered.getTime())], today)).toBe(true);
  });
});
