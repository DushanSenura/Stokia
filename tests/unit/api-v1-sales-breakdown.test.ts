// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getUser = vi.fn();
const memberships: { role: string; shops: { id: string; name: string; timezone: string } }[] = [];
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: (...a: unknown[]) => getUser(...a) },
    from() {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) chain[m] = () => chain;
      chain.maybeSingle = async () => ({ data: { display_name: "Nimal" }, error: null });
      chain.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: memberships, error: null }).then(res);
      return chain;
    },
  })),
}));

const loadBreakdownDay = vi.fn();
const saveBreakdownCore = vi.fn();
const clearBreakdownCore = vi.fn();
const loadBreakdownHistory = vi.fn();
vi.mock("@/server/services/sales-breakdown", () => ({
  loadBreakdownDay: (...a: unknown[]) => loadBreakdownDay(...a),
  saveBreakdownCore: (...a: unknown[]) => saveBreakdownCore(...a),
  clearBreakdownCore: (...a: unknown[]) => clearBreakdownCore(...a),
  loadBreakdownHistory: (...a: unknown[]) => loadBreakdownHistory(...a),
}));

import * as day from "@/app/api/v1/sales-breakdown/route";
import * as clear from "@/app/api/v1/sales-breakdown/clear/route";
import * as history from "@/app/api/v1/sales-breakdown/history/route";

const OWNER = "11111111-1111-4111-8111-111111111111";
const VIEWER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const V = "00000000-0000-4000-8000-000000000001";
const BOX = "00000000-0000-4000-8000-0000000000b1";
const DATE = "2026-11-06";

const get = (path: string, token: string | null = "good") => new Request(`https://x.example${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const post = (path: string, body: unknown, token: string | null = "good") =>
  new Request(`https://x.example${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });
const draft = { variantId: V, date: DATE, lines: [{ unitId: BOX, quantity: "4" }] };
const rec = (over: Record<string, unknown> = {}) => ({ shopId: OWNER, key: "breakdown-key-0001", draft, ...over });

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  for (const f of [getUser, loadBreakdownDay, saveBreakdownCore, clearBreakdownCore, loadBreakdownHistory]) f.mockReset();
  getUser.mockImplementation(async (t: string) => (t === "good" ? { data: { user: { id: "u", email: "n@s.lk" } }, error: null } : { data: { user: null }, error: { message: "bad" } }));
  memberships.length = 0;
  memberships.push(
    { role: "owner", shops: { id: OWNER, name: "Perera Stores", timezone: "Asia/Colombo" } },
    { role: "viewer", shops: { id: VIEWER, name: "Cousin's Shop", timezone: "Asia/Colombo" } },
  );
  loadBreakdownDay.mockResolvedValue({ date: DATE, items: [], unavailable: 0 });
  saveBreakdownCore.mockResolvedValue({ ok: true, duplicate: false, revision: 1, amount: "4150.00" });
  clearBreakdownCore.mockResolvedValue({ ok: true, duplicate: false, revision: 2 });
  loadBreakdownHistory.mockResolvedValue([]);
});

describe("GET /api/v1/sales-breakdown", () => {
  it("401 without a valid token; 403 for another shop", async () => {
    expect((await day.GET(get(`/api/v1/sales-breakdown?shop=${OWNER}&date=${DATE}`, null))).status).toBe(401);
    expect((await day.GET(get(`/api/v1/sales-breakdown?shop=${OWNER}&date=${DATE}`, "forged"))).status).toBe(401);
    expect((await day.GET(get(`/api/v1/sales-breakdown?shop=${OTHER}&date=${DATE}`))).status).toBe(403);
  });

  it("any member may read (a viewer included), and is told whether they may change anything", async () => {
    const owner = await (await day.GET(get(`/api/v1/sales-breakdown?shop=${OWNER}&date=${DATE}`))).json();
    expect(owner).toMatchObject({ ok: true, canWrite: true, day: { date: DATE } });
    const viewer = await (await day.GET(get(`/api/v1/sales-breakdown?shop=${VIEWER}&date=${DATE}`))).json();
    expect(viewer).toMatchObject({ ok: true, canWrite: false });
  });

  it("uses the verified shop and its time zone", async () => {
    await day.GET(get(`/api/v1/sales-breakdown?shop=${OWNER}&date=${DATE}`));
    const [ctx, tz, date] = loadBreakdownDay.mock.calls[0];
    expect(ctx.shopId).toBe(OWNER);
    expect(tz).toBe("Asia/Colombo");
    expect(date).toBe(DATE);
  });

  it("a missing or malformed date is a 400 before any work is done", async () => {
    for (const q of ["", "&date=yesterday", "&date=2026-13-40"]) expect((await day.GET(get(`/api/v1/sales-breakdown?shop=${OWNER}${q}`))).status, q).toBe(400);
    expect(loadBreakdownDay).not.toHaveBeenCalled();
  });

  it("a failure is a generic 500 with no detail", async () => {
    loadBreakdownDay.mockRejectedValue(new Error("password authentication failed"));
    const res = await day.GET(get(`/api/v1/sales-breakdown?shop=${OWNER}&date=${DATE}`));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/password/);
  });
});

describe("POST /api/v1/sales-breakdown", () => {
  it("401 without a token", async () => {
    expect((await day.POST(post("/api/v1/sales-breakdown", rec(), null))).status).toBe(401);
  });

  it("only people who may count may record: a viewer, a stranger and a malformed shop are refused before anything is recorded", async () => {
    expect((await day.POST(post("/api/v1/sales-breakdown", rec({ shopId: VIEWER })))).status).toBe(403);
    expect((await day.POST(post("/api/v1/sales-breakdown", rec({ shopId: OTHER })))).status).toBe(403);
    expect((await day.POST(post("/api/v1/sales-breakdown", rec({ shopId: "x" })))).status).toBeGreaterThanOrEqual(400);
    expect(saveBreakdownCore).not.toHaveBeenCalled();
  });

  it("an unreadable body, or a body without a draft or lines, is a 400", async () => {
    expect((await day.POST(post("/api/v1/sales-breakdown", "not json"))).status).toBe(400);
    expect((await day.POST(post("/api/v1/sales-breakdown", { shopId: OWNER, key: "k".repeat(10) }))).status).toBe(400);
    expect((await day.POST(post("/api/v1/sales-breakdown", rec({ draft: { ...draft, lines: "x" } })))).status).toBe(400);
    expect(saveBreakdownCore).not.toHaveBeenCalled();
  });

  it("passes the draft and the key to the shared service, in the verified shop", async () => {
    const res = await day.POST(post("/api/v1/sales-breakdown", rec({ draft: { ...draft, reason: "Recount", expectedRevision: 2 } })));
    expect(await res.json()).toEqual({ ok: true, duplicate: false, revision: 1, amount: "4150.00" });
    const [ctx, tz, d, key] = saveBreakdownCore.mock.calls[0];
    expect(ctx.shopId).toBe(OWNER);
    expect(tz).toBe("Asia/Colombo");
    expect(d).toEqual({ variantId: V, date: DATE, lines: [{ unitId: BOX, quantity: "4" }], reason: "Recount", expectedRevision: 2 });
    expect(key).toBe("breakdown-key-0001");
  });

  it("anything that is not a string is dropped (so the shared validation refuses it), and a non-integer revision is ignored", async () => {
    await day.POST(post("/api/v1/sales-breakdown", rec({ key: 12345, draft: { ...draft, lines: [{ unitId: BOX, quantity: 4 }, null], reason: { $ne: "" }, expectedRevision: "2" } })));
    const [, , d, key] = saveBreakdownCore.mock.calls[0];
    expect(d.lines).toEqual([{ unitId: BOX, quantity: "" }, { unitId: "", quantity: "" }]);
    expect(d.reason).toBeUndefined();
    expect(d.expectedRevision).toBeNull();
    expect(key).toBe("");
  });

  it("a refusal (a rule, a missing reason) is a normal 200 answer carrying the message", async () => {
    saveBreakdownCore.mockResolvedValue({ ok: false, error: "sb.err.EXCEEDS_INFERRED" });
    const res = await day.POST(post("/api/v1/sales-breakdown", rec()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, error: "sb.err.EXCEEDS_INFERRED" });
  });

  it("a retry is reported as a duplicate", async () => {
    saveBreakdownCore.mockResolvedValue({ ok: true, duplicate: true, revision: 1 });
    expect(await (await day.POST(post("/api/v1/sales-breakdown", rec()))).json()).toMatchObject({ duplicate: true });
  });

  it("an unexpected failure is a generic 500 with no detail (the phone retries with the same key)", async () => {
    saveBreakdownCore.mockRejectedValue(new Error("connection refused 10.0.0.5"));
    const res = await day.POST(post("/api/v1/sales-breakdown", rec()));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/10\.0\.0\.5|refused/);
  });
});

describe("POST /api/v1/sales-breakdown/clear", () => {
  const body = (over: Record<string, unknown> = {}) => ({ shopId: OWNER, variantId: V, date: DATE, reason: "Not sure", key: "breakdown-key-0002", ...over });

  it("401 without a token; 403 for a viewer or a stranger", async () => {
    expect((await clear.POST(post("/api/v1/sales-breakdown/clear", body(), null))).status).toBe(401);
    expect((await clear.POST(post("/api/v1/sales-breakdown/clear", body({ shopId: VIEWER })))).status).toBe(403);
    expect((await clear.POST(post("/api/v1/sales-breakdown/clear", body({ shopId: OTHER })))).status).toBe(403);
    expect(clearBreakdownCore).not.toHaveBeenCalled();
  });

  it("clears in the verified shop with the reason and key", async () => {
    expect(await (await clear.POST(post("/api/v1/sales-breakdown/clear", body()))).json()).toEqual({ ok: true, duplicate: false, revision: 2 });
    const [ctx, input, key] = clearBreakdownCore.mock.calls[0];
    expect(ctx.shopId).toBe(OWNER);
    expect(input).toEqual({ variantId: V, date: DATE, reason: "Not sure" });
    expect(key).toBe("breakdown-key-0002");
  });

  it("a rule refusal is a 200 answer; an unexpected failure is a generic 500", async () => {
    clearBreakdownCore.mockResolvedValue({ ok: false, error: "sb.err.REASON_REQUIRED" });
    expect((await clear.POST(post("/api/v1/sales-breakdown/clear", body()))).status).toBe(200);
    clearBreakdownCore.mockRejectedValue(new Error("boom"));
    expect((await clear.POST(post("/api/v1/sales-breakdown/clear", body()))).status).toBe(500);
  });
});

describe("GET /api/v1/sales-breakdown/history", () => {
  it("401 without a token; 403 for another shop; any member may read", async () => {
    const q = `shop=${OWNER}&variant=${V}&date=${DATE}`;
    expect((await history.GET(get(`/api/v1/sales-breakdown/history?${q}`, null))).status).toBe(401);
    expect((await history.GET(get(`/api/v1/sales-breakdown/history?shop=${OTHER}&variant=${V}&date=${DATE}`))).status).toBe(403);
    expect((await history.GET(get(`/api/v1/sales-breakdown/history?shop=${VIEWER}&variant=${V}&date=${DATE}`))).status).toBe(200);
    expect(await (await history.GET(get(`/api/v1/sales-breakdown/history?${q}`))).json()).toEqual({ ok: true, history: [] });
  });

  it("a malformed variant or date is a 400", async () => {
    expect((await history.GET(get(`/api/v1/sales-breakdown/history?shop=${OWNER}&variant=x&date=${DATE}`))).status).toBe(400);
    expect((await history.GET(get(`/api/v1/sales-breakdown/history?shop=${OWNER}&variant=${V}&date=nope`))).status).toBe(400);
    expect(loadBreakdownHistory).not.toHaveBeenCalled();
  });
});
