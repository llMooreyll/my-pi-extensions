// Registry of file transfers in both directions (plan 7.7.4).
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";
import type { OfferFilesArgs, TransferDir, TransferErrorCode, TransferInfo, TransferState } from "../../protocol/src/index.ts";
import { audit } from "./audit.ts";
import { loadDevices } from "./devices.ts";
import { err } from "./errors.ts";
import { readJson, writeJsonAtomic } from "./fsutil.ts";
import { log } from "./log.ts";
import { CONFIG_DIR, STATE_DIR } from "./paths.ts";
import { runtime } from "./runtime.ts";
import { zipFolder } from "./zip-store.ts";

const FILE = join(STATE_DIR, "transfers.json");
export const OUTBOX_DIR = join(STATE_DIR, "outbox");
const KEEP_FINISHED_MS = 30 * 86_400_000;
const FREE_SPACE_MARGIN = 512 * 1024 * 1024;
const MAX_NAME_BYTES = 180;

/** What hostd keeps; only the TransferInfo part goes to clients. */
interface Rec extends TransferInfo {
  /** to_phone: file actually streamed (the source file, or the zip in outbox). */
  source?: string;
  /** to_phone, plain files: stat at offer time, compared before streaming. */
  srcSize?: number;
  srcMtime?: number;
  zip?: boolean;
  /** to_computer: the .part being written. */
  part?: string;
  deviceId?: string;
}

const recs = new Map<string, Rec>();
let changeListener: (info: TransferInfo, progressOnly: boolean) => void = () => {};
let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const expandHome = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
export const inboxDir = () => resolve(expandHome(runtime.config.files.inboxDir));
const partialDir = () => join(inboxDir(), ".partial");

export function pub(r: Rec): TransferInfo {
  const { source: _s, srcSize: _a, srcMtime: _b, zip: _z, part: _p, deviceId: _d, ...info } = r;
  return info;
}

export function onTransferChange(fn: (info: TransferInfo, progressOnly: boolean) => void): void { changeListener = fn; }

function persistSoon(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = undefined; persistNow(); }, 1500);
}
function persistNow(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  try { writeJsonAtomic(FILE, { v: 1, transfers: [...recs.values()] }); } catch (e) { log.warn("transfers save failed", e); }
}

function changed(r: Rec, progressOnly = false): void {
  r.updatedAt = Date.now();
  if (progressOnly) persistSoon(); else persistNow();
  changeListener(pub(r), progressOnly);
}

export function loadTransfers(): void {
  const raw = readJson<{ transfers?: Rec[] }>(FILE);
  for (const r of raw?.transfers ?? []) {
    if (!r || typeof r.id !== "string") continue;
    if (r.state === "active") r.state = "waiting";
    recs.set(r.id, r);
  }
  sweep();
}

export function startTransferSweeper(): ReturnType<typeof setInterval> {
  const t = setInterval(() => { try { sweep(); } catch (e) { log.warn("transfer sweep", e); } }, 3_600_000);
  t.unref();
  return t;
}

/** Expire stale offers and partial uploads; forget long-finished records. */
export function sweep(now = Date.now()): void {
  let dirty = false;
  for (const r of [...recs.values()]) {
    const open = r.state === "waiting" || r.state === "active" || (r.dir === "to_phone" && r.state === "done");
    if (open && r.expiresAt !== undefined && r.expiresAt <= now) {
      dropFiles(r);
      r.state = "expired";
      r.error = { code: "expired", message: "Expired" };
      r.updatedAt = now;
      changeListener(pub(r), false);
      dirty = true;
      continue;
    }
    const finished = r.state !== "waiting" && r.state !== "active" && !(r.dir === "to_phone" && r.state === "done");
    if (finished && now - r.updatedAt > KEEP_FINISHED_MS) { recs.delete(r.id); dirty = true; }
  }
  if (dirty) persistNow();
}

/** Remove what hostd itself created for a record: the outbox zip or the .part. Never the user's files. */
function dropFiles(r: Rec): void {
  try {
    if (r.zip && r.source) rmSync(r.source, { force: true });
    if (r.part) rmSync(r.part, { force: true });
  } catch (e) { log.warn("transfer cleanup", r.id, e); }
}

export function listTransfers(): TransferInfo[] {
  return [...recs.values()].sort((a, b) => b.createdAt - a.createdAt).map(pub);
}

export function getRec(id: string): Rec | undefined { return recs.get(id); }

const newId = () => randomBytes(16).toString("base64url");

// ---------------------------------------------------------------- offers (computer → phone)

function denyRoots(): string[] {
  const roots = [CONFIG_DIR, STATE_DIR, join(homedir(), ".ssh"), join(homedir(), ".gnupg"), join(homedir(), ".pi", "agent", "auth.json"),
    ...runtime.config.files.denyPaths.map(expandHome)];
  const out = new Set<string>();
  for (const r of roots) {
    const abs = resolve(r);
    out.add(abs);
    try { out.add(realpathSync(abs)); } catch { /* may not exist */ }
  }
  return [...out];
}

const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

function resolveOffered(cwd: string, p: string): string {
  const abs = resolve(cwd, expandHome(p.trim()));
  let real: string;
  try { real = realpathSync(abs); } catch { throw err("missing", `No such file: ${p}`); }
  for (const root of denyRoots()) if (under(real, root) || under(abs, root)) throw err("file_denied", `Not allowed to send ${p}`);
  return real;
}

/** Called by the bridge tool send_to_phone. All-or-nothing: on any failure nothing stays registered. */
export async function offerFiles(a: OfferFilesArgs): Promise<TransferInfo[]> {
  if (!loadDevices().length) throw err("no_device", "No phone is paired with this computer");
  if (!Array.isArray(a.paths) || !a.paths.length || a.paths.length > 20) throw err("bad_request", "paths must hold 1 to 20 items");
  if (typeof a.cwd !== "string" || !isAbsolute(a.cwd)) throw err("bad_request", "cwd must be absolute");
  const max = runtime.config.files.maxFileBytes;
  const now = Date.now();
  const expiresAt = now + runtime.config.files.offerTtlHours * 3_600_000;
  const made: Rec[] = [];
  try {
    for (const p of a.paths) {
      if (typeof p !== "string" || !p.trim()) throw err("bad_request", "empty path");
      const real = resolveOffered(a.cwd, p);
      const st = statSync(real);
      const id = newId();
      const base: Rec = {
        id, dir: "to_phone", name: basename(real), size: 0, state: "waiting", bytesDone: 0, computerPath: real,
        processId: a.processId, ...(a.sessionId ? { sessionId: a.sessionId } : {}), ...(a.note ? { note: a.note.slice(0, 500) } : {}),
        createdAt: now, updatedAt: now, expiresAt,
      };
      if (st.isFile()) {
        if (st.size > max) throw err("file_too_large", `${p} is larger than the limit of ${max} bytes`);
        made.push({ ...base, size: st.size, mime: mimeOf(real), source: real, srcSize: st.size, srcMtime: st.mtimeMs });
      } else if (st.isDirectory()) {
        mkdirSync(OUTBOX_DIR, { recursive: true, mode: 0o700 });
        const zipPath = join(OUTBOX_DIR, `${id}.zip`);
        const rec: Rec = { ...base, name: `${basename(real)}.zip`, mime: "application/zip", source: zipPath, zip: true };
        made.push(rec);
        try {
          rec.size = await zipFolder(real, zipPath, max);
        } catch (e) {
          if ((e as Error).message === "too_large") throw err("file_too_large", `${p} is larger than the limit of ${max} bytes`);
          throw e;
        }
      } else {
        throw err("file_denied", `${p} is not a regular file or folder`);
      }
    }
  } catch (e) {
    for (const r of made) dropFiles(r);
    throw e;
  }
  for (const r of made) recs.set(r.id, r);
  persistNow();
  for (const r of made) changeListener(pub(r), false);
  audit({ op: "offer_files", processId: a.processId, summary: made.map((r) => `${r.name} (${r.size})`).join(", ").slice(0, 300) });
  return made.map(pub);
}

/** Resolve what a get-lane should stream, or explain why it cannot. */
export function sourceFor(r: Rec): { path: string; size: number } | { code: TransferErrorCode; message: string } {
  if (r.dir !== "to_phone") return { code: "denied", message: "Not a download" };
  if (r.state === "cancelled") return { code: "cancelled", message: "Cancelled on the computer" };
  if (r.state === "expired" || (r.expiresAt !== undefined && r.expiresAt <= Date.now())) return { code: "expired", message: "Expired" };
  if (!r.source) return { code: "missing", message: "No source" };
  let st;
  try { st = statSync(r.source); } catch { return { code: "missing", message: "The file is gone from the computer" }; }
  if (!r.zip && (st.size !== r.srcSize || st.mtimeMs !== r.srcMtime)) return { code: "changed", message: "The file changed on the computer since it was offered" };
  if (st.size !== r.size) return { code: "changed", message: "The file changed on the computer since it was offered" };
  return { path: r.source, size: r.size };
}

// ---------------------------------------------------------------- uploads (phone → computer)

export function cleanName(name: string): string {
  let n = String(name ?? "").replace(/[\/\\\u0000-\u001f\u007f]/g, "_").trim();
  n = n.replace(/^\.+/, (m) => "_".repeat(m.length));
  const enc = new TextEncoder();
  if (enc.encode(n).length > MAX_NAME_BYTES) {
    const ext = extname(n).slice(0, 16);
    let stem = n.slice(0, n.length - ext.length);
    while (stem && enc.encode(stem + ext).length > MAX_NAME_BYTES) stem = stem.slice(0, -1);
    n = stem + ext;
  }
  return n || "file";
}

/** "name.ext", "name (2).ext", ... — first name not taken in dir. */
export function uniqueName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length) || name;
  for (let i = 2; i < 10_000; i++) {
    const n = `${stem} (${i})${ext}`;
    if (!existsSync(join(dir, n))) return n;
  }
  return `${stem} (${Date.now()})${ext}`;
}

export function uploadBegin(a: { name: string; size: number; mime?: string; processId?: string }, deviceId?: string): TransferInfo {
  const max = runtime.config.files.maxFileBytes;
  if (!Number.isSafeInteger(a.size) || a.size < 0) throw err("bad_request", "size must be a non-negative integer");
  if (a.size > max) throw err("file_too_large", `The computer accepts files up to ${max} bytes`);
  const dir = inboxDir();
  // The inbox is an ordinary folder in Downloads; only the .partial staging folder is private.
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  mkdirSync(join(dir, ".partial"), { recursive: true, mode: 0o700 });
  const fs = statfsSync(dir);
  if (fs.bavail * fs.bsize < a.size + FREE_SPACE_MARGIN) throw err("no_space", "Not enough free disk space on the computer");
  const now = Date.now();
  const id = newId();
  const part = join(partialDir(), `${id}.part`);
  writeFileSync(part, "", { mode: 0o600 });
  const r: Rec = {
    id, dir: "to_computer", name: cleanName(a.name), size: a.size, ...(a.mime ? { mime: a.mime.slice(0, 120) } : {}),
    state: "waiting", bytesDone: 0, ...(a.processId ? { processId: a.processId } : {}),
    createdAt: now, updatedAt: now, expiresAt: now + runtime.config.files.offerTtlHours * 3_600_000, part, ...(deviceId ? { deviceId } : {}),
  };
  recs.set(id, r);
  changed(r);
  audit({ op: "upload_begin", deviceId, processId: a.processId, summary: `${r.name} (${r.size})` });
  return pub(r);
}

/** Move a complete .part into the inbox under a free name. */
export function finishUpload(r: Rec): void {
  const dir = inboxDir();
  const name = uniqueName(dir, r.name);
  const dest = join(dir, name);
  renameSync(r.part!, dest);
  try { chmodSync(dest, 0o644); } catch { /* keep 0600 */ }
  r.part = undefined;
  r.computerPath = dest;
  r.bytesDone = r.size;
  r.state = "done";
  r.expiresAt = undefined;
  r.error = undefined;
  changed(r);
  audit({ op: "upload_done", deviceId: r.deviceId, processId: r.processId, summary: `${dest} (${r.size})` });
}

// ---------------------------------------------------------------- state changes

export function setState(r: Rec, state: TransferState, error?: { code: TransferErrorCode; message: string }): void {
  if (r.state === state && !error) return;
  r.state = state;
  if (error) r.error = error; else if (state !== "failed") r.error = undefined;
  changed(r);
}

export function setProgress(r: Rec, bytes: number): void {
  r.bytesDone = bytes;
  changed(r, true);
}

export function markDownloaded(r: Rec, deviceId?: string): void {
  r.bytesDone = r.size;
  setState(r, "done");
  audit({ op: "download_done", deviceId, processId: r.processId, summary: `${r.computerPath ?? r.name} (${r.size})` });
}

export function cancelTransfer(id: string, deviceId?: string): void {
  const r = recs.get(id);
  if (!r) throw err("not_found", "No such transfer");
  if (r.dir === "to_computer" && r.state === "done") throw err("bad_request", "Already saved on the computer");
  dropFiles(r);
  r.part = undefined;
  r.error = { code: "cancelled", message: "Cancelled" };
  setState(r, "cancelled", r.error);
  audit({ op: "transfer_cancel", deviceId, summary: `${r.dir} ${r.name}` });
}

export function forgetTransfer(id: string): void {
  const r = recs.get(id);
  if (!r) return;
  if (r.state === "waiting" || r.state === "active") dropFiles(r);
  else if (r.zip) dropFiles(r);
  recs.delete(id);
  persistNow();
}

export type { Rec as TransferRec, TransferDir };

const MIME: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".log": "text/plain", ".csv": "text/csv", ".json": "application/json",
  ".html": "text/html", ".xml": "application/xml", ".pdf": "application/pdf", ".zip": "application/zip",
  ".gz": "application/gzip", ".tar": "application/x-tar", ".7z": "application/x-7z-compressed",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".apk": "application/vnd.android.package-archive",
};
export const mimeOf = (p: string) => MIME[extname(p).toLowerCase()] ?? "application/octet-stream";
