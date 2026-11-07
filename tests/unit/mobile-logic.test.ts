// @vitest-environment node
import { describe, expect, it } from "vitest";
import { en } from "@/i18n/en";
import { offlineView } from "../../mobile/src/features/stock/offline-view";
import type { MorningStockResponse } from "../../mobile/src/lib/api-client";
import { mobileEn, mobileSi } from "../../mobile/src/i18n/mobile-strings";
import { whenText } from "../../mobile/src/lib/when";

const cached = (over: Partial<MorningStockResponse> = {}): MorningStockResponse => ({
  ok: true, shop: { shopId: "s", shopName: "Perera Stores", timezone: "Asia/Colombo", role: "owner" }, canWrite: true,
  businessDate: "2026-11-06", salesDate: "2026-11-05", confirmedSessionId: null,
  items: [{ variantId: "v1", productName: "Oil", productCode: "OIL", category: null, sizeLabel: "", sku: "OIL-1", baseUnit: "packet", units: [], previousBase: "70", sellingPrice: "150" }],
  initialValues: { v1: { __base: "55" } }, session: { id: "sess", revision: 4 },
  previousDate: "2026-11-04", gapDays: 2, truncated: false, ...over,
});
const shop = { timezone: "Asia/Colombo" };
// 2026-11-07 09:00 in Colombo (UTC+5:30) is 03:30 UTC
const MORNING = new Date("2026-11-07T03:30:00Z");

describe("counting offline from the copy saved on the phone", () => {
  it("takes the count date from the phone's clock in the SHOP's time zone, and the sales date is always the day before", () => {
    const v = offlineView(cached(), shop, undefined, MORNING);
    expect(v.businessDate).toBe("2026-11-07");
    expect(v.salesDate).toBe("2026-11-06");
  });

  it("uses the shop's calendar, not the phone's: just after midnight UTC it is still the previous evening in New York but already today in Colombo", () => {
    const lateEvening = new Date("2026-11-06T19:00:00Z"); // 00:30 on the 7th in Colombo
    expect(offlineView(cached(), { timezone: "Asia/Colombo" }, undefined, lateEvening).businessDate).toBe("2026-11-07");
    expect(offlineView(cached(), { timezone: "America/New_York" }, undefined, lateEvening).businessDate).toBe("2026-11-06");
  });

  it("never offers a future date, and honours an earlier valid one", () => {
    expect(offlineView(cached(), shop, "2026-12-25", MORNING).businessDate).toBe("2026-11-07");
    expect(offlineView(cached(), shop, "not-a-date", MORNING).businessDate).toBe("2026-11-07");
    expect(offlineView(cached(), shop, "2026-11-06", MORNING).businessDate).toBe("2026-11-06");
  });

  it("keeps the products, packaging, previous count and prices from the saved copy", () => {
    const v = offlineView(cached(), shop, undefined, MORNING);
    expect(v.items).toHaveLength(1);
    expect(v.items[0]).toMatchObject({ previousBase: "70", sellingPrice: "150" });
    expect(v.previousDate).toBe("2026-11-04");
  });

  it("a server draft saved for ANOTHER morning says nothing about this one", () => {
    const v = offlineView(cached(), shop, undefined, MORNING);
    expect(v.session).toBeNull();
    expect(v.initialValues).toEqual({});
  });

  it("a draft saved for the SAME morning is kept (its revision is what the count is sent against)", () => {
    const v = offlineView(cached({ businessDate: "2026-11-07", salesDate: "2026-11-06" }), shop, undefined, MORNING);
    expect(v.session).toEqual({ id: "sess", revision: 4 });
    expect(v.initialValues).toEqual({ v1: { __base: "55" } });
  });

  it("does not trust that the day is still open: it is never shown as confirmed from a stale copy, and the server decides when it is sent", () => {
    const v = offlineView(cached({ confirmedSessionId: "old" }), shop, undefined, MORNING);
    expect(v.confirmedSessionId).toBeNull();
  });

  it("recomputes the gap since the previous confirmed count for the new date", () => {
    expect(offlineView(cached({ previousDate: "2026-11-04" }), shop, undefined, MORNING).gapDays).toBe(3);
    expect(offlineView(cached({ previousDate: null }), shop, undefined, MORNING).gapDays).toBe(0);
  });
});

describe("phone wording", () => {
  it("every Sinhala phone string has an English original and the same {placeholders}", () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, si] of Object.entries(mobileSi)) {
      expect(key in mobileEn, `${key} has no English original`).toBe(true);
      expect(vars(si), key).toEqual(vars(mobileEn[key as keyof typeof mobileEn]));
    }
  });

  it("every phone string is translated into Sinhala (a new English string needs its Sinhala too)", () => {
    const untranslated = Object.keys(mobileEn).filter((k) => !(k in mobileSi));
    expect(untranslated).toEqual([]);
  });

  it("phone-only keys never collide with the web app's shared keys (so neither can shadow the other)", () => {
    for (const key of Object.keys(mobileEn)) expect(key in en, key).toBe(false);
    for (const key of Object.keys(mobileEn)) expect(key.startsWith("m."), key).toBe(true);
  });

  it("describes how old a saved copy is in plain words", () => {
    const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
    const now = 10_000_000_000;
    expect(whenText(now - 20_000, t, now)).toBe("m.when.justNow");
    expect(whenText(now - 5 * 60_000, t, now)).toBe('m.when.minutes:{"n":5}');
    expect(whenText(now - 3 * 3_600_000, t, now)).toBe('m.when.hours:{"n":3}');
    expect(whenText(now - 2 * 86_400_000, t, now)).toBe('m.when.days:{"n":2}');
  });
});
