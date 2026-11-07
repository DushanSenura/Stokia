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

const recordMovementCore = vi.fn();
const reverseMovementCore = vi.fn();
const loadRecentMovements = vi.fn();
vi.mock("@/server/services/movement-submit", () => ({
  recordMovementCore: (...a: unknown[]) => recordMovementCore(...a),
  reverseMovementCore: (...a: unknown[]) => reverseMovementCore(...a),
}));
vi.mock("@/server/services/movement-list", () => ({ loadRecentMovements: (...a: unknown[]) => loadRecentMovements(...a) }));

import * as movements from "@/app/api/v1/movements/route";
import * as reverse from "@/app/api/v1/movements/reverse/route";

const OWNER = "11111111-1111-4111-8111-111111111111";
const VIEWER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const V = "00000000-0000-4000-8000-000000000001";
const MOVEMENT = "00000000-0000-4000-8000-0000000000aa";

const get = (path: string, token: string | null = "good") => new Request(`https://x.example${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const post = (path: string, body: unknown, token: string | null = "good") =>
  new Request(`https://x.example${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });

const movement = { variantId: V, type: "stock_received", unitId: "u1", quantity: "3", when: "now", reason: "Delivery" };
const record = (over: Record<string, unknown> = {}) => ({ shopId: OWNER, key: "movement-key-0001", movement, ...over });

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  for (const f of [getUser, recordMovementCore, reverseMovementCore, loadRecentMovements]) f.mockReset();
  getUser.mockImplementation(async (t: string) => (t === "good" ? { data: { user: { id: "u", email: "n@s.lk" } }, error: null } : { data: { user: null }, error: { message: "bad" } }));
  memberships.length = 0;
  memberships.push(
    { role: "owner", shops: { id: OWNER, name: "Perera Stores", timezone: "Asia/Colombo" } },
    { role: "viewer", shops: { id: VIEWER, name: "Cousin's Shop", timezone: "Asia/Colombo" } },
  );
  recordMovementCore.mockResolvedValue({ ok: true, id: "m1", duplicate: false });
  reverseMovementCore.mockResolvedValue({ ok: true, id: "r1", duplicate: false });
  loadRecentMovements.mockResolvedValue([{ id: "m1", label: "Oil" }]);
});

describe("GET /api/v1/movements", () => {
  it("401 without a valid token; 403 for another shop", async () => {
    expect((await movements.GET(get(`/api/v1/movements?shop=${OWNER}`, null))).status).toBe(401);
    expect((await movements.GET(get(`/api/v1/movements?shop=${OWNER}`, "forged"))).status).toBe(401);
    expect((await movements.GET(get(`/api/v1/movements?shop=${OTHER}`))).status).toBe(403);
  });
  it("any member may read the list (a viewer included)", async () => {
    const body = await (await movements.GET(get(`/api/v1/movements?shop=${VIEWER}`))).json();
    expect(body).toMatchObject({ ok: true, recent: [{ id: "m1" }], shop: { shopId: VIEWER, role: "viewer" } });
  });
  it("a failure is a generic 500", async () => {
    loadRecentMovements.mockRejectedValue(new Error("secret detail"));
    expect(await (await movements.GET(get(`/api/v1/movements?shop=${OWNER}`))).text()).toBe('{"ok":false,"error":"load_failed"}');
  });
});

describe("POST /api/v1/movements", () => {
  it("401 without a token", async () => {
    expect((await movements.POST(post("/api/v1/movements", record(), null))).status).toBe(401);
  });

  it("only people who may count may record: a viewer, a stranger and a malformed shop are refused before anything is recorded", async () => {
    for (const shopId of [VIEWER, OTHER, "nope", undefined]) expect((await movements.POST(post("/api/v1/movements", record({ shopId })))).status, String(shopId)).toBe(403);
    expect(recordMovementCore).not.toHaveBeenCalled();
  });

  it("an unreadable body, or no movement in it, is a 400", async () => {
    expect((await movements.POST(post("/api/v1/movements", "not json"))).status).toBe(400);
    expect((await movements.POST(post("/api/v1/movements", { shopId: OWNER, key: "movement-key-0001" }))).status).toBe(400);
    expect((await movements.POST(post("/api/v1/movements", { shopId: OWNER, key: "movement-key-0001", movement: "x" }))).status).toBe(400);
    expect(recordMovementCore).not.toHaveBeenCalled();
  });

  it("maps the phone's fields onto the web form's field names, using the shop from the verified membership and its time zone", async () => {
    const res = await movements.POST(post("/api/v1/movements", record({ movement: { ...movement, direction: "out", supplier: "Perera Traders", cost: "120.50", reference: "INV-1" } })));
    expect(await res.json()).toEqual({ ok: true, id: "m1", duplicate: false });
    const [ctx, tz, raw] = recordMovementCore.mock.calls[0];
    expect(ctx.shopId).toBe(OWNER);
    expect(tz).toBe("Asia/Colombo");
    expect(raw).toEqual({
      variant_id: V, type: "stock_received", direction: "out", unit_id: "u1", quantity: "3", when: "now", effective_local: undefined, count_date: undefined,
      reason: "Delivery", reference: "INV-1", supplier: "Perera Traders", cost: "120.50", key: "movement-key-0001",
    });
  });

  it("passes on the moment a movement saved offline was entered (a chosen time, or the morning it belongs to)", async () => {
    await movements.POST(post("/api/v1/movements", record({ movement: { ...movement, when: "custom", effectiveLocal: "2026-11-06T18:45" } })));
    expect(recordMovementCore.mock.calls[0][2]).toMatchObject({ when: "custom", effective_local: "2026-11-06T18:45" });
    await movements.POST(post("/api/v1/movements", record({ movement: { ...movement, when: "before_count", countDate: "2026-11-06" } })));
    expect(recordMovementCore.mock.calls[1][2]).toMatchObject({ when: "before_count", count_date: "2026-11-06" });
    await movements.POST(post("/api/v1/movements", record({ movement: { ...movement, when: "custom", effectiveLocal: 5, countDate: { x: 1 } } })));
    expect(recordMovementCore.mock.calls[2][2]).toMatchObject({ effective_local: undefined, count_date: undefined });
  });

  it("anything that is not a string is dropped (so the shared validation refuses it), and 'when' defaults to now", async () => {
    await movements.POST(post("/api/v1/movements", record({ key: 12345, movement: { ...movement, quantity: 3, when: undefined, reason: { $ne: "" } } })));
    const raw = recordMovementCore.mock.calls[0][2];
    expect(raw).toMatchObject({ quantity: undefined, reason: undefined, key: undefined, when: "now" });
  });

  it("a refusal (a rule, a missing reason) is a normal 200 answer carrying the messages", async () => {
    recordMovementCore.mockResolvedValue({ ok: false, fieldErrors: { reason: "mv.err.reason" } });
    const res = await movements.POST(post("/api/v1/movements", record()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, fieldErrors: { reason: "mv.err.reason" } });
  });

  it("a retry is reported as a duplicate", async () => {
    recordMovementCore.mockResolvedValue({ ok: true, id: "m1", duplicate: true });
    expect(await (await movements.POST(post("/api/v1/movements", record()))).json()).toMatchObject({ duplicate: true });
  });

  it("an unexpected failure is a generic 500 with no detail (the phone retries with the same key)", async () => {
    recordMovementCore.mockRejectedValue(new Error("password authentication failed"));
    const res = await movements.POST(post("/api/v1/movements", record()));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"ok":false,"error":"record_failed"}');
  });
});

describe("POST /api/v1/movements/reverse", () => {
  const body = (over: Record<string, unknown> = {}) => ({ shopId: OWNER, movementId: MOVEMENT, reason: "Typed too many", key: "reverse-key-0001", ...over });

  it("401 without a token; 403 for a viewer or stranger", async () => {
    expect((await reverse.POST(post("/api/v1/movements/reverse", body(), null))).status).toBe(401);
    for (const shopId of [VIEWER, OTHER]) expect((await reverse.POST(post("/api/v1/movements/reverse", body({ shopId })))).status).toBe(403);
    expect(reverseMovementCore).not.toHaveBeenCalled();
  });

  it("refuses a malformed movement id before doing anything", async () => {
    for (const movementId of ["nope", "", 42, undefined, "../etc/passwd"]) expect((await reverse.POST(post("/api/v1/movements/reverse", body({ movementId }) ))).status, String(movementId)).toBe(400);
    expect(reverseMovementCore).not.toHaveBeenCalled();
  });

  it("reverses with the reason and key, in the verified shop", async () => {
    const res = await reverse.POST(post("/api/v1/movements/reverse", body()));
    expect(await res.json()).toEqual({ ok: true, id: "r1", duplicate: false });
    expect(reverseMovementCore).toHaveBeenCalledWith(expect.objectContaining({ shopId: OWNER }), MOVEMENT, { reason: "Typed too many", key: "reverse-key-0001" });
  });

  it("a rule refusal is a 200 answer; an unexpected failure is a generic 500", async () => {
    reverseMovementCore.mockResolvedValue({ ok: false, error: "mv.err.IS_REVERSAL" });
    expect(await (await reverse.POST(post("/api/v1/movements/reverse", body()))).json()).toEqual({ ok: false, error: "mv.err.IS_REVERSAL" });
    reverseMovementCore.mockRejectedValue(new Error("boom"));
    const res = await reverse.POST(post("/api/v1/movements/reverse", body()));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"ok":false,"error":"reverse_failed"}');
  });
});
