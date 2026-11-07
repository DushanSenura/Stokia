// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getUser = vi.fn();
const tables: Record<string, unknown> = {};
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn((_url: string, _key: string, opts: { global: { headers: Record<string, string> } }) => {
    const client = {
      forwardedAuth: opts.global.headers.Authorization,
      auth: { getUser: (...a: unknown[]) => getUser(...a) },
      from(table: string) {
        const chain: Record<string, unknown> = {};
        for (const m of ["select", "eq"]) chain[m] = () => chain;
        chain.maybeSingle = async () => ({ data: tables[table] ?? null, error: null });
        chain.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: tables[table] ?? null, error: null }).then(res);
        return chain;
      },
    };
    return client;
  }),
}));

const submitCountCore = vi.fn();
const variantLabels = vi.fn();
const loadMorningStock = vi.fn();
const getSessionByDate = vi.fn();
const getLatestConfirmedDate = vi.fn();
const getSalesForDate = vi.fn();
vi.mock("@/server/services/count-submit", () => ({ submitCountCore: (...a: unknown[]) => submitCountCore(...a), variantLabels: (...a: unknown[]) => variantLabels(...a) }));
vi.mock("@/server/services/morning-stock", () => ({ loadMorningStock: (...a: unknown[]) => loadMorningStock(...a) }));
vi.mock("@/server/repositories/inventory", async (orig) => ({
  ...(await orig<typeof import("@/server/repositories/inventory")>()),
  getSessionByDate: (...a: unknown[]) => getSessionByDate(...a),
  getLatestConfirmedDate: (...a: unknown[]) => getLatestConfirmedDate(...a),
  getSalesForDate: (...a: unknown[]) => getSalesForDate(...a),
}));

import * as counts from "@/app/api/v1/counts/route";
import * as home from "@/app/api/v1/home/route";
import * as me from "@/app/api/v1/me/route";
import * as morning from "@/app/api/v1/morning-stock/route";
import * as labels from "@/app/api/v1/variant-labels/route";

const OWNER_SHOP = "11111111-1111-4111-8111-111111111111";
const VIEWER_SHOP = "22222222-2222-4222-8222-222222222222";
const OTHER_SHOP = "33333333-3333-4333-8333-333333333333";
const URL_BASE = "https://stokia.example";

const req = (path: string, init: { method?: string; token?: string | null; scheme?: string; body?: unknown; raw?: string; origin?: string } = {}) =>
  new Request(`${URL_BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.token === null ? {} : { Authorization: `${init.scheme ?? "Bearer"} ${init.token ?? "good-token"}` }),
      ...(init.origin ? { Origin: init.origin } : {}),
      "Content-Type": "application/json",
    },
    body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  delete process.env.STOKIA_API_ALLOWED_ORIGINS;
  for (const f of [getUser, submitCountCore, variantLabels, loadMorningStock, getSessionByDate, getLatestConfirmedDate, getSalesForDate]) f.mockReset();
  getUser.mockImplementation(async (token: string) => token === "good-token"
    ? { data: { user: { id: "user-1", email: "nimal@shop.lk" } }, error: null }
    : { data: { user: null }, error: { message: "invalid JWT" } });
  tables.shop_memberships = [
    { role: "owner", shops: { id: OWNER_SHOP, name: "Perera Stores", timezone: "Asia/Colombo" } },
    { role: "viewer", shops: [{ id: VIEWER_SHOP, name: "Cousin's Shop", timezone: "Asia/Colombo" }] }, // PostgREST may embed as an array
  ];
  tables.user_profiles = { display_name: "Nimal" };
  submitCountCore.mockResolvedValue({ ok: true, sessionId: "s1", revision: 3, counted: 1, confirmed: true });
  variantLabels.mockResolvedValue({ v1: "Oil 1 L" });
  loadMorningStock.mockResolvedValue({ businessDate: "2026-11-07", items: [] });
});

describe("authentication", () => {
  const endpoints: [string, (r: Request) => Promise<Response>, string][] = [
    ["GET me", me.GET, "/api/v1/me"],
    ["GET morning-stock", morning.GET, `/api/v1/morning-stock?shop=${OWNER_SHOP}`],
    ["GET home", home.GET, `/api/v1/home?shop=${OWNER_SHOP}`],
    ["POST counts", counts.POST, "/api/v1/counts"],
    ["POST variant-labels", labels.POST, "/api/v1/variant-labels"],
  ];
  for (const [name, handler, path] of endpoints) {
    it(`${name}: 401 without a token, with a non-Bearer scheme, or with a token Supabase rejects (never a stack trace)`, async () => {
      for (const init of [{ token: null }, { scheme: "Basic" }, { token: "forged-token" }]) {
        const post = name.startsWith("POST");
        const res = await handler(req(path, { method: post ? "POST" : "GET", ...(post ? { body: {} } : {}), ...init }));
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ ok: false, error: "not_signed_in" });
      }
    });
  }

  it("validates the token with Supabase Auth and forwards the SAME token to the database (so Row Level Security applies)", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    await me.GET(req("/api/v1/me"));
    expect(getUser).toHaveBeenCalledWith("good-token");
    const clientResults = vi.mocked(createClient).mock.results;
    expect((clientResults[clientResults.length - 1].value as { forwardedAuth: string }).forwardedAuth).toBe("Bearer good-token");
  });

  it("is 503 when the server has no Supabase configuration", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const res = await me.GET(req("/api/v1/me"));
    expect(res.status).toBe(503);
  });
});

describe("GET /api/v1/me", () => {
  it("returns the person and every shop they belong to, whichever way PostgREST embeds it", async () => {
    const res = await me.GET(req("/api/v1/me"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      user: { id: "user-1", email: "nimal@shop.lk", displayName: "Nimal" },
      memberships: [
        { shopId: OWNER_SHOP, shopName: "Perera Stores", timezone: "Asia/Colombo", role: "owner" },
        { shopId: VIEWER_SHOP, shopName: "Cousin's Shop", timezone: "Asia/Colombo", role: "viewer" },
      ],
    });
  });

  it("is never cached", async () => {
    expect((await me.GET(req("/api/v1/me"))).headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /api/v1/morning-stock", () => {
  it("refuses a shop the caller does not belong to, and a missing or malformed shop id, with the same answer", async () => {
    for (const q of [`?shop=${OTHER_SHOP}`, "", "?shop=not-a-uuid"]) {
      const res = await morning.GET(req(`/api/v1/morning-stock${q}`));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: "forbidden" });
    }
    expect(loadMorningStock).not.toHaveBeenCalled();
  });

  it("returns the screen data, and tells a viewer they cannot write", async () => {
    const owner = await (await morning.GET(req(`/api/v1/morning-stock?shop=${OWNER_SHOP}&date=2026-11-07`))).json();
    expect(owner).toMatchObject({ ok: true, canWrite: true, businessDate: "2026-11-07", shop: { shopId: OWNER_SHOP, role: "owner" } });
    expect(loadMorningStock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ shopId: OWNER_SHOP }), "2026-11-07");
    const viewer = await (await morning.GET(req(`/api/v1/morning-stock?shop=${VIEWER_SHOP}`))).json();
    expect(viewer).toMatchObject({ ok: true, canWrite: false });
  });

  it("a failure is a generic 500: no message, no stack, no database detail", async () => {
    loadMorningStock.mockRejectedValue(new Error('relation "stock_count_sessions" does not exist at /srv/app.ts:1'));
    const res = await morning.GET(req(`/api/v1/morning-stock?shop=${OWNER_SHOP}`));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"ok":false,"error":"load_failed"}');
  });
});

describe("POST /api/v1/counts", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    shopId: OWNER_SHOP, ackMissing: true, idempotencyKey: "key-0123456789", device: "Pixel 7",
    count: { businessDate: "2026-11-07", revision: null, items: [] }, ...over,
  });

  it("a viewer, a non-member and a malformed shop are all refused before anything is submitted", async () => {
    for (const shopId of [VIEWER_SHOP, OTHER_SHOP, undefined, 42]) {
      const res = await counts.POST(req("/api/v1/counts", { method: "POST", body: body({ shopId }) }));
      expect(res.status).toBe(403);
    }
    expect(submitCountCore).not.toHaveBeenCalled();
  });

  it("an unreadable body is a 400", async () => {
    for (const raw of ["not json", "[1,2]", "null"]) {
      expect((await counts.POST(req("/api/v1/counts", { method: "POST", raw }))).status).toBe(400);
    }
    expect(submitCountCore).not.toHaveBeenCalled();
  });

  it("submits with the shop from the verified membership, the caller's own client, the idempotency key and the device name", async () => {
    const res = await counts.POST(req("/api/v1/counts", { method: "POST", body: body() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessionId: "s1", revision: 3, counted: 1, confirmed: true });
    const [ctx, count, ack, key, device] = submitCountCore.mock.calls[0];
    expect(ctx.shopId).toBe(OWNER_SHOP);
    expect(ctx.supabase).toBeDefined();
    expect(count).toEqual(body().count);
    expect([ack, key, device]).toEqual([true, "key-0123456789", "Pixel 7"]);
  });

  it("only a real boolean true acknowledges missing products (the string 'true' does not)", async () => {
    await counts.POST(req("/api/v1/counts", { method: "POST", body: body({ ackMissing: "true" }) }));
    expect(submitCountCore.mock.calls[0][2]).toBe(false);
  });

  it("a conflict with another device is a normal answer that carries the server's copy, not an HTTP error", async () => {
    submitCountCore.mockResolvedValue({ ok: false, error: "ms.conflictConfirmed", conflict: true, conflictInfo: { reason: "already_confirmed", server: null } });
    const res = await counts.POST(req("/api/v1/counts", { method: "POST", body: body() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, conflict: true, conflictInfo: { reason: "already_confirmed" } });
  });

  it("an unexpected failure is a generic 500 (the phone replays the same key), never a message", async () => {
    submitCountCore.mockRejectedValue(new Error("password authentication failed for user postgres"));
    const res = await counts.POST(req("/api/v1/counts", { method: "POST", body: body() }));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"ok":false,"error":"submit_failed"}');
  });
});

describe("POST /api/v1/variant-labels", () => {
  it("is for people who can count, and passes only the verified shop", async () => {
    expect((await labels.POST(req("/api/v1/variant-labels", { method: "POST", body: { shopId: VIEWER_SHOP, ids: ["x"] } }))).status).toBe(403);
    const res = await labels.POST(req("/api/v1/variant-labels", { method: "POST", body: { shopId: OWNER_SHOP, ids: ["x"] } }));
    expect(await res.json()).toEqual({ ok: true, labels: { v1: "Oil 1 L" } });
    expect(variantLabels.mock.calls[0][0].shopId).toBe(OWNER_SHOP);
  });
});

describe("GET /api/v1/home", () => {
  it("reports today's status and the sales for the day BEFORE the latest confirmed count, always as estimated figures", async () => {
    getSessionByDate.mockResolvedValue({ id: "s1", status: "draft" });
    getLatestConfirmedDate.mockResolvedValue("2026-11-06");
    getSalesForDate.mockResolvedValue([
      { calculation_status: "calculated", inferred_base_units_sold: "28", estimated_sales_amount: "4200.00", product_variants: { base_inventory_unit: "packet" } },
      { calculation_status: "needs_review", inferred_base_units_sold: null, estimated_sales_amount: null, product_variants: { base_inventory_unit: "packet" } },
    ]);
    const body = await (await home.GET(req(`/api/v1/home?shop=${OWNER_SHOP}`))).json();
    expect(body).toMatchObject({ ok: true, todayStatus: "draft", latestConfirmed: "2026-11-06", salesDate: "2026-11-05" });
    expect(body.sales).toMatchObject({ calculated: 1, needsReview: 1, pending: 0, estimatedTotal: "4200.00", unitsByBaseUnit: { packet: "28" } });
    expect(getSalesForDate).toHaveBeenCalledWith(expect.anything(), OWNER_SHOP, "2026-11-05");
  });

  it("before any count exists there is no sales figure to show", async () => {
    getSessionByDate.mockResolvedValue(null);
    getLatestConfirmedDate.mockResolvedValue(null);
    const body = await (await home.GET(req(`/api/v1/home?shop=${OWNER_SHOP}`))).json();
    expect(body).toMatchObject({ todayStatus: "not_started", latestConfirmed: null, salesDate: null, sales: null });
    expect(getSalesForDate).not.toHaveBeenCalled();
  });

  it("a confirmed session today reads as confirmed; another shop is refused", async () => {
    getSessionByDate.mockResolvedValue({ id: "s1", status: "confirmed" });
    getLatestConfirmedDate.mockResolvedValue(null);
    expect((await (await home.GET(req(`/api/v1/home?shop=${OWNER_SHOP}`))).json()).todayStatus).toBe("confirmed");
    expect((await home.GET(req(`/api/v1/home?shop=${OTHER_SHOP}`))).status).toBe(403);
  });
});

describe("cross-origin access is closed unless an origin is explicitly allowed", () => {
  it("by default no origin gets any CORS header, on answers or preflights", async () => {
    const res = await me.GET(req("/api/v1/me", { origin: "https://evil.example" }));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await me.OPTIONS(req("/api/v1/me", { method: "OPTIONS", token: null, origin: "https://evil.example" }));
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("an allowed origin is echoed (never a wildcard) and a different one still gets nothing", async () => {
    process.env.STOKIA_API_ALLOWED_ORIGINS = "http://localhost:8082, https://app.stokia.example";
    const ok = await me.GET(req("/api/v1/me", { origin: "http://localhost:8082" }));
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:8082");
    expect(ok.headers.get("vary")).toContain("Origin");
    const pre = await me.OPTIONS(req("/api/v1/me", { method: "OPTIONS", token: null, origin: "https://app.stokia.example" }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
    const bad = await me.GET(req("/api/v1/me", { origin: "https://evil.example" }));
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });
});
