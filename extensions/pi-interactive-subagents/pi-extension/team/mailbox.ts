import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BODY_INLINE_LIMIT } from "./constants.ts";
import { randomHex } from "./fsutil.ts";
import type { ControlAction, ControlCommand, TeamMessage } from "./types.ts";

let sequence = 0;

/** Sortable unique id: millisecond time, per-process sequence, random suffix. */
export function newMessageId(): string {
  sequence = (sequence + 1) % 10000;
  return `${String(Date.now()).padStart(13, "0")}-${String(sequence).padStart(4, "0")}-${randomHex(3)}`;
}

export function ensureMaildir(dir: string): void {
  for (const sub of ["tmp", "new", "cur"]) mkdirSync(join(dir, sub), { recursive: true });
}

/** Deliver one file into a maildir: write under tmp/, then rename into new/. Throws on failure. */
function putFile(dir: string, id: string, value: unknown): void {
  ensureMaildir(dir);
  const tmp = join(dir, "tmp", `${id}.json`);
  writeFileSync(tmp, JSON.stringify(value), "utf8");
  renameSync(tmp, join(dir, "new", `${id}.json`));
}

export function writeMessage(inboxDir: string, message: TeamMessage): void {
  putFile(inboxDir, message.id, message);
}

/** Pending messages in new/, oldest first. Unreadable files are moved to bad/. */
export function listPending(inboxDir: string): TeamMessage[] {
  const newDir = join(inboxDir, "new");
  if (!existsSync(newDir)) return [];
  const result: TeamMessage[] = [];
  for (const file of readdirSync(newDir).filter((f) => f.endsWith(".json")).sort()) {
    const path = join(newDir, file);
    try {
      result.push(JSON.parse(readFileSync(path, "utf8")) as TeamMessage);
    } catch {
      mkdirSync(join(inboxDir, "bad"), { recursive: true });
      try {
        renameSync(path, join(inboxDir, "bad", file));
      } catch {}
    }
  }
  return result;
}

export function markDelivered(inboxDir: string, id: string): void {
  try {
    renameSync(join(inboxDir, "new", `${id}.json`), join(inboxDir, "cur", `${id}.json`));
  } catch {
    // Already moved, or never existed.
  }
}

/** Keep long bodies out of the context window: inline a prefix and spill the full text to a file. */
export function prepareBody(spill: string, id: string, body: string): { body: string; spillPath?: string } {
  if (body.length <= BODY_INLINE_LIMIT) return { body };
  mkdirSync(spill, { recursive: true });
  const spillPath = join(spill, `${id}.md`);
  writeFileSync(spillPath, body, "utf8");
  return { body: body.slice(0, BODY_INLINE_LIMIT), spillPath };
}

export function writeControl(controlDir: string, action: ControlAction): void {
  const id = newMessageId();
  const command: ControlCommand = { id, ts: Date.now(), action };
  putFile(controlDir, id, command);
}

/** Read and delete pending control commands, oldest first. */
export function takeControls(controlDir: string): ControlCommand[] {
  const newDir = join(controlDir, "new");
  if (!existsSync(newDir)) return [];
  const result: ControlCommand[] = [];
  for (const file of readdirSync(newDir).filter((f) => f.endsWith(".json")).sort()) {
    const path = join(newDir, file);
    try {
      result.push(JSON.parse(readFileSync(path, "utf8")) as ControlCommand);
    } catch {}
    rmSync(path, { force: true });
  }
  return result;
}

/** Ids already injected into this session, read from its custom_message entries. */
export function deliveredIdsFromEntries(entries: any[], customType: string): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry?.type !== "custom_message" || entry.customType !== customType) continue;
    for (const id of entry.details?.ids ?? []) ids.add(String(id));
  }
  return ids;
}
