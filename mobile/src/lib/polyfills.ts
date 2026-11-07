import * as Crypto from "expo-crypto";

/**
 * Idempotency keys must be unique, so they should come from a real random source. Some JavaScript engines on phones do not provide
 * `crypto.randomUUID` / `getRandomValues`; fill them in from expo-crypto when they are missing. (The shared key generator falls back
 * to Math.random otherwise, which is still unique enough, just not cryptographically strong.)
 */
try {
  const g = globalThis as unknown as { crypto?: { randomUUID?: unknown; getRandomValues?: unknown } };
  if (!g.crypto?.randomUUID || !g.crypto?.getRandomValues) {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { ...(g.crypto ?? {}), randomUUID: Crypto.randomUUID, getRandomValues: Crypto.getRandomValues },
    });
  }
} catch {
  /* keep the engine's own fallback */
}
