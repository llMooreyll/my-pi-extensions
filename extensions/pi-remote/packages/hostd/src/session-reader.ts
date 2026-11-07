import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { getAgentDir, migrateSessionEntries, parseSessionEntries, type FileEntry } from "@earendil-works/pi-coding-agent";
import type { WireMessage } from "../../protocol/src/index.ts";
import { err } from "./errors.ts";
import { entryMessage } from "./sanitize.ts";

type Entry = { type: string; id?: string; parentId?: string | null; [k: string]: unknown };

/** Read-only view of a session file (7.2.16). Never writes the file. */
export function readSession(sessionFile: string, beforeEntryId?: string, limit = 200): { cwd: string; name?: string; messages: WireMessage[]; hasMoreBefore: boolean } {
  if (!isAbsolute(sessionFile) || !sessionFile.endsWith(".jsonl")) throw err("bad_request", "sessionFile must be an absolute .jsonl path");
  if (!existsSync(sessionFile)) throw err("not_found", "session file not found");
  const root = realpathSync(join(getAgentDir(), "sessions"));
  const real = realpathSync(sessionFile);
  if (!real.startsWith(root + sep)) throw err("bad_request", "sessionFile must be inside the pi sessions directory");
  let entries: FileEntry[];
  try {
    entries = parseSessionEntries(readFileSync(real, "utf8"));
    migrateSessionEntries(entries);
  } catch (e) {
    throw err("internal", `failed to parse session: ${(e as Error).message}`);
  }
  const list = entries as unknown as Entry[];
  const header = list.find((e) => e.type === "session");
  const cwd = String(header?.cwd ?? "");
  let name: string | undefined;
  for (const e of list) if (e.type === "session_info") name = (e.name as string | undefined) || undefined;
  const body = list.filter((e) => e.type !== "session" && typeof e.id === "string");
  const byId = new Map(body.map((e) => [e.id as string, e]));
  const branch: Entry[] = [];
  const seen = new Set<string>();
  let cur: Entry | undefined = body[body.length - 1];
  while (cur && !seen.has(cur.id as string)) {
    seen.add(cur.id as string);
    branch.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  branch.reverse();
  const msgs = branch.map(entryMessage).filter((m): m is WireMessage => !!m);
  let end = msgs.length;
  if (beforeEntryId) {
    end = msgs.findIndex((m) => m.entryId === beforeEntryId);
    if (end < 0) throw err("not_found", "beforeEntryId not found");
  }
  const start = Math.max(0, end - limit);
  return { cwd, ...(name ? { name } : {}), messages: msgs.slice(start, end), hasMoreBefore: start > 0 };
}
