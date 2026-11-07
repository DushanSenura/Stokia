// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ApiForbidden, ApiSignedOut, ApiUnreachable, createApi } from "../../mobile/src/lib/api-client";
import { CHUNK_SIZE, createChunkedStorage, type RawStorage } from "../../mobile/src/lib/secure-chunks";

function memoryRaw() {
  const map = new Map<string, string>();
  const calls: string[] = [];
  const raw: RawStorage = {
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => { calls.push(`set ${k}`); map.set(k, v); },
    removeItem: async (k) => { calls.push(`del ${k}`); map.delete(k); },
  };
  return { raw, map, calls };
}

describe("secure session storage (chunked)", () => {
  const session = JSON.stringify({ access_token: "a".repeat(1500), refresh_token: "r".repeat(300), user: { id: "u", meta: "m".repeat(3000) } });

  it("stores a session larger than one SecureStore value and reads it back exactly", async () => {
    const { raw, map } = memoryRaw();
    const s = createChunkedStorage(raw);
    await s.setItem("sb-auth-token", session);
    expect(session.length).toBeGreaterThan(CHUNK_SIZE * 2);
    expect([...map.values()].every((v) => v.length <= CHUNK_SIZE)).toBe(true); // every stored value fits the platform limit
    expect(await s.getItem("sb-auth-token")).toBe(session);
  });

  it("uses only characters SecureStore allows in a key", async () => {
    const { raw, map } = memoryRaw();
    await createChunkedStorage(raw).setItem("sb-127-auth-token", session);
    expect([...map.keys()].every((k) => /^[A-Za-z0-9._-]+$/.test(k))).toBe(true);
  });

  it("a shorter value later leaves no stale chunks behind", async () => {
    const { raw, map } = memoryRaw();
    const s = createChunkedStorage(raw);
    await s.setItem("k", session);
    await s.setItem("k", "short");
    expect(await s.getItem("k")).toBe("short");
    expect([...map.keys()].sort()).toEqual(["k.0", "k.count"]);
  });

  it("remove deletes every chunk, and the value reads as absent", async () => {
    const { raw, map } = memoryRaw();
    const s = createChunkedStorage(raw);
    await s.setItem("k", session);
    await s.removeItem("k");
    expect(map.size).toBe(0);
    expect(await s.getItem("k")).toBeNull();
  });

  it("FAILS CLOSED: a missing chunk or a corrupt count reads as signed out, never as a truncated token", async () => {
    const { raw, map } = memoryRaw();
    const s = createChunkedStorage(raw);
    await s.setItem("k", session);
    map.delete("k.1");
    expect(await s.getItem("k")).toBeNull();
    map.set("k.count", "banana");
    expect(await s.getItem("k")).toBeNull();
  });

  it("writes the count LAST (a reader never sees a count pointing at chunks that do not exist yet) and removes it FIRST", async () => {
    const w = memoryRaw();
    await createChunkedStorage(w.raw).setItem("k", session);
    expect(w.calls[w.calls.length - 1]).toBe("set k.count");
    const r = memoryRaw();
    const s = createChunkedStorage(r.raw);
    await s.setItem("k", session);
    r.calls.length = 0;
    await s.removeItem("k");
    expect(r.calls[0]).toBe("del k.count");
  });

  it("handles an empty value", async () => {
    const { raw } = memoryRaw();
    const s = createChunkedStorage(raw);
    await s.setItem("k", "");
    expect(await s.getItem("k")).toBe("");
  });
});

function api(handler: (url: string, init: RequestInit) => Promise<Response> | Response, over: { token?: string | null; refreshed?: string | null; timeoutMs?: number } = {}) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {}));
  const getToken = vi.fn(async () => (over.token === undefined ? "token-1" : over.token));
  const refresh = vi.fn(async () => (over.refreshed === undefined ? "token-2" : over.refreshed));
  return { fetchMock, getToken, refresh, client: createApi({ baseUrl: "https://stokia.example/", getToken, refresh, fetch: fetchMock as unknown as typeof fetch, timeoutMs: over.timeoutMs }) };
}
const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const count = { businessDate: "2026-11-07", revision: null, items: [] };

describe("API client: reading", () => {
  it("sends the bearer token, JSON headers and a clean URL (trailing slash tolerated, parameters encoded)", async () => {
    const t = api(() => reply(200, { ok: true, memberships: [] }));
    await t.client.me();
    await t.client.morningStock("shop id", "2026-11-07");
    expect(t.fetchMock.mock.calls[0][0]).toBe("https://stokia.example/api/v1/me");
    expect(t.fetchMock.mock.calls[1][0]).toBe("https://stokia.example/api/v1/morning-stock?shop=shop%20id&date=2026-11-07");
    const init = t.fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Bearer token-1");
  });

  it("an expired token is refreshed ONCE and the request retried with the new one", async () => {
    let n = 0;
    const t = api((_u, init) => (n++ === 0 ? reply(401, { ok: false }) : (expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-2"), reply(200, { ok: true }))));
    await t.client.me();
    expect(t.refresh).toHaveBeenCalledTimes(1);
    expect(t.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still 401 after a refresh, or no token at all, means signed out (and no request is sent without a token)", async () => {
    await expect(api(() => reply(401, {})).client.me()).rejects.toBeInstanceOf(ApiSignedOut);
    const none = api(() => reply(200, { ok: true }), { token: null });
    await expect(none.client.me()).rejects.toBeInstanceOf(ApiSignedOut);
    expect(none.fetchMock).not.toHaveBeenCalled();
    await expect(api(() => reply(401, {}), { refreshed: null }).client.me()).rejects.toBeInstanceOf(ApiSignedOut);
  });

  it("no network, a timeout, or a server error is 'unreachable', so screens fall back to what is saved on the phone", async () => {
    await expect(api(() => { throw new TypeError("Network request failed"); }).client.me()).rejects.toBeInstanceOf(ApiUnreachable);
    await expect(api(() => reply(503, { ok: false })).client.me()).rejects.toBeInstanceOf(ApiUnreachable);
    const hang = api((_u, init) => new Promise<Response>((_res, rej) => { (init.signal as AbortSignal).addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))); }), { timeoutMs: 15 });
    await expect(hang.client.me()).rejects.toBeInstanceOf(ApiUnreachable);
  });

  it("a shop the person is not part of is 'forbidden', not 'unreachable'", async () => {
    await expect(api(() => reply(403, { ok: false, error: "forbidden" })).client.home("x")).rejects.toBeInstanceOf(ApiForbidden);
  });

  it("an unexpected body is not trusted", async () => {
    await expect(api(() => reply(200, { nope: true })).client.me()).rejects.toBeInstanceOf(ApiUnreachable);
    await expect(api(() => new Response("<html>", { status: 200 })).client.me()).rejects.toBeInstanceOf(ApiUnreachable);
  });
});

describe("API client: submitting a count (the contract the offline queue relies on)", () => {
  const call = (client: ReturnType<typeof api>["client"]) => client.submitCount({ shopId: "s", count, ackMissing: true, key: "key-0123456789", device: "Pixel 7" });

  it("sends the shop, count, acknowledgement, idempotency key and device name", async () => {
    const t = api((_u, init) => (expect(JSON.parse(String(init.body))).toEqual({ shopId: "s", count, ackMissing: true, idempotencyKey: "key-0123456789", device: "Pixel 7" }), reply(200, { ok: true, sessionId: "s1", revision: 2, counted: 1, confirmed: true })));
    expect(await call(t.client)).toMatchObject({ ok: true, sessionId: "s1" });
  });

  it("an ANSWER is returned, including a conflict (which is not an error)", async () => {
    const conflict = { ok: false, error: "ms.conflictConfirmed", conflict: true, conflictInfo: { reason: "already_confirmed", server: null } };
    expect(await call(api(() => reply(200, conflict)).client)).toEqual(conflict);
  });

  it("a refusal is returned as an answer the person can read", async () => {
    expect(await call(api(() => reply(403, { ok: false })).client)).toEqual({ ok: false, error: "error.forbidden" });
    expect(await call(api(() => reply(400, { ok: false })).client)).toEqual({ ok: false, error: "ms.err.INVALID_PAYLOAD" });
  });

  it("NO ANSWER is thrown, never turned into a refusal: that is what keeps the count queued under the same key", async () => {
    await expect(call(api(() => { throw new TypeError("Network request failed"); }).client)).rejects.toBeInstanceOf(ApiUnreachable);
    await expect(call(api(() => reply(500, { ok: false, error: "submit_failed" })).client)).rejects.toBeInstanceOf(ApiUnreachable);
    await expect(call(api(() => reply(502)).client)).rejects.toBeInstanceOf(ApiUnreachable);
  });

  it("an expired session also stays queued (thrown, not failed) so the count survives until the person signs in again", async () => {
    await expect(call(api(() => reply(401, {}), { refreshed: null }).client)).rejects.toBeInstanceOf(ApiSignedOut);
  });
});
