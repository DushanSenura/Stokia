import * as SecureStore from "expo-secure-store";
import { createChunkedStorage } from "./secure-chunks";

/** The signed-in session lives in the platform's secure store (iOS Keychain, Android Keystore-backed storage). */
export const secureStorage = createChunkedStorage({
  getItem: (k) => SecureStore.getItemAsync(k),
  setItem: (k, v) => SecureStore.setItemAsync(k, v),
  removeItem: (k) => SecureStore.deleteItemAsync(k),
});
