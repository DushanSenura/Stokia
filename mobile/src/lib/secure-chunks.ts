/**
 * The sign-in session (access and refresh tokens) is larger than a single SecureStore value can hold (about 2 KB), so it is split
 * into chunks. Pure and platform-independent: the phone gives it SecureStore (Keychain / Keystore), tests give it a Map.
 *
 * Failing closed: if any chunk is missing or the write was interrupted, the stored value reads back as `null` (signed out) rather
 * than as a half-written token.
 */
export interface RawStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const CHUNK_SIZE = 1800;

export function createChunkedStorage(raw: RawStorage, chunkSize = CHUNK_SIZE): RawStorage {
  const countKey = (k: string) => `${k}.count`;
  const chunkKey = (k: string, i: number) => `${k}.${i}`;
  const readCount = async (k: string) => {
    const v = await raw.getItem(countKey(k));
    const n = v === null ? NaN : Number(v);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };

  return {
    async getItem(key) {
      const n = await readCount(key);
      if (n === null) return null;
      const parts: string[] = [];
      for (let i = 0; i < n; i++) {
        const part = await raw.getItem(chunkKey(key, i));
        if (part === null) return null; // a chunk is missing: treat as signed out, never as a truncated token
        parts.push(part);
      }
      return parts.join("");
    },

    async setItem(key, value) {
      const previous = (await readCount(key)) ?? 0;
      const chunks = value.length === 0 ? [""] : Array.from({ length: Math.ceil(value.length / chunkSize) }, (_, i) => value.slice(i * chunkSize, (i + 1) * chunkSize));
      // The count is written LAST, so a reader never sees a count that points at chunks that were not written yet.
      for (let i = 0; i < chunks.length; i++) await raw.setItem(chunkKey(key, i), chunks[i]);
      for (let i = chunks.length; i < previous; i++) await raw.removeItem(chunkKey(key, i)); // leftovers from a longer earlier value
      await raw.setItem(countKey(key), String(chunks.length));
    },

    async removeItem(key) {
      const n = (await readCount(key)) ?? 0;
      await raw.removeItem(countKey(key)); // first: from this moment the value reads as absent
      for (let i = 0; i < n; i++) await raw.removeItem(chunkKey(key, i));
    },
  };
}
