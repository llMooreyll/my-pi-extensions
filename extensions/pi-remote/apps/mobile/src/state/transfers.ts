// File transfers on the phone (plan 7.7.5): list from hostd, lanes queued two at a time, retries, local files.
import { AppState, Platform } from "react-native";
import * as Sharing from "expo-sharing";
import { Directory, File, FileMode } from "expo-file-system";
import { create } from "zustand";
import { FEATURE_FILES, MAX_LANES_PER_DEVICE, formatBytes, type TransferInfo } from "@pi-remote/protocol";
import { loadPrefs } from "../lib/credentials";
import { kv } from "../lib/kv";
import { testLog } from "../lib/test-hooks";
import { call, connection, errText } from "../net/connection";
import { download, isFinal, receivedDir, receivedFile, upload, type LaneError, type LaneJob } from "../net/lane";
import { useStore } from "./store";

export interface Progress { bytes: number; running: boolean; queued?: boolean; error?: string; final?: boolean }

interface TransfersState {
  items: Record<string, TransferInfo>;
  progress: Record<string, Progress>;
  /** Downloads whose finished file is on the phone. */
  local: Record<string, true>;
  inboxDir?: string;
  loaded: boolean;
}

export const useTransfers = create<TransfersState>(() => ({ items: {}, progress: {}, local: {}, loaded: false }));
const set = useTransfers.setState;
const get = useTransfers.getState;

/** File features need hostd support and the native file system (not the web preview). */
export function filesSupported(): boolean {
  return Platform.OS === "android" && (useStore.getState().features ?? []).includes(FEATURE_FILES);
}

interface Job { id: string; kind: "get" | "put"; src?: File; attempts: number; lane?: LaneJob; timer?: ReturnType<typeof setTimeout>; cancelled?: boolean }
const jobs = new Map<string, Job>();
const RETRY_MS = [2000, 5000, 15000];
let listeners: { notify?: (title: string, body: string) => void; changed?: (force?: boolean) => void } = {};

export function setTransferHooks(h: typeof listeners): void { listeners = h; }

function setProgress(id: string, patch: Partial<Progress>): void {
  const prev = get().progress[id] ?? { bytes: 0, running: false };
  set({ progress: { ...get().progress, [id]: { ...prev, ...patch } } });
}

function scanLocal(items: Record<string, TransferInfo>): Record<string, true> {
  const local: Record<string, true> = {};
  for (const t of Object.values(items)) {
    if (t.dir !== "to_phone") continue;
    try { if (receivedFile(t).exists) local[t.id] = true; } catch { /* bad name */ }
  }
  return local;
}

function partBytes(t: TransferInfo): number {
  try { const f = new File(receivedDir(), t.id, `${t.name}.part`); return f.exists ? f.size : 0; } catch { return 0; }
}

// ------------------------------------------------------------------ list sync

async function refresh(): Promise<void> {
  if (!filesSupported()) return;
  try {
    const r = await call("list_transfers", {});
    const items: Record<string, TransferInfo> = {};
    for (const t of r.transfers) items[t.id] = t;
    const progress = { ...get().progress };
    for (const t of r.transfers) if (t.dir === "to_phone" && !progress[t.id]) { const b = partBytes(t); if (b) progress[t.id] = { bytes: b, running: false }; }
    set({ items, inboxDir: r.inboxDir, local: scanLocal(items), progress, loaded: true });
    pump();
  } catch (e) { testLog("transfers", { error: errText(e) }); }
}

async function onPush(info: TransferInfo): Promise<void> {
  const prev = get().items[info.id];
  set({ items: { ...get().items, [info.id]: info } });
  if (prev || info.dir !== "to_phone" || info.state !== "waiting") return;
  testLog("transfer_new", { id: info.id, name: info.name, size: info.size });
  if (AppState.currentState !== "active") listeners.notify?.("pi sent you a file", `${info.name} · ${formatBytes(info.size)}`);
  const prefs = await loadPrefs();
  if (prefs.autoDownloadMB > 0 && info.size <= prefs.autoDownloadMB * 1024 * 1024) startDownload(info.id);
}

export function installTransfers(): void {
  connection.onReady(() => { void refresh(); });
  connection.onTransfer((info) => { void onPush(info); });
  AppState.addEventListener("change", (s) => { if (s === "active" && get().loaded) set({ local: scanLocal(get().items) }); });
}

// ------------------------------------------------------------------ queue

function running(): number { let n = 0; for (const j of jobs.values()) if (j.lane) n++; return n; }

function pump(): void {
  if (useStore.getState().conn !== "ready") return;
  for (const j of jobs.values()) {
    if (running() >= MAX_LANES_PER_DEVICE) return;
    if (j.lane || j.timer) continue;
    run(j);
  }
}

function run(j: Job): void {
  const t = get().items[j.id];
  if (!t) { jobs.delete(j.id); return; }
  setProgress(j.id, { running: true, queued: false, error: undefined, final: false });
  const onBytes = (bytes: number) => { setProgress(j.id, { bytes }); listeners.changed?.(); };
  j.lane = j.kind === "get" ? download(t, onBytes) : upload(t, j.src!, onBytes);
  testLog("lane_start", { id: j.id, lane: j.kind });
  j.lane.done.then(
    () => {
      jobs.delete(j.id);
      setProgress(j.id, { running: false, bytes: t.size });
      if (j.kind === "get") {
        set({ local: { ...get().local, [j.id]: true } });
        if (AppState.currentState !== "active") listeners.notify?.("File received", t.name);
      }
      testLog("lane_done", { id: j.id, lane: j.kind });
      listeners.changed?.(true);
      pump();
    },
    (e: LaneError) => {
      j.lane = undefined;
      // A cancelled job is already out of the queue; whatever error its closing lane reports is not news.
      if (j.cancelled || jobs.get(j.id) !== j) { listeners.changed?.(true); pump(); return; }
      const final = isFinal(e) || j.attempts >= RETRY_MS.length;
      testLog("lane_error", { id: j.id, code: e.code, message: e.message, attempt: j.attempts });
      setProgress(j.id, { running: false, error: e.message, final });
      if (final || e.code === "cancelled") { jobs.delete(j.id); listeners.changed?.(true); pump(); return; }
      const wait = RETRY_MS[j.attempts++]!;
      setProgress(j.id, { queued: true });
      j.timer = setTimeout(() => { j.timer = undefined; pump(); }, wait);
      listeners.changed?.(true);
      pump();
    },
  );
}

function enqueue(j: Job): void {
  if (jobs.has(j.id)) return;
  jobs.set(j.id, j);
  setProgress(j.id, { queued: true, error: undefined, final: false });
  pump();
}

/** Start or resume a download to the phone. */
export function startDownload(id: string): void { enqueue({ id, kind: "get", attempts: 0 }); }

/** Register each file on the computer, then upload it. Returns the transfers in order. */
export async function uploadFiles(files: File[], processId?: string): Promise<TransferInfo[]> {
  const out: TransferInfo[] = [];
  for (const f of files) {
    const r = await call("upload_begin", { name: f.name || "file", size: f.size, ...(f.type ? { mime: f.type } : {}), ...(processId ? { processId } : {}) });
    set({ items: { ...get().items, [r.transfer.id]: r.transfer } });
    out.push(r.transfer);
    enqueue({ id: r.transfer.id, kind: "put", src: f, attempts: 0 });
  }
  return out;
}

/** Retry after a final error, or re-run an interrupted upload when the source is still known. */
export function retry(id: string): boolean {
  const t = get().items[id];
  if (!t) return false;
  if (t.dir === "to_phone") { startDownload(id); return true; }
  return false;
}

/** Stop the lane; for uploads and offers also cancel on the computer. */
export async function cancel(id: string): Promise<void> {
  const j = jobs.get(id);
  if (j) { j.cancelled = true; clearTimeout(j.timer); jobs.delete(id); j.lane?.cancel(); }
  setProgress(id, { running: false, queued: false, error: undefined, final: false });
  listeners.changed?.(true);
  const t = get().items[id];
  if (t && t.dir === "to_computer" && t.state !== "done") await call("transfer_cancel", { id }).catch(() => {});
}

/** Remove from the list (and the phone's copy of a download). */
export async function forget(id: string): Promise<void> {
  await cancel(id);
  removeLocal(id);
  await call("transfer_forget", { id }).catch(() => {});
  const items = { ...get().items };
  delete items[id];
  set({ items });
}

export function removeLocal(id: string): void {
  try { const d = new Directory(receivedDir(), id); if (d.exists) d.delete(); } catch { /* gone */ }
  const local = { ...get().local };
  delete local[id];
  const progress = { ...get().progress };
  delete progress[id];
  set({ local, progress });
}

// ------------------------------------------------------------------ using received files

export async function openLocal(id: string): Promise<string | undefined> {
  const t = get().items[id];
  if (!t) return "Unknown file";
  const f = receivedFile(t);
  try {
    if (!(await f.canPreview())) return "No app on this phone can open this file. Use Share instead.";
    await f.preview(t.mime ? { mimeType: t.mime } : undefined);
    return undefined;
  } catch (e) { return (e as Error)?.message ?? String(e); }
}

export async function shareLocal(id: string): Promise<string | undefined> {
  const t = get().items[id];
  if (!t) return "Unknown file";
  try {
    if (!(await Sharing.isAvailableAsync())) return "Sharing is not available";
    await Sharing.shareAsync(receivedFile(t).uri, { ...(t.mime ? { mimeType: t.mime } : {}), dialogTitle: t.name });
    return undefined;
  } catch (e) { return (e as Error)?.message ?? String(e); }
}

const SAVE_DIR_KEY = "files.saveDir";

/** Copy into a folder the user picked once (Storage Access Framework), in chunks. Asks again if that folder went away. */
export async function saveToFolder(id: string): Promise<string> {
  try { return await saveToFolderOnce(id, false); }
  catch (e) {
    if (!(await hasSaveFolder())) throw e;
    await forgetSaveFolder();
    return saveToFolderOnce(id, true);
  }
}

async function saveToFolderOnce(id: string, pickAgain: boolean): Promise<string> {
  const t = get().items[id];
  if (!t) throw new Error("Unknown file");
  const uri = pickAgain ? null : await kv.get(SAVE_DIR_KEY);
  let dir: Directory;
  if (uri) dir = new Directory(uri);
  else { dir = await Directory.pickDirectoryAsync(); await kv.set(SAVE_DIR_KEY, dir.uri); }
  const src = receivedFile(t);
  const dot = t.name.lastIndexOf(".");
  const stem = dot > 0 ? t.name.slice(0, dot) : t.name;
  // Android appends the extension that matches a known MIME type; unknown types keep the full name.
  const known = t.mime && t.mime !== "application/octet-stream";
  const dest = dir.createFile(known ? stem : t.name, t.mime ?? "application/octet-stream");
  const r = src.open(FileMode.ReadOnly);
  const w = dest.open(FileMode.Truncate);
  try {
    for (;;) {
      const b = await r.readBytes(1024 * 1024);
      if (!b.byteLength) break;
      await w.writeBytes(b);
    }
  } finally { r.close(); w.close(); }
  return dest.name;
}

export function hasSaveFolder(): Promise<boolean> { return kv.get(SAVE_DIR_KEY).then((v) => !!v, () => false); }
export function forgetSaveFolder(): Promise<void> { return kv.del(SAVE_DIR_KEY).catch(() => {}); }

/** "Receiving report.pdf · 42%" for the foreground notification; undefined when idle. */
export function transferSummary(): string | undefined {
  const { items, progress } = get();
  const act = Object.entries(progress).filter(([, p]) => p.running);
  if (!act.length) return undefined;
  const [id, p] = act[0]!;
  const t = items[id];
  if (!t) return undefined;
  const pct = t.size ? Math.floor((p.bytes / t.size) * 100) : 100;
  const more = act.length > 1 ? ` (+${act.length - 1})` : "";
  return `${t.dir === "to_phone" ? "Receiving" : "Sending"} ${t.name} · ${pct}%${more}`;
}

export function dumpTransfers(): unknown {
  const { items, progress, local } = get();
  return Object.values(items).map((t) => ({ id: t.id, dir: t.dir, name: t.name, size: t.size, state: t.state, bytes: progress[t.id]?.bytes ?? 0, running: !!progress[t.id]?.running, error: progress[t.id]?.error ?? null, local: !!local[t.id], path: t.computerPath ?? null }));
}
