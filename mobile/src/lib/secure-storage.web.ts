import type { RawStorage } from "./secure-chunks";

/**
 * Browser build of the phone app (used only to test the app in a browser). A browser has no Keychain/Keystore, so this is plain
 * localStorage and is NOT a secure store. The real iPhone and Android apps use `secure-storage.ts`.
 */
export const secureStorage: RawStorage = {
  getItem: async (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  setItem: async (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  removeItem: async (k) => { try { localStorage.removeItem(k); } catch { /* storage blocked */ } },
};
