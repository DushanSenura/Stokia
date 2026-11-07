import { afterEach, describe, expect, it, vi } from "vitest";
import { keyForRequest, newIdempotencyKey } from "@/lib/offline/idempotency";

afterEach(() => vi.unstubAllGlobals());

describe("newIdempotencyKey", () => {
  it("returns a long-enough, unique key", () => {
    const keys = new Set(Array.from({ length: 200 }, newIdempotencyKey));
    expect(keys.size).toBe(200);
    for (const k of keys) expect(k.length).toBeGreaterThanOrEqual(8);
  });

  it("still works where crypto.randomUUID is unavailable (a phone testing over plain http)", () => {
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => a.fill(7) });
    expect(newIdempotencyKey()).toBe("07".repeat(16));
    vi.stubGlobal("crypto", undefined);
    expect(newIdempotencyKey()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("keyForRequest", () => {
  it("reuses the key for the same request and makes a new one when anything changes", () => {
    const slot = { current: null as { fingerprint: string; key: string } | null };
    const a = keyForRequest(slot, "request-1");
    expect(keyForRequest(slot, "request-1")).toBe(a); // a retry
    const b = keyForRequest(slot, "request-2"); // the numbers changed
    expect(b).not.toBe(a);
    expect(keyForRequest(slot, "request-2")).toBe(b);
  });
});
