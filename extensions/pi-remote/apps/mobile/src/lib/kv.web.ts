/** Web build (design preview / desktop browser): localStorage instead of the Keystore. */
export const kv = {
  get: async (k: string) => globalThis.localStorage?.getItem(k) ?? null,
  set: async (k: string, v: string) => { globalThis.localStorage?.setItem(k, v); },
  del: async (k: string) => { globalThis.localStorage?.removeItem(k); },
};
