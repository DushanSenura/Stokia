// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { CatalogItem } from "@/features/inventory/catalog-types";
import { noteSentence } from "@/features/reports/note-text";
import { createTranslator } from "@/i18n";
import { categoriesOf, filterCatalog, groupByProduct } from "../../mobile/src/features/products/catalog";
import { peakOf, scaleBars } from "../../mobile/src/features/reports/chart";
import { ApiForbidden, ApiUnreachable, createApi, safeFileName } from "../../mobile/src/lib/api-client";

const item = (over: Partial<CatalogItem> = {}): CatalogItem => ({
  variantId: "v", productName: "Chilli Powder", productCode: "CHL", category: "Spices", size: "250 g", sku: "CHL-250", baseUnit: "packet",
  sellingPrice: "150.00", lastCounted: "30", lowStockLevel: "10", low: false, packaging: [], ...over,
});
const catalog = [
  item({ variantId: "1", productName: "Chilli Powder", productCode: "CHL", size: "250 g", sku: "CHL-250", category: "Spices" }),
  item({ variantId: "2", productName: "Chilli Powder", productCode: "CHL", size: "1 kg", sku: "CHL-1K", category: "Spices", low: true }),
  item({ variantId: "3", productName: "Coconut Oil", productCode: "OIL", size: "1 L", sku: "OIL-1L", category: "Oils" }),
  item({ variantId: "4", productName: "Salt", productCode: "SLT", size: "", sku: "SLT-1", category: null, low: true }),
];

describe("Products tab: filtering", () => {
  const f = (over: Partial<Parameters<typeof filterCatalog>[1]> = {}) => filterCatalog(catalog, { query: "", category: "", lowOnly: false, ...over }).map((i) => i.variantId);

  it("shows everything with no filters", () => expect(f()).toEqual(["1", "2", "3", "4"]));
  it("searches name, code, SKU and size, ignoring case and surrounding spaces", () => {
    expect(f({ query: "  chilli " })).toEqual(["1", "2"]);
    expect(f({ query: "oil-1l" })).toEqual(["3"]);
    expect(f({ query: "1 kg" })).toEqual(["2"]);
    expect(f({ query: "SLT" })).toEqual(["4"]);
    expect(f({ query: "nothing like this" })).toEqual([]);
  });
  it("narrows by category", () => expect(f({ category: "Oils" })).toEqual(["3"]));
  it("'low stock only' keeps just the low products", () => expect(f({ lowOnly: true })).toEqual(["2", "4"]));
  it("combines every filter", () => expect(f({ query: "chilli", lowOnly: true, category: "Spices" })).toEqual(["2"]));
});

describe("Products tab: grouping", () => {
  it("one card per product listing its sizes, in the order received, counting low sizes", () => {
    const groups = groupByProduct(catalog);
    expect(groups.map((g) => [g.name, g.items.map((i) => i.variantId), g.lowCount])).toEqual([
      ["Chilli Powder", ["1", "2"], 1], ["Coconut Oil", ["3"], 0], ["Salt", ["4"], 1],
    ]);
  });
  it("two different products with the same name stay separate (they have different codes)", () => {
    const g = groupByProduct([item({ productName: "Rice", productCode: "R1" }), item({ productName: "Rice", productCode: "R2" })]);
    expect(g).toHaveLength(2);
  });
  it("lists categories once, sorted, without 'none'", () => expect(categoriesOf(catalog)).toEqual(["Oils", "Spices"]));
});

describe("Reports tab: chart scaling", () => {
  it("heights are proportional to the amount, the highest filling the height", () => {
    expect(scaleBars([{ key: "a", amount: 100 }, { key: "b", amount: 50 }, { key: "c", amount: 25 }], 80).map((b) => b.height)).toEqual([80, 40, 20]);
  });
  it("a day with NO figure has no bar (not the same as a day that sold nothing, and neither is drawn as a sale)", () => {
    const bars = scaleBars([{ key: "a", amount: 100 }, { key: "b", amount: null }, { key: "c", amount: 0 }], 80);
    expect(bars.map((b) => b.height)).toEqual([80, 0, 0]);
    expect(bars[1].amount).toBeNull();
    expect(bars[2].amount).toBe(0);
  });
  it("a small real amount is still visible", () => {
    expect(scaleBars([{ key: "a", amount: 100000 }, { key: "b", amount: 1 }], 80)[1].height).toBe(4);
  });
  it("copes with nothing to draw", () => {
    expect(scaleBars([], 80)).toEqual([]);
    expect(scaleBars([{ key: "a", amount: null }, { key: "b", amount: 0 }], 80).map((b) => b.height)).toEqual([0, 0]);
  });
  it("finds the highest day, the earliest winning a tie, and none when nothing sold", () => {
    expect(peakOf([{ key: "a", amount: 10 }, { key: "b", amount: 30 }, { key: "c", amount: 30 }])).toEqual({ key: "b", amount: 30 });
    expect(peakOf([{ key: "a", amount: null }, { key: "b", amount: 0 }])).toBeNull();
  });
});

describe("report notes use the web app's exact wording", () => {
  it("formats the date for the reader's language and fills the numbers", () => {
    const t = createTranslator("en");
    expect(noteSentence({ code: "waiting_closing_count", params: { date: "2026-11-01" } }, t, "en")).toBe(
      "The last day of the month is calculated by the 1 November 2026 count, which has not been confirmed yet. Totals are incomplete.");
    expect(noteSentence({ code: "days_review", params: { count: 3 } }, t, "en")).toContain("Product-days needing review: 3");
  });
  it("falls back to English for Sinhala keys that are not translated yet", () => {
    expect(noteSentence({ code: "uncosted", params: { count: 2 } }, createTranslator("si"), "si")).toMatch(/2/);
  });
});

describe("safe file names (a report is written into the app's cache)", () => {
  it("keeps an ordinary name", () => expect(safeFileName("Stokia-2026-10.pdf", "x.pdf")).toBe("Stokia-2026-10.pdf"));
  it("removes folders and path tricks, so a name can never escape the cache folder", () => {
    for (const evil of ["../../etc/passwd", "..\\..\\secret.pdf", "/abs/path.pdf", "a/b/c.pdf", "....//x.pdf"]) {
      const name = safeFileName(evil, "fallback.pdf");
      expect(name, evil).not.toMatch(/[\\/]/);
      expect(name.startsWith("."), evil).toBe(false);
    }
  });
  it("drops control characters and odd symbols, and falls back when nothing is left", () => {
    expect(safeFileName("re\u0000po<rt>|?.pdf", "f.pdf")).toBe("report.pdf");
    expect(safeFileName("", "fallback.pdf")).toBe("fallback.pdf");
    expect(safeFileName(null, "fallback.pdf")).toBe("fallback.pdf");
    expect(safeFileName("../", "fallback.pdf")).toBe("fallback.pdf");
  });
  it("is not unbounded", () => expect(safeFileName("a".repeat(500) + ".pdf", "f.pdf").length).toBeLessThanOrEqual(80));
});

describe("API client: the new reads and the report file", () => {
  const reply = (status: number, body?: BodyInit | null, headers: Record<string, string> = {}) => new Response(body ?? null, { status, headers });
  const make = (handler: (url: string) => Response | Promise<Response>) => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => handler(String(url)));
    return { fetchMock, api: createApi({ baseUrl: "https://stokia.example", getToken: async () => "t", refresh: async () => "t2", fetch: fetchMock as unknown as typeof fetch }) };
  };

  it("calls the right addresses with encoded parameters", async () => {
    const t = make(() => reply(200, JSON.stringify({ ok: true })));
    await t.api.products("a b"); await t.api.reports("s"); await t.api.report("s", "2026-10");
    expect(t.fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "https://stokia.example/api/v1/products?shop=a%20b", "https://stokia.example/api/v1/reports?shop=s", "https://stokia.example/api/v1/reports/2026-10?shop=s",
    ]);
  });

  it("downloads the report file as bytes, with its name and type from the headers", async () => {
    const t = make(() => reply(200, new Uint8Array([37, 80, 68, 70]), { "content-type": "application/pdf", "content-disposition": 'attachment; filename="Stokia-2026-10.pdf"' }));
    const f = await t.api.reportFile("s", "2026-10", "pdf");
    expect([...f.bytes]).toEqual([37, 80, 68, 70]);
    expect(f).toMatchObject({ fileName: "Stokia-2026-10.pdf", mime: "application/pdf" });
    expect(t.fetchMock.mock.calls[0][0]).toBe("https://stokia.example/api/v1/reports/2026-10/file?shop=s&format=pdf");
  });

  it("never trusts a file name from the server: a hostile one is made safe", async () => {
    const t = make(() => reply(200, new Uint8Array([1]), { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="../../evil.csv"' }));
    const f = await t.api.reportFile("s", "2026-10", "csv");
    expect(f.fileName).not.toMatch(/[\\/]/);
    expect(f.mime).toBe("text/csv");
  });

  it("falls back to a sensible name when the header is missing", async () => {
    const t = make(() => reply(200, new Uint8Array([1])));
    expect((await t.api.reportFile("s", "2026-10", "xlsx")).fileName).toBe("Stokia-2026-10.xlsx");
  });

  it("a refusal is 'forbidden'; a server problem or a missing body is 'unreachable' (so the screen offers to try again)", async () => {
    await expect(make(() => reply(403, "{}")).api.reportFile("s", "2026-10", "pdf")).rejects.toBeInstanceOf(ApiForbidden);
    await expect(make(() => reply(500, "{}")).api.reportFile("s", "2026-10", "pdf")).rejects.toBeInstanceOf(ApiUnreachable);
    await expect(make(() => reply(400, JSON.stringify({ ok: false }))).api.reportFile("s", "2026-10", "pdf")).rejects.toBeInstanceOf(ApiUnreachable);
  });
});
