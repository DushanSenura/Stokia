import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { en } from "@/i18n/en";
import { si } from "@/i18n/si";
import { ApiForbidden, ApiUnreachable, createApi } from "../../mobile/src/lib/api-client";
import { breakdownDraftKey, newDraft, usableDraft } from "../../mobile/src/features/sales/breakdown-drafts";

const root = path.resolve(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

describe("phone drafts of the sales breakdown", () => {
  const draft = (over: Partial<ReturnType<typeof newDraft>> = {}) => ({ base: 2, qty: { box: "4" }, reason: "", savedAt: 1, ...over });

  it("are kept per person, shop, day and product, under the prefix that signing out removes", () => {
    const key = breakdownDraftKey("shop1:user1", "2026-11-06", "variant9");
    expect(key).toBe("draft.breakdown.shop1:user1.2026-11-06.variant9");
    expect(key.startsWith("draft.")).toBe(true);
    expect(breakdownDraftKey("shop1:user2", "2026-11-06", "variant9")).not.toBe(key);
    expect(breakdownDraftKey("shop1:user1", "2026-11-05", "variant9")).not.toBe(key);
  });

  it("come back only while they still apply to the revision on the server", () => {
    expect(usableDraft(draft(), 2)).toMatchObject({ qty: { box: "4" } });
    expect(usableDraft(draft(), 3)).toBeNull(); // someone changed it meanwhile: the old draft is not offered
    expect(usableDraft(draft({ base: 0 }), 0)).not.toBeNull(); // nothing was recorded then, nothing is now
  });

  it("an empty draft is no draft", () => {
    expect(usableDraft(draft({ qty: { box: "" } }), 2)).toBeNull();
    expect(usableDraft(draft({ qty: { box: "  " }, reason: "" }), 2)).toBeNull();
    expect(usableDraft(draft({ qty: {}, reason: "Recount" }), 2)).not.toBeNull(); // a typed reason alone is something
    expect(usableDraft(null, 0)).toBeNull();
    expect(usableDraft(undefined, 0)).toBeNull();
  });

  it("newDraft stamps the time it was kept", () => {
    const before = Date.now();
    const d = newDraft(1, { box: "2" }, "why");
    expect(d).toMatchObject({ base: 1, qty: { box: "2" }, reason: "why" });
    expect(d.savedAt).toBeGreaterThanOrEqual(before);
  });
});

describe("the phone's sales-breakdown API calls", () => {
  const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  const make = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init));
    return { fetchMock, api: createApi({ baseUrl: "https://stokia.example", getToken: async () => "t", refresh: async () => "t2", fetch: fetchMock as unknown as typeof fetch }) };
  };
  const draft = { variantId: "v1", date: "2026-11-06", lines: [{ unitId: "u1", quantity: "4" }], reason: "Recount", expectedRevision: 2 };

  it("reads the day and the history with encoded parameters", async () => {
    const t = make(() => reply(200, { ok: true }));
    await t.api.salesBreakdown("a b", "2026-11-06");
    await t.api.salesBreakdownHistory("s", "v/1", "2026-11-06");
    expect(t.fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "https://stokia.example/api/v1/sales-breakdown?shop=a%20b&date=2026-11-06",
      "https://stokia.example/api/v1/sales-breakdown/history?shop=s&variant=v%2F1&date=2026-11-06",
    ]);
  });

  it("sends the draft and the key as the server expects", async () => {
    const t = make(() => reply(200, { ok: true, duplicate: false, revision: 3 }));
    expect(await t.api.saveSalesBreakdown({ shopId: "s", draft, key: "key-0001-padding" })).toEqual({ ok: true, duplicate: false, revision: 3 });
    const [url, init] = t.fetchMock.mock.calls[0];
    expect(url).toBe("https://stokia.example/api/v1/sales-breakdown");
    expect(JSON.parse(String(init!.body))).toEqual({ shopId: "s", draft, key: "key-0001-padding" });
    expect(init!.method).toBe("POST");
  });

  it("a refusal is an answer, returned (never thrown), so the screen can show the message", async () => {
    const t = make(() => reply(200, { ok: false, error: "sb.err.EXCEEDS_INFERRED" }));
    expect(await t.api.saveSalesBreakdown({ shopId: "s", draft, key: "k".repeat(10) })).toEqual({ ok: false, error: "sb.err.EXCEEDS_INFERRED" });
  });

  it("a 403 or a bad request becomes a readable refusal; no answer at all is THROWN (the draft stays, the same key is reused)", async () => {
    expect(await make(() => reply(403, { ok: false })).api.saveSalesBreakdown({ shopId: "s", draft, key: "k".repeat(10) })).toEqual({ ok: false, error: "error.forbidden" });
    expect(await make(() => reply(400, { ok: false })).api.saveSalesBreakdown({ shopId: "s", draft, key: "k".repeat(10) })).toEqual({ ok: false, error: "auth.error.generic" });
    await expect(make(() => reply(500, { ok: false })).api.saveSalesBreakdown({ shopId: "s", draft, key: "k".repeat(10) })).rejects.toBeInstanceOf(ApiUnreachable);
    await expect(make(() => { throw new TypeError("Network request failed"); }).api.saveSalesBreakdown({ shopId: "s", draft, key: "k".repeat(10) })).rejects.toBeInstanceOf(ApiUnreachable);
  });

  it("clearing sends the reason and the key", async () => {
    const t = make(() => reply(200, { ok: true, duplicate: false, revision: 4 }));
    await t.api.clearSalesBreakdown({ shopId: "s", variantId: "v1", date: "2026-11-06", reason: "Not sure", key: "key-0002-padding" });
    expect(JSON.parse(String(t.fetchMock.mock.calls[0][1]!.body))).toEqual({ shopId: "s", variantId: "v1", date: "2026-11-06", reason: "Not sure", key: "key-0002-padding" });
    expect(t.fetchMock.mock.calls[0][0]).toBe("https://stokia.example/api/v1/sales-breakdown/clear");
  });

  it("reads: a 403 is forbidden, anything but a clean answer is unreachable (the screen falls back to its saved copy)", async () => {
    await expect(make(() => reply(403, { ok: false })).api.salesBreakdown("s", "2026-11-06")).rejects.toBeInstanceOf(ApiForbidden);
    await expect(make(() => reply(500)).api.salesBreakdown("s", "2026-11-06")).rejects.toBeInstanceOf(ApiUnreachable);
  });
});

describe("web and phone behave the same, because they share the code", () => {
  const web = read("src/components/sales/sales-breakdown-panel.tsx");
  const phone = read("mobile/src/features/sales/sales-breakdown-screen.tsx");

  it("both screens take every decision from the SAME shared form logic (preview, checks, when Save is enabled)", () => {
    for (const fn of ["previewBreakdown", "checkSave", "checkClear", "canPressSave", "startingQuantities", "isWholeNumber", "formUnits"]) {
      expect(web, `web uses ${fn}`).toContain(fn);
      expect(phone, `phone uses ${fn}`).toContain(fn);
    }
    expect(web).toContain("@/features/sales/breakdown-form");
    expect(phone).toContain("@/features/sales/breakdown-form");
  });

  it("neither screen re-implements the calculation: only the shared rule computes revenue", () => {
    expect(web).not.toMatch(/computeBreakdown\s*\(/);
    expect(phone).not.toMatch(/computeBreakdown\s*\(/);
    expect(web).not.toMatch(/\*\s*Number\(u\.price|\.price\)\s*\*/);
    expect(phone).not.toMatch(/\*\s*Number\(u\.price|\.price\)\s*\*/);
  });

  it("both show the same wording: every sb.* key the phone screen uses exists in the shared dictionary, in English and Sinhala", () => {
    const keys = [...new Set([...phone.matchAll(/t\(\s*["`](sb\.[\w.]+)["`]/g)].map((m) => m[1]))].filter((k) => !k.includes("${"));
    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) {
      expect(k in en, `${k} in English`).toBe(true);
      expect(k in si, `${k} in Sinhala`).toBe(true);
    }
  });

  it("the phone saves with a key per distinct request, sends only on Save, and never queues it in the background", () => {
    expect(phone).toContain("keyForRequest");
    expect(phone).not.toMatch(/enqueue|syncQueue|movementQueue/);
    expect(phone).toContain("if (!online)"); // saving needs a connection; a draft is kept instead
  });

  it("every sb.* / pk.* / rep.pk.* English string has a Sinhala one (the packaging features are fully translated)", () => {
    const mine = Object.keys(en).filter((k) => /^(sb\.|rep\.pk\.|rep\.note\.packaging_stale|pk\.(use|price|base)\.|pk\.err\.(useNone|priceAmount|priceDate))/.test(k));
    expect(mine.length).toBeGreaterThan(80);
    expect(mine.filter((k) => !(k in si))).toEqual([]);
  });
});
