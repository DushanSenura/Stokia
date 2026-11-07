// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoReport } from "@/features/reports/demo-data";

vi.mock("server-only", () => ({}));

const getUser = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: (...a: unknown[]) => getUser(...a) },
    from() {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) chain[m] = () => chain;
      chain.maybeSingle = async () => ({ data: { display_name: "Nimal" }, error: null });
      chain.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [{ role: "viewer", shops: { id: "11111111-1111-4111-8111-111111111111", name: "Perera Stores", timezone: "Asia/Colombo" } }], error: null }).then(res);
      return chain;
    },
  })),
}));

const loadProductCatalog = vi.fn();
const loadReportIndex = vi.fn();
const loadMonthlyReport = vi.fn();
const listSessions = vi.fn();
const displayNames = vi.fn();
const buildReportFile = vi.fn();
vi.mock("@/server/services/product-catalog", () => ({ loadProductCatalog: (...a: unknown[]) => loadProductCatalog(...a) }));
vi.mock("@/server/repositories/reports", async (orig) => ({
  ...(await orig<typeof import("@/server/repositories/reports")>()),
  loadReportIndex: (...a: unknown[]) => loadReportIndex(...a),
  loadMonthlyReport: (...a: unknown[]) => loadMonthlyReport(...a),
}));
vi.mock("@/server/repositories/inventory", async (orig) => ({
  ...(await orig<typeof import("@/server/repositories/inventory")>()),
  listSessions: (...a: unknown[]) => listSessions(...a),
  displayNames: (...a: unknown[]) => displayNames(...a),
}));
vi.mock("@/server/services/report-file", async (orig) => ({
  ...(await orig<typeof import("@/server/services/report-file")>()),
  buildReportFile: (...a: unknown[]) => buildReportFile(...a),
}));

import * as file from "@/app/api/v1/reports/[month]/file/route";
import * as month from "@/app/api/v1/reports/[month]/route";
import * as index from "@/app/api/v1/reports/route";
import * as products from "@/app/api/v1/products/route";

const SHOP = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const BASE = "https://stokia.example";
const req = (path: string, init: { token?: string | null; origin?: string } = {}) =>
  new Request(`${BASE}${path}`, { headers: { ...(init.token === null ? {} : { Authorization: `Bearer ${init.token ?? "good-token"}` }), ...(init.origin ? { Origin: init.origin } : {}) } });
const params = (m: string) => ({ params: Promise.resolve({ month: m }) });

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  delete process.env.STOKIA_API_ALLOWED_ORIGINS;
  for (const f of [getUser, loadProductCatalog, loadReportIndex, loadMonthlyReport, listSessions, displayNames, buildReportFile]) f.mockReset();
  getUser.mockImplementation(async (t: string) => (t === "good-token" ? { data: { user: { id: "u", email: "n@s.lk" } }, error: null } : { data: { user: null }, error: { message: "bad" } }));
  loadProductCatalog.mockResolvedValue({ asOf: "2026-11-06", items: [], truncated: false });
  loadReportIndex.mockResolvedValue([{ month: "2026-11", estimatedSales: "10500.00", status: "in_progress" }]);
  loadMonthlyReport.mockResolvedValue(demoReport());
  listSessions.mockResolvedValue({ rows: [], tally: new Map(), total: 0, page: 1 });
  displayNames.mockResolvedValue(new Map());
  buildReportFile.mockResolvedValue({ ok: true, body: new Uint8Array([37, 80, 68, 70]), type: "application/pdf", fileName: "Stokia-2026-10.pdf" });
});

describe("authentication and shop membership (all four read routes)", () => {
  const routes: [string, (r: Request, c?: never) => Promise<Response>, string][] = [
    ["products", products.GET, `/api/v1/products?shop=${SHOP}`],
    ["reports", index.GET, `/api/v1/reports?shop=${SHOP}`],
    ["report month", (r) => month.GET(r, params("2026-10")), `/api/v1/reports/2026-10?shop=${SHOP}`],
    ["report file", (r) => file.GET(r, params("2026-10")), `/api/v1/reports/2026-10/file?shop=${SHOP}&format=pdf`],
  ];
  for (const [name, handler, path] of routes) {
    it(`${name}: 401 without a valid token`, async () => {
      expect((await handler(req(path, { token: null }))).status).toBe(401);
      expect((await handler(req(path, { token: "forged" }))).status).toBe(401);
    });
    it(`${name}: 403 for a shop the caller does not belong to, and for a malformed shop`, async () => {
      expect((await handler(req(path.replace(SHOP, OTHER)))).status).toBe(403);
      expect((await handler(req(path.replace(SHOP, "nope")))).status).toBe(403);
    });
  }
});

describe("GET /api/v1/products", () => {
  it("returns the catalog (a viewer may look: it is read-only)", async () => {
    loadProductCatalog.mockResolvedValue({ asOf: "2026-11-06", items: [{ variantId: "v1", productName: "Oil" }], truncated: false });
    const body = await (await products.GET(req(`/api/v1/products?shop=${SHOP}`))).json();
    expect(body).toMatchObject({ ok: true, asOf: "2026-11-06", items: [{ productName: "Oil" }], shop: { shopId: SHOP, role: "viewer" } });
    expect(loadProductCatalog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ shopId: SHOP, timezone: "Asia/Colombo" }));
  });
  it("a failure is a generic 500", async () => {
    loadProductCatalog.mockRejectedValue(new Error("relation does not exist at /srv/x.ts:9"));
    const res = await products.GET(req(`/api/v1/products?shop=${SHOP}`));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"ok":false,"error":"load_failed"}');
  });
});

describe("GET /api/v1/reports", () => {
  it("lists the months and the most recent CONFIRMED counts (drafts are not history), with who confirmed them", async () => {
    listSessions.mockResolvedValue({
      rows: [
        { id: "s3", business_date: "2026-11-07", status: "draft", confirmed_at: null, confirmed_by: null },
        { id: "s2", business_date: "2026-11-06", status: "confirmed", confirmed_at: "2026-11-06T03:00:00Z", confirmed_by: "u1" },
        { id: "s1", business_date: "2026-11-05", status: "corrected", confirmed_at: "2026-11-05T03:00:00Z", confirmed_by: null },
      ],
      tally: new Map([["s2", { counted: 8, notCounted: 2 }]]), total: 3, page: 1,
    });
    displayNames.mockResolvedValue(new Map([["u1", "Nimal"]]));
    const body = await (await index.GET(req(`/api/v1/reports?shop=${SHOP}`))).json();
    expect(body.months).toEqual([{ month: "2026-11", estimatedSales: "10500.00", status: "in_progress" }]);
    expect(body.recent).toEqual([
      { id: "s2", businessDate: "2026-11-06", status: "confirmed", confirmedAt: "2026-11-06T03:00:00Z", by: "Nimal", counted: 8, notCounted: 2 },
      { id: "s1", businessDate: "2026-11-05", status: "corrected", confirmedAt: "2026-11-05T03:00:00Z", by: null, counted: 0, notCounted: 0 },
    ]);
  });
  it("a failure is a generic 500", async () => {
    loadReportIndex.mockRejectedValue(new Error("boom"));
    expect((await (await index.GET(req(`/api/v1/reports?shop=${SHOP}`))).text())).toBe('{"ok":false,"error":"load_failed"}');
  });
});

describe("GET /api/v1/reports/[month]", () => {
  it("returns the report without the per-variant table (the phone gets per-product totals), and never invents a month", async () => {
    const full = demoReport();
    expect(full.variants.length).toBeGreaterThan(0);
    const body = await (await month.GET(req(`/api/v1/reports/2026-10?shop=${SHOP}`), params("2026-10"))).json();
    expect(body.ok).toBe(true);
    expect("variants" in body.report).toBe(false);
    expect(body.report.totals.estimatedSales).toBe(full.totals.estimatedSales);
    expect(body.report.products).toEqual(JSON.parse(JSON.stringify(full.products)));
    expect(loadMonthlyReport.mock.calls[0][2]).toBe("2026-10");
  });
  it("refuses a malformed, impossible or future month with a 400 and loads nothing", async () => {
    for (const m of ["2026-13", "20261", "yesterday", "2999-01", "1999-12", "2026-10-01"]) {
      const res = await month.GET(req(`/api/v1/reports/${m}?shop=${SHOP}`), params(m));
      expect(res.status, m).toBe(400);
    }
    expect(loadMonthlyReport).not.toHaveBeenCalled();
  });
  it("a failure is a generic 500", async () => {
    loadMonthlyReport.mockRejectedValue(new Error("secret detail"));
    expect(await (await month.GET(req(`/api/v1/reports/2026-10?shop=${SHOP}`), params("2026-10"))).text()).toBe('{"ok":false,"error":"load_failed"}');
  });
});

describe("GET /api/v1/reports/[month]/file", () => {
  const get = (q: string, m = "2026-10", origin?: string) => file.GET(req(`/api/v1/reports/${m}/file?shop=${SHOP}${q}`, { origin }), params(m));

  it("returns the file with its type and name, never cached, for any member (a viewer may export what they can see)", async () => {
    const res = await get("&format=pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="Stokia-2026-10.pdf"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([37, 80, 68, 70]);
    expect(buildReportFile).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ shopId: SHOP }), "2026-10", "pdf");
  });

  it("accepts exactly pdf, xlsx and csv", async () => {
    for (const f of ["pdf", "xlsx", "csv"]) expect((await get(`&format=${f}`)).status).toBe(200);
    for (const f of ["", "&format=exe", "&format=html", "&format=PDF", "&format=pdf%00"]) expect((await get(f)).status, f).toBe(400);
  });

  it("refuses an invalid month before building anything", async () => {
    expect((await get("&format=pdf", "2999-01")).status).toBe(400);
    expect((await get("&format=pdf", "not-a-month")).status).toBe(400);
    expect(buildReportFile).not.toHaveBeenCalled();
  });

  it("when the export cannot be built or logged, the answer is a generic 500 with no file", async () => {
    buildReportFile.mockResolvedValue({ ok: false, error: "Could not record the export. Please try again." });
    const res = await get("&format=csv");
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"ok":false,"error":"export_failed"}');
  });

  it("exposes the file name to a browser only for an explicitly allowed origin", async () => {
    expect((await get("&format=pdf", "2026-10", "https://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
    process.env.STOKIA_API_ALLOWED_ORIGINS = "http://localhost:8082";
    const ok = await get("&format=pdf", "2026-10", "http://localhost:8082");
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:8082");
    expect(ok.headers.get("access-control-expose-headers")).toBe("content-disposition");
  });
});
