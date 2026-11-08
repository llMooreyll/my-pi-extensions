import { kv } from "./kv";

/**
 * Unsent text per session. Kept in memory for instant restore when the screen is reopened,
 * and written to the key store (debounced) so it also survives the app being closed.
 */
const mem = new Map<string, string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const keyOf = (sessionKey: string) => `draft:${sessionKey}`;

export const drafts = {
  peek(sessionKey: string): string | undefined { return mem.get(sessionKey); },

  async load(sessionKey: string): Promise<string> {
    const hit = mem.get(sessionKey);
    if (hit !== undefined) return hit;
    let text = "";
    try { text = (await kv.get(keyOf(sessionKey))) ?? ""; } catch { /* no stored draft */ }
    if (!mem.has(sessionKey)) mem.set(sessionKey, text);
    return mem.get(sessionKey)!;
  },

  save(sessionKey: string, text: string): void {
    mem.set(sessionKey, text);
    clearTimeout(timers.get(sessionKey));
    timers.set(sessionKey, setTimeout(() => {
      timers.delete(sessionKey);
      (text ? kv.set(keyOf(sessionKey), text.slice(0, 20_000)) : kv.del(keyOf(sessionKey))).catch(() => {});
    }, 500));
  },
};

/** Uploaded attachments of an unsent message: the files are already on the computer, so keep them with the draft. */
const fileKey = (sessionKey: string) => `draftfiles:${sessionKey}`;
const fileMem = new Map<string, string[]>();
export const draftFiles = {
  async load(sessionKey: string): Promise<string[]> {
    const hit = fileMem.get(sessionKey);
    if (hit) return hit;
    let ids: string[] = [];
    try { ids = JSON.parse((await kv.get(fileKey(sessionKey))) ?? "[]"); } catch { /* none */ }
    if (!Array.isArray(ids)) ids = [];
    fileMem.set(sessionKey, ids);
    return ids;
  },
  save(sessionKey: string, ids: string[]): void {
    fileMem.set(sessionKey, ids);
    (ids.length ? kv.set(fileKey(sessionKey), JSON.stringify(ids)) : kv.del(fileKey(sessionKey))).catch(() => {});
  },
};
