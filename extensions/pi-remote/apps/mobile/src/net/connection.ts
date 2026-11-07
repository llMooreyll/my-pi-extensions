import { AppState } from "react-native";
import { PROTOCOL_VERSION, type BridgeEvent, type HostToClient, type OpArgs, type OpName, type OpResult, type RemoteError } from "@pi-remote/protocol";
import { loadHosts } from "../lib/credentials";
import { testLog } from "../lib/test-hooks";
import { store, useStore } from "../state/store";
import { candidates } from "./endpoints";
import { openSecure, type SecureConn } from "./secure-ws";

type Listener = (f: HostToClient) => void;

class Connection {
  private conn?: SecureConn;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: RemoteError) => void; timer: ReturnType<typeof setTimeout> }>();
  private backoffMs = 1000;
  private evtQueue: { processId: string; seq: number; ev: BridgeEvent }[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastFrameAt = 0;
  private generation = 0;
  private reqSeq = 0;
  private started = false;
  private procListeners = new Set<Listener>();
  private readyListeners = new Set<() => void>();

  start(): void {
    if (this.started) return;
    this.started = true;
    AppState.addEventListener("change", (s) => {
      store.setAppActive(s === "active");
      if (s === "active" && useStore.getState().conn === "backoff") void this.reconnectNow();
    });
    void this.open();
  }

  onProcFrame(l: Listener): () => void { this.procListeners.add(l); return () => this.procListeners.delete(l); }
  onReady(l: () => void): () => void { this.readyListeners.add(l); return () => this.readyListeners.delete(l); }

  private async open(): Promise<void> {
    const gen = ++this.generation;
    clearTimeout(this.reconnectTimer);
    const host = (await loadHosts())[0];
    store.setHost(host);
    if (!host) { store.setConn("no_credentials"); return; }
    store.setConn("connecting");
    let lastErr = "";
    for (const c of candidates(host.endpoint)) {
      try {
        const sc = await openSecure(c.url, host.endpoint.hostKey, c.via === "direct" ? 3000 : 10000);
        if (gen !== this.generation) { sc.close(); return; }
        this.conn = sc;
        store.setVia(c.via);
        sc.onText = (t) => {
          this.lastFrameAt = Date.now();
          let f: HostToClient;
          try { f = JSON.parse(t) as HostToClient; } catch { return; }
          this.onFrame(f);
        };
        sc.onClose = (code, reason) => {
          if (gen !== this.generation) return;
          if (code === 4411) { store.setLastError("This phone was unpaired on the computer"); store.setConn("no_credentials"); this.teardown(); return; }
          store.setLastError(`Disconnected (${code}${reason ? `: ${reason}` : ""})`);
          this.scheduleReconnect();
        };
        this.lastFrameAt = Date.now();
        sc.send(JSON.stringify({ t: "auth", protocol: PROTOCOL_VERSION, deviceId: host.deviceId, secret: host.secret }));
        return;
      } catch (e) {
        lastErr = `${c.via}: ${(e as Error)?.message ?? String(e)}`;
      }
    }
    if (gen !== this.generation) return;
    store.setLastError(lastErr || "No address configured");
    this.scheduleReconnect();
  }

  private onFrame(f: HostToClient): void {
    switch (f.t) {
      case "auth_ok":
        this.backoffMs = 1000;
        store.clearProcs();
        store.setHostInfo(f.hostName, f.hostVersion);
        store.setLastError(undefined);
        store.setConn("ready");
        testLog("conn", { state: "ready", via: useStore.getState().via });
        this.startHeartbeat();
        for (const l of this.readyListeners) l();
        break;
      case "auth_err":
        store.setLastError(f.code === "unauthorized" ? "This phone is not paired with the computer any more" : "Protocol version mismatch: update the app or pi-hostd");
        store.setConn(f.code === "unauthorized" ? "no_credentials" : "backoff");
        this.teardown();
        break;
      case "res": {
        const p = this.pending.get(f.id);
        if (!p) break;
        clearTimeout(p.timer);
        this.pending.delete(f.id);
        if (f.ok) p.resolve(f.data); else p.reject(f.error);
        break;
      }
      case "evt":
        this.evtQueue.push(f);
        this.flushTimer ??= setTimeout(() => this.flush(), 50);
        break;
      case "proc":
        // Apply buffered events first so a "down" never overtakes earlier events.
        this.flush();
        store.onProc(f.kind, f.info);
        for (const l of this.procListeners) l(f);
        break;
      case "pong": break;
      default: break;
    }
  }

  private flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const q = this.evtQueue;
    this.evtQueue = [];
    store.applyEvents(q);
  }

  request<K extends OpName>(op: K, args: OpArgs<K>, timeoutMs = 20000): Promise<OpResult<K>> {
    return new Promise((resolve, reject) => {
      if (!this.conn || useStore.getState().conn !== "ready") { reject({ code: "timeout", message: "Not connected" } satisfies RemoteError); return; }
      const id = `r${++this.reqSeq}`;
      const timer = setTimeout(() => { this.pending.delete(id); reject({ code: "timeout", message: `${op} timed out` } satisfies RemoteError); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.conn.send(JSON.stringify({ t: "req", id, op, args }));
    });
  }

  private teardown(): void {
    clearInterval(this.heartbeat);
    const c = this.conn;
    this.conn = undefined;
    this.generation++;
    try { c?.close(); } catch { /* ignore */ }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject({ code: "timeout", message: "Disconnected" }); }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    const gen = this.generation;
    clearInterval(this.heartbeat);
    this.conn = undefined;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject({ code: "timeout", message: "Disconnected" }); }
    this.pending.clear();
    store.setConn("backoff");
    testLog("conn", { state: "backoff", error: useStore.getState().lastError });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { if (gen === this.generation) void this.open(); }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
  }

  /** Drop the current connection and reconnect now (after address changes, pairing, app foreground). */
  async reconnectNow(): Promise<void> {
    this.teardown();
    this.backoffMs = 1000;
    await this.open();
  }

  /** Forget credentials state: used after unpairing. */
  disconnect(): void { this.teardown(); store.setConn("no_credentials"); }

  private startHeartbeat(): void {
    clearInterval(this.heartbeat);
    const gen = this.generation;
    this.heartbeat = setInterval(() => {
      if (gen !== this.generation || !this.conn) return;
      if (Date.now() - this.lastFrameAt > 45000) { this.conn.close(); this.scheduleReconnect(); return; }
      this.conn.send(JSON.stringify({ t: "ping", ts: Date.now() }));
    }, 20000);
  }
}

export const connection = new Connection();

export function call<K extends OpName>(op: K, args: OpArgs<K>, timeoutMs?: number): Promise<OpResult<K>> {
  return connection.request(op, args, timeoutMs);
}

export function errText(e: unknown): string {
  const r = e as RemoteError;
  if (r && typeof r.message === "string") return r.message;
  return e instanceof Error ? e.message : String(e);
}
export const errCode = (e: unknown): string | undefined => (e as RemoteError)?.code;
