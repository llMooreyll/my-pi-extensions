import * as SecureStore from "expo-secure-store";

/** Small key/value store for credentials and preferences (Android Keystore-backed). */
export const kv = {
  get: (k: string) => SecureStore.getItemAsync(k),
  set: (k: string, v: string) => SecureStore.setItemAsync(k, v),
  del: (k: string) => SecureStore.deleteItemAsync(k),
};
