// File lane client (plan 7.7.5): one encrypted connection per file, paced by acknowledgements.
import { Directory, File, FileMode, Paths } from "expo-file-system";
import {
  FILE_CHUNK_BYTES, FILE_WINDOW_BYTES, PROTOCOL_VERSION,
  type HostToClient, type TransferErrorCode, type TransferInfo,
} from "@pi-remote/protocol";
import { useStore } from "../state/store";
import { candidates } from "./endpoints";
import { openSecure, type SecureConn } from "./secure-ws";

export interface LaneError { code: TransferErrorCode | "offline"; message: string }
const laneErr = (code: LaneError["code"], message: string): LaneError => ({ code, message });
/** Errors that a later retry cannot fix. */
export const isFinal = (e: LaneError) => !["offline", "io", "busy"].includes(e.code);

export const receivedDir = () => new Directory(Paths.document, "received");
export const receivedFile = (t: { id: string; name: string }) => new File(receivedDir(), t.id, t.name);
const partFile = (t: { id: string; name: string }) => new File(receivedDir(), t.id, `${t.name}.part`);

/** Same route as the main connection when possible (direct on the LAN, else relay). */
async function openLane(): Promise<SecureConn> {
  const st = useStore.getState();
  const host = st.host;
  if (!host || st.conn !== "ready") throw laneErr("offline", "Not connected to the computer");
  const all = candidates(host.endpoint);
  const ordered = [...all.filter((c) => c.via === st.via), ...all.filter((c) => c.via !== st.via)];
  let last = "";
  for (const c of ordered) {
    let conn: SecureConn | undefined;
    try {
      conn = await openSecure(c.url, host.endpoint.hostKey, c.via === "direct" ? 3000 : 10000);
      const sc = conn;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("auth timeout")), 10_000);
        sc.onText = (t) => {
          const f = JSON.parse(t) as HostToClient;
          if (f.t === "auth_ok") { clearTimeout(timer); resolve(); }
          else if (f.t === "auth_err") { clearTimeout(timer); reject(new Error(`auth failed: ${f.code}`)); }
        };
        sc.onClose = () => { clearTimeout(timer); reject(new Error("closed during auth")); };
        sc.send(JSON.stringify({ t: "auth", protocol: PROTOCOL_VERSION, deviceId: host.deviceId, secret: host.secret, purpose: "lane" }));
      });
      return sc;
    } catch (e) {
      try { conn?.close(); } catch { /* ignore */ }
      last = (e as Error)?.message ?? String(e);
    }
  }
  throw laneErr("offline", last || "No address");
}

export interface LaneJob { cancel(): void; done: Promise<void> }

/**
 * Download into received/<id>/<name>.part, resuming from its size, then rename to <name>.
 * onProgress gets bytes written so far.
 */
export function download(t: TransferInfo, onProgress: (bytes: number) => void): LaneJob {
  let conn: SecureConn | undefined;
  let cancelled = false;
  const done = (async () => {
    const dir = new Directory(receivedDir(), t.id);
    dir.create({ intermediates: true, idempotent: true });
    const part = partFile(t);
    if (!part.exists) part.create();
    let pos = part.size;
    if (pos > t.size) { part.delete(); part.create(); pos = 0; }
    const handle = part.open(FileMode.Append);
    try {
      conn = await openLane();
      if (cancelled) throw laneErr("cancelled", "Cancelled");
      const c = conn;
      await new Promise<void>((resolve, reject) => {
        let chain: Promise<void> = Promise.resolve();
        let finished = false;
        c.onText = (txt) => {
          const f = JSON.parse(txt) as HostToClient;
          if (f.t === "lane_ok") { if (f.size !== t.size) { reject(laneErr("changed", "Size changed on the computer")); c.close(); } }
          else if (f.t === "lane_err") reject(laneErr(f.code, f.message));
        };
        c.onBinary = (data) => {
          chain = chain.then(async () => {
            if (finished) return;
            await handle.writeBytes(data);
            pos += data.byteLength;
            onProgress(pos);
            c.send(JSON.stringify({ t: "ack", bytes: pos }));
            if (pos >= t.size) { finished = true; resolve(); }
          }).catch((e) => { reject(cancelled ? laneErr("cancelled", "Cancelled") : laneErr("io", (e as Error)?.message ?? "write failed")); c.close(); });
        };
        c.onClose = () => { void chain.then(() => { if (!finished) reject(cancelled ? laneErr("cancelled", "Cancelled") : laneErr("io", "Connection lost")); }); };
        c.send(JSON.stringify({ t: "lane", kind: "get", id: t.id, offset: pos }));
      });
    } finally {
      try { handle.close(); } catch { /* closed */ }
      try { conn?.close(); } catch { /* ignore */ }
    }
    const out = receivedFile(t);
    if (out.exists) out.delete();
    part.rename(t.name);
  })();
  return { cancel: () => { cancelled = true; try { conn?.send(JSON.stringify({ t: "cancel" })); conn?.close(); } catch { /* ignore */ } }, done };
}

/** Upload a picked file (often a content:// URI) to a transfer created with upload_begin. */
export function upload(t: TransferInfo, src: File, onProgress: (bytes: number) => void): LaneJob & { result: Promise<TransferInfo> } {
  let conn: SecureConn | undefined;
  let cancelled = false;
  let finalInfo: TransferInfo | undefined;
  const done = (async () => {
    const handle = src.open(FileMode.ReadOnly);
    try {
      conn = await openLane();
      if (cancelled) throw laneErr("cancelled", "Cancelled");
      const c = conn;
      await new Promise<void>((resolve, reject) => {
        let sent = 0;
        let acked = 0;
        let pumping = false;
        let failed = false;
        const fail = (e: LaneError) => { if (failed) return; failed = true; reject(cancelled ? laneErr("cancelled", "Cancelled") : e); try { c.close(); } catch { /* ignore */ } };
        const pump = async () => {
          if (pumping || failed) return;
          pumping = true;
          try {
            while (!failed && sent < t.size && sent - acked < FILE_WINDOW_BYTES) {
              const chunk = await handle.readBytes(Math.min(FILE_CHUNK_BYTES, t.size - sent));
              if (!chunk.byteLength) { fail(laneErr("changed", "The file on the phone got shorter")); return; }
              await c.sendBinary(chunk);
              sent += chunk.byteLength;
            }
          } catch (e) { fail(laneErr("io", (e as Error)?.message ?? "read failed")); }
          finally { pumping = false; }
        };
        const seek = async (offset: number) => {
          try { handle.offset = offset; if (handle.offset === offset) return; } catch { /* stream without seek */ }
          // Some providers hand out pipes: skip forward by reading.
          let left = offset;
          while (left > 0) {
            const b = await handle.readBytes(Math.min(FILE_CHUNK_BYTES, left));
            if (!b.byteLength) throw new Error("file shorter than the upload offset");
            left -= b.byteLength;
          }
        };
        c.onText = (txt) => {
          const f = JSON.parse(txt) as HostToClient;
          if (f.t === "lane_ok") {
            sent = acked = f.offset;
            onProgress(acked);
            seek(f.offset).then(() => pump(), (e) => fail(laneErr("io", (e as Error).message)));
          } else if (f.t === "ack") { acked = f.bytes; onProgress(acked); void pump(); }
          else if (f.t === "put_done") { finalInfo = f.info; resolve(); }
          else if (f.t === "lane_err") fail(laneErr(f.code, f.message));
        };
        c.onClose = () => { if (!finalInfo) fail(cancelled ? laneErr("cancelled", "Cancelled") : laneErr("io", "Connection lost")); };
        c.send(JSON.stringify({ t: "lane", kind: "put", id: t.id }));
      });
    } finally {
      try { handle.close(); } catch { /* closed */ }
      try { conn?.close(); } catch { /* ignore */ }
    }
  })();
  return {
    cancel: () => { cancelled = true; try { conn?.send(JSON.stringify({ t: "cancel" })); conn?.close(); } catch { /* ignore */ } },
    done,
    result: done.then(() => finalInfo!),
  };
}
