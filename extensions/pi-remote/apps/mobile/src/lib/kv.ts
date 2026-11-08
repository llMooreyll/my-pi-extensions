import * as SecureStore from "expo-secure-store";

/**
 * SecureStore accepts only [A-Za-z0-9._-] in keys and throws otherwise; callers build keys like "draft:<id>",
 * so map every other character to "_". Keys that were already valid stay unchanged.
 */
const safe = (k: string) => k.replace(/[^\w.-]/g, "_");

/** Small key/value store for credentials and preferences (Android Keystore-backed). */
export const kv = {
  get: (k: string) => SecureStore.getItemAsync(safe(k)),
  set: (k: string, v: string) => SecureStore.setItemAsync(safe(k), v),
  del: (k: string) => SecureStore.deleteItemAsync(safe(k)),
};
