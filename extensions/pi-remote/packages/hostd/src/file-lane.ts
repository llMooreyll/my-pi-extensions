// One file per encrypted connection, paced by the receiver's acknowledgements (plan 7.7.4, D20).
import { open, stat, type FileHandle } from "node:fs/promises";
import { FILE_CHUNK_BYTES, FILE_WINDOW_BYTES, type LaneFromClient, type LaneFromHost, type LaneOpen, type TransferErrorCode } from "../../protocol/src/index.ts";
import { log } from "./log.ts";
import type { ClientSocket } from "./secure-socket.ts";
import { finishUpload, getRec, markDownloaded, pub, setProgress, setState, sourceFor, type TransferRec } from "./transfers.ts";

export interface Lane {
  /** Text frames after LaneOpen (ack, cancel). */
  onFrame(f: LaneFromClient): void;
  onBinary(data: Uint8Array): void;
  onClose(): void;
}

const send = (sock: ClientSocket, f: LaneFromHost) => sock.send(JSON.stringify(f));
const fail = (sock: ClientSocket, code: TransferErrorCode, message: string) => { send(sock, { t: "lane_err", code, message }); sock.close(1000, code); };

/** Rate-limit progress pushes to one per second per transfer. */
function progressThrottle(r: TransferRec): (bytes: number, force?: boolean) => void {
  let last = 0;
  return (bytes, force) => {
    const now = Date.now();
    if (!force && now - last < 1000) { r.bytesDone = bytes; return; }
    last = now;
    setProgress(r, bytes);
  };
}

export async function openLane(sock: ClientSocket, open_: LaneOpen, deviceId: string | undefined): Promise<Lane | undefined> {
  const r = typeof open_.id === "string" ? getRec(open_.id) : undefined;
  if (!r) { fail(sock, "missing", "No such transfer"); return undefined; }
  if (r.state === "active") { fail(sock, "busy", "Another connection is already moving this file"); return undefined; }
  return open_.kind === "get" ? openGet(sock, r, Number(open_.offset) || 0, deviceId) : openPut(sock, r);
}

async function openGet(sock: ClientSocket, r: TransferRec, offset: number, deviceId: string | undefined): Promise<Lane | undefined> {
  const src = sourceFor(r);
  if ("code" in src) {
    if (src.code === "changed" || src.code === "missing") setState(r, "failed", src);
    fail(sock, src.code, src.message);
    return undefined;
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > src.size) { fail(sock, "io", "Bad offset"); return undefined; }
  let fh: FileHandle;
  try { fh = await open(src.path, "r"); } catch (e) { fail(sock, "missing", (e as Error).message); return undefined; }
  // A second download of a finished offer must not make it look unfinished when it is interrupted.
  const before = r.state;
  setState(r, "active");
  send(sock, { t: "lane_ok", offset, size: src.size });
  const progress = progressThrottle(r);
  let sent = offset;
  let acked = offset;
  let pumping = false;
  let closed = false;
  let finished = false;
  const buf = Buffer.allocUnsafe(FILE_CHUNK_BYTES);
  const close = async () => { if (closed) return; closed = true; try { await fh.close(); } catch { /* ignore */ } };
  const pump = async () => {
    if (pumping || closed) return;
    pumping = true;
    try {
      while (!closed && sent < src.size && sent - acked < FILE_WINDOW_BYTES) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(FILE_CHUNK_BYTES, src.size - sent), sent);
        if (!bytesRead) { setState(r, "failed", { code: "changed", message: "The file shrank while it was being sent" }); fail(sock, "changed", "file shrank"); await close(); return; }
        // Copy: the buffer is reused for the next read while this frame is still queued for encryption.
        await sock.sendBinary(Uint8Array.prototype.slice.call(buf, 0, bytesRead));
        sent += bytesRead;
      }
    } catch (e) {
      log.warn("lane read", r.id, e);
      fail(sock, "io", (e as Error).message);
      await close();
    } finally { pumping = false; }
  };
  void pump();
  return {
    onFrame: (f) => {
      if (f.t === "ack") {
        const b = Number(f.bytes);
        if (!Number.isSafeInteger(b) || b < acked || b > sent) return;
        acked = b;
        progress(acked);
        if (acked === src.size && !finished) {
          finished = true;
          void close();
          markDownloaded(r, deviceId);
          sock.close(1000, "done");
          return;
        }
        void pump();
      } else if (f.t === "cancel") { void close(); sock.close(1000, "cancelled"); }
    },
    onBinary: () => { fail(sock, "io", "unexpected data"); },
    onClose: () => {
      void close();
      if (!finished && r.state === "active") {
        if (before === "done") { r.bytesDone = r.size; setState(r, "done"); } else { r.bytesDone = acked; setState(r, "waiting"); }
      }
    },
  };
}

async function openPut(sock: ClientSocket, r: TransferRec): Promise<Lane | undefined> {
  if (r.dir !== "to_computer") { fail(sock, "denied", "Not an upload"); return undefined; }
  if (r.state === "done") { fail(sock, "io", "Already saved"); return undefined; }
  if (r.state === "cancelled" || r.state === "expired" || r.state === "failed") { fail(sock, r.state === "failed" ? "io" : r.state, r.state); return undefined; }
  if (!r.part) { fail(sock, "missing", "Upload has no partial file"); return undefined; }
  let have: number;
  try { have = (await stat(r.part)).size; } catch { setState(r, "failed", { code: "missing", message: "The partial file is gone" }); fail(sock, "missing", "partial file gone"); return undefined; }
  if (have > r.size) { fail(sock, "io", "partial file larger than expected"); return undefined; }
  let fh: FileHandle;
  try { fh = await open(r.part, "a"); } catch (e) { fail(sock, "io", (e as Error).message); return undefined; }
  setState(r, "active");
  const progress = progressThrottle(r);
  let size = have;
  let closed = false;
  let finished = false;
  let chain: Promise<void> = Promise.resolve();
  const close = async () => { if (closed) return; closed = true; try { await fh.close(); } catch { /* ignore */ } };
  send(sock, { t: "lane_ok", offset: have, size: r.size });
  if (have === r.size) chain = chain.then(() => complete());
  async function complete(): Promise<void> {
    finished = true;
    await fh.sync();
    await close();
    finishUpload(r);
    send(sock, { t: "put_done", info: pub(r) });
    sock.close(1000, "done");
  }
  return {
    onFrame: (f) => { if (f.t === "cancel") { void close(); sock.close(1000, "cancelled"); } },
    onBinary: (data) => {
      chain = chain.then(async () => {
        if (closed || finished) return;
        if (size + data.byteLength > r.size) { await close(); setState(r, "failed", { code: "io", message: "More data than announced" }); fail(sock, "io", "too much data"); return; }
        await fh.write(data);
        size += data.byteLength;
        send(sock, { t: "ack", bytes: size });
        progress(size);
        if (size === r.size) await complete();
      }).catch(async (e) => {
        log.warn("lane write", r.id, e);
        await close();
        fail(sock, "io", (e as Error).message);
      });
    },
    onClose: () => {
      void chain.then(close);
      if (!finished && r.state === "active") { r.bytesDone = size; setState(r, "waiting"); }
    },
  };
}
