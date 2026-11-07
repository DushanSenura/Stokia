/**
 * A fresh idempotency key for one submission attempt. The server stores the answer under this key, so a retry that
 * reuses it can never apply the same count twice.
 *
 * `crypto.randomUUID` only exists in secure contexts (https / localhost); a phone testing over plain http on the
 * local network would otherwise crash, hence the fallback.
 */
export function newIdempotencyKey(): string {
  const c = typeof globalThis.crypto !== "undefined" ? globalThis.crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Keeps one key per distinct request. Retrying the SAME request (same fingerprint) reuses its key; changing anything
 * produces a new key, because the server rejects one key used for two different requests.
 */
export function keyForRequest(slot: { current: { fingerprint: string; key: string } | null }, fingerprint: string): string {
  if (!slot.current || slot.current.fingerprint !== fingerprint) slot.current = { fingerprint, key: newIdempotencyKey() };
  return slot.current.key;
}
