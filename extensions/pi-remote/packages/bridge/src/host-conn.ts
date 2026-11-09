import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BRIDGE_VERSION, PROTOCOL_VERSION, type BridgeEvent, type BridgeToHost, type HostToBridge, type OfferFilesArgs, type RemoteError, type TransferInfo } from "../../protocol/src/index.ts";
import { logError, logInfo } from "./log.ts";
import { encodeNdjson, NdjsonDecoder } from "./ndjson.ts";
import { handleRequest } from "./ops.ts";
import { buildInfo } from "./snapshot.ts";
import { g } from "./state.ts";

const SOCKET_PATH = join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "pi-remote", "bridge.sock");
const QUEUE_LIMIT = 2000;
type EvFrame = Extract<BridgeToHost, { t: "ev" }>;

/** Unix-socket client to pi-hostd. Never throws, never blocks pi. */
export class HostConn {
  private socket?: Socket;
  private welcomed = false;
  private closed = false;
  private queue: EvFrame[] = [];
  private retry?: ReturnType<typeof setTimeout>;
  private helloSent = false;
  private spawnTokenUsed = false;
  /** Run once after the first welcome; used to retire the connection this one replaces. */
  afterWelcome?: () => void;
  private calls = new Map<string, { resolve: (v: { transfers: TransferInfo[] }) => void; reject: (e: RemoteError) => void; timer: ReturnType<typeof setTimeout> }>();

  /** Bridge-initiated request to hostd (7.7.3). Rejects at once when hostd is not connected. */
  call(op: "offer_files", args: OfferFilesArgs, timeoutMs: number): Promise<{ transfers: TransferInfo[] }> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.welcomed) { reject({ code: "unsupported", message: "pi-remote is not running on this computer (pi-hostd is not connected)" } satisfies RemoteError); return; }
      const id = randomUUID();
      const timer = setTimeout(() => { this.calls.delete(id); reject({ code: "timeout", message: `${op} timed out` } satisfies RemoteError); }, timeoutMs);
      this.calls.set(id, { resolve, reject, timer });
      this.write({ t: "call", id, op, args });
    });
  }

  private failCalls(): void {
    for (const c of this.calls.values()) { clearTimeout(c.timer); c.reject({ code: "bridge_gone", message: "Lost the connection to pi-hostd" }); }
    this.calls.clear();
  }

  connect(): void {
    if (this.closed || this.socket) return;
    let sock: Socket;
    try { sock = createConnection(SOCKET_PATH); } catch (e) { logError("connect", e); this.scheduleRetry(); return; }
    this.socket = sock;
    this.welcomed = false;
    const decoder = new NdjsonDecoder((v) => this.onFrame(v as HostToBridge), (e) => logError("bad hostd line", e));
    sock.on("connect", () => { try { this.sendHello(); } catch (e) { logError("hello", e); } });
    sock.on("data", (d) => decoder.push(d));
    sock.on("error", () => { /* close follows */ });
    sock.on("close", () => {
      if (this.socket === sock) { this.socket = undefined; this.welcomed = false; this.failCalls(); }
      this.scheduleRetry();
    });
    sock.unref();
  }

  private scheduleRetry(): void {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => { this.retry = undefined; this.connect(); }, 5000);
    this.retry.unref?.();
  }

  private sendHello(): void {
    const info = buildInfo();
    // Events still queued were not delivered; tell hostd its replay buffer starts right before them.
    if (this.queue.length) info.lastSeq = this.queue[0]!.seq - 1;
    const token = !this.spawnTokenUsed ? process.env.PI_REMOTE_SPAWN_TOKEN : undefined;
    const hello: BridgeToHost = { t: "hello", protocol: PROTOCOL_VERSION, bridgeVersion: BRIDGE_VERSION, info, ...(token ? { spawnToken: token } : {}) };
    this.socket?.write(encodeNdjson(hello));
    this.helloSent = true;
  }

  private onFrame(f: HostToBridge): void {
    if (f.t === "welcome") {
      this.welcomed = true;
      this.spawnTokenUsed = true;
      logInfo(`connected to hostd as ${g().processId}`);
      const q = this.queue;
      this.queue = [];
      for (const ev of q) this.write(ev);
      const after = this.afterWelcome;
      this.afterWelcome = undefined;
      try { after?.(); } catch (e) { logError("afterWelcome", e); }
      return;
    }
    if (f.t === "ret") {
      const c = this.calls.get(f.id);
      if (!c) return;
      this.calls.delete(f.id);
      clearTimeout(c.timer);
      if (f.ok) c.resolve(f.data); else c.reject(f.error);
      return;
    }
    if (f.t === "req") {
      handleRequest(f.op, f.args ?? {}).then(
        (data) => this.write({ t: "res", id: f.id, ok: true, data }),
        (e: unknown) => {
          const o = e as { code?: string; message?: string };
          const code = typeof o?.code === "string" ? o.code : "internal";
          this.write({ t: "res", id: f.id, ok: false, error: { code: code as never, message: String(o?.message ?? e) } });
        },
      );
    }
  }

  private write(frame: BridgeToHost): void {
    try { this.socket?.write(encodeNdjson(frame)); } catch (e) { logError("write", e); }
  }

  /** Take over events another connection had not delivered yet. */
  adopt(frames: EvFrame[]): void { this.queue.unshift(...frames); }

  sendEvent(frame: EvFrame): void {
    if (this.socket && this.welcomed) { this.write(frame); return; }
    this.queue.push(frame);
    if (this.queue.length > QUEUE_LIMIT) this.queue.splice(0, this.queue.length - QUEUE_LIMIT);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retry);
    try {
      if (this.socket && this.helloSent) this.socket.end(encodeNdjson({ t: "bye", processId: g().processId }));
      else this.socket?.destroy();
    } catch { /* ignore */ }
  }
}

/** Events queued in a connection made by older bridge code, read without calling its methods. */
interface OldConn { queue?: EvFrame[]; closed?: boolean; retry?: ReturnType<typeof setTimeout>; socket?: Socket }

/**
 * The connection lives on globalThis so the processId and the event sequence survive /reload and session
 * replacement. Its methods do not: after /reload the object was built by the previous code (e.g. it had no
 * call(), so send_to_phone failed). Replace such a connection with one of this code. The new one says hello
 * with the same processId first; only after hostd welcomes it is the old socket dropped, without "bye",
 * so hostd treats this as a reconnect and the phone never sees the process go away.
 */
export function ensureConnected(): void {
  const s = g();
  if (s.conn && !(s.conn instanceof HostConn)) {
    const old = s.conn as unknown as OldConn;
    const fresh = new HostConn();
    const pending = Array.isArray(old.queue) ? old.queue.splice(0) : [];
    fresh.adopt(pending);
    fresh.afterWelcome = () => {
      old.closed = true;
      clearTimeout(old.retry);
      try { old.socket?.destroy(); } catch { /* gone */ }
    };
    s.conn = fresh;
    logInfo("replaced the hostd connection left by previous bridge code");
  }
  if (!s.conn) s.conn = new HostConn();
  s.conn.connect();
}

/** All events go through here so seq stays contiguous. */
export function emit(ev: BridgeEvent): void {
  const s = g();
  if (!s.enabled) return;
  s.seq += 1;
  s.conn?.sendEvent({ t: "ev", processId: s.processId, seq: s.seq, ev });
}

export function emitSafe(ev: BridgeEvent): void {
  try { emit(ev); } catch (e) { logError("emit", e); }
}
