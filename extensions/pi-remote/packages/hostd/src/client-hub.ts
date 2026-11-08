import { randomUUID } from "node:crypto";
import {
  CLOSE, HOSTD_VERSION, OP_TIMEOUT_MS, PROTOCOL_VERSION,
  type BridgeEvent, type ClientToHost, type HostToClient, type OpName, type ProcessInfo, type Snapshot,
} from "../../protocol/src/index.ts";
import { audit } from "./audit.ts";
import { consumePairing, loadDevices, touchDevice, verifyDevice } from "./devices.ts";
import { err, toRemoteError } from "./errors.ts";
import { log } from "./log.ts";
import { auditSummary, isOpName, SIDE_EFFECT_OPS, VALIDATORS } from "./ops.ts";
import { registry } from "./registry.ts";
import type { ClientSocket } from "./secure-socket.ts";
import { runLocalOp } from "./local-ops.ts";
import { runtime } from "./runtime.ts";

type EvtFrame = Extract<HostToClient, { t: "evt" }>;
interface Sub { pending: boolean; buf: EvtFrame[] }
export interface Client {
  id: string;
  sock: ClientSocket;
  deviceId?: string;
  authed: boolean;
  closed: boolean;
  lastFrameAt: number;
  subs: Map<string, Sub>;
  authTimer?: ReturnType<typeof setTimeout>;
}

const MAX_UNAUTHED = 20;
const BRIDGE_OPS_WITH_CONFLICT_CHECK = new Set(["switch_session"]);

class ClientHub {
  private clients = new Set<Client>();
  private pairChain: Promise<void> = Promise.resolve();
  private timers: ReturnType<typeof setInterval>[] = [];

  start(): void {
    this.timers.push(setInterval(() => this.reapIdle(), 20_000));
  }
  stop(): void { for (const t of this.timers) clearInterval(t); for (const c of this.clients) c.sock.close(1001, "shutdown"); }

  get count(): number { return this.clients.size; }
  unauthedCount(): number { let n = 0; for (const c of this.clients) if (!c.authed) n++; return n; }

  accept(sock: ClientSocket): void {
    if (this.unauthedCount() >= MAX_UNAUTHED) { sock.close(CLOSE.RATE_LIMITED, "too many pending connections"); return; }
    const c: Client = { id: randomUUID(), sock, authed: false, closed: false, lastFrameAt: Date.now(), subs: new Map() };
    this.clients.add(c);
    c.authTimer = setTimeout(() => { if (!c.authed) this.close(c, CLOSE.AUTH_TIMEOUT, "auth timeout"); }, 10_000);
    sock.onClose = () => { c.closed = true; clearTimeout(c.authTimer); this.clients.delete(c); log.info("client closed", sock.remote, c.deviceId ?? "-"); };
    sock.onText = (text) => {
      c.lastFrameAt = Date.now();
      let f: ClientToHost;
      try { f = JSON.parse(text) as ClientToHost; } catch { this.close(c, 1003, "bad frame"); return; }
      this.onFrame(c, f).catch((e) => log.warn("frame handler", e));
    };
    log.info("client connected", sock.remote);
  }

  private send(c: Client, f: HostToClient): void { if (!c.closed) c.sock.send(JSON.stringify(f)); }
  private close(c: Client, code: number, reason: string): void {
    if (c.closed) return;
    c.closed = true;
    clearTimeout(c.authTimer);
    this.clients.delete(c);
    c.sock.close(code, reason);
  }

  private markAuthed(c: Client, deviceId: string): void {
    c.authed = true;
    c.deviceId = deviceId;
    clearTimeout(c.authTimer);
    try { touchDevice(deviceId); } catch (e) { log.warn("touchDevice", e); }
  }

  private async onFrame(c: Client, f: ClientToHost): Promise<void> {
    if (f.t === "ping") { this.send(c, { t: "pong", ts: f.ts }); return; }
    if (!c.authed) {
      if (f.t === "auth") return this.onAuth(c, f);
      if (f.t === "pair") return this.onPair(c, f);
      this.close(c, CLOSE.UNAUTHORIZED, "not authenticated");
      return;
    }
    if (f.t === "req") { await this.onReq(c, f.id, f.op, f.args ?? {}); return; }
  }

  private onAuth(c: Client, f: Extract<ClientToHost, { t: "auth" }>): void {
    if (f.protocol !== PROTOCOL_VERSION) { this.send(c, { t: "auth_err", code: "incompatible" }); this.close(c, 1000, "incompatible"); return; }
    const d = verifyDevice(f.deviceId, f.secret);
    if (!d) {
      audit({ op: "auth_failed", deviceId: typeof f.deviceId === "string" ? f.deviceId : undefined, remote: c.sock.remote });
      this.send(c, { t: "auth_err", code: "unauthorized" });
      this.close(c, CLOSE.UNAUTHORIZED, "unauthorized");
      return;
    }
    this.markAuthed(c, d.id);
    log.info("client authed", c.sock.remote, d.id, d.name);
    this.send(c, { t: "auth_ok", hostVersion: HOSTD_VERSION, hostName: runtime.config.hostName });
    for (const info of registry.list()) this.send(c, { t: "proc", kind: "up", info });
  }

  private onPair(c: Client, f: Extract<ClientToHost, { t: "pair" }>): Promise<void> {
    const run = async () => {
      if (c.closed) return;
      if (f.protocol !== PROTOCOL_VERSION) { this.send(c, { t: "pair_err", code: "incompatible" }); this.close(c, 1000, "incompatible"); return; }
      const r = consumePairing(String(f.code ?? ""), String(f.deviceName ?? "device"));
      if (!r) {
        await new Promise((res) => setTimeout(res, 1000));
        this.send(c, { t: "pair_err", code: "invalid_code" });
        this.close(c, 1000, "invalid code");
        return;
      }
      audit({ op: "pair", deviceId: r.deviceId, summary: String(f.deviceName ?? ""), remote: c.sock.remote });
      this.markAuthed(c, r.deviceId);
      log.info("device paired", r.deviceId, f.deviceName);
      this.send(c, { t: "pair_ok", deviceId: r.deviceId, secret: r.secret, hostName: runtime.config.hostName, hostVersion: HOSTD_VERSION });
      for (const info of registry.list()) this.send(c, { t: "proc", kind: "up", info });
    };
    const p = this.pairChain.then(run, run);
    this.pairChain = p.catch(() => {});
    return p;
  }

  private async onReq(c: Client, id: string, op: string, args: Record<string, unknown>): Promise<void> {
    const reply = (data: unknown) => this.send(c, { t: "res", id, ok: true, data });
    const fail = (e: unknown) => this.send(c, { t: "res", id, ok: false, error: toRemoteError(e) });
    try {
      if (typeof id !== "string") throw err("bad_request", "id required");
      if (!isOpName(op)) throw err("bad_request", `unknown op ${op}`);
      if (!args || typeof args !== "object") throw err("bad_request", "args must be an object");
      VALIDATORS[op](args);
      if (SIDE_EFFECT_OPS.has(op)) audit({ deviceId: c.deviceId, op, processId: typeof args.processId === "string" ? args.processId : undefined, summary: auditSummary(op, args) });
      if (op === "subscribe") {
        const { res, after } = await this.subscribe(c, args.processId as string, args.sinceSeq as number | undefined);
        reply(res);
        after();
        return;
      }
      if (op === "unsubscribe") { c.subs.delete(args.processId as string); reply({}); return; }
      const local = await runLocalOp(op, args);
      if (local.handled) { reply(local.result); return; }
      const processId = args.processId as string;
      if (!registry.get(processId)) throw err("not_found", `process ${processId} not found`);
      if (BRIDGE_OPS_WITH_CONFLICT_CHECK.has(op)) {
        const other = registry.findBySessionFile(args.sessionFile as string);
        if (other && other.info.processId !== processId) throw err("conflict_live_elsewhere", other.info.processId);
      }
      const data = await registry.request(processId, op, args, OP_TIMEOUT_MS[op as OpName] ?? OP_TIMEOUT_MS.DEFAULT);
      reply(data);
    } catch (e) {
      fail(e);
    }
  }

  /** Returns the response plus a function that flushes replayed/buffered events; call it right after sending the response. */
  private async subscribe(c: Client, processId: string, sinceSeq?: number): Promise<{ res: unknown; after: () => void }> {
    const e = registry.get(processId);
    if (!e) throw err("not_found", `process ${processId} not found`);
    if (sinceSeq !== undefined) {
      const missed = e.ring.since(sinceSeq);
      if (missed) {
        c.subs.set(processId, { pending: false, buf: [] });
        return {
          res: { mode: "replay" },
          after: () => { for (const m of missed) this.send(c, { t: "evt", processId, seq: m.seq, ev: m.ev }); },
        };
      }
    }
    const sub: Sub = { pending: true, buf: [] };
    c.subs.set(processId, sub);
    try {
      const snapshot = await registry.request(processId, "get_snapshot", { maxMessages: runtime.config.snapshotMessages }, 15_000) as Snapshot;
      // The bridge cannot know the parent link; hostd derives it (links.ts), so graft it back on.
      const known = registry.get(processId)?.info;
      if (known?.parentProcessId) snapshot.info = { ...snapshot.info, parentProcessId: known.parentProcessId };
      if (known?.lastActiveAt) snapshot.info = { ...snapshot.info, lastActiveAt: known.lastActiveAt };
      return {
        res: { mode: "snapshot", snapshot },
        after: () => {
          for (const f of sub.buf) if (f.seq > snapshot.seq) this.send(c, f);
          sub.buf = [];
          sub.pending = false;
        },
      };
    } catch (ex) {
      if (c.subs.get(processId) === sub) c.subs.delete(processId);
      throw ex;
    }
  }

  dispatchEvent(processId: string, seq: number, ev: BridgeEvent): void {
    const f: EvtFrame = { t: "evt", processId, seq, ev };
    for (const c of this.clients) {
      if (!c.authed) continue;
      const sub = c.subs.get(processId);
      if (!sub) continue;
      if (sub.pending) sub.buf.push(f); else this.send(c, f);
    }
  }

  broadcastProc(kind: "up" | "down" | "changed", info: ProcessInfo): void {
    for (const c of this.clients) {
      if (!c.authed) continue;
      this.send(c, { t: "proc", kind, info });
      if (kind === "down") c.subs.delete(info.processId);
    }
  }

  /** Close connections of devices that are no longer in devices.json. */
  enforceRevocations(): void {
    const ids = new Set(loadDevices().map((d) => d.id));
    for (const c of [...this.clients]) {
      if (c.authed && c.deviceId && !ids.has(c.deviceId)) {
        log.info("device revoked, closing", c.deviceId);
        this.close(c, CLOSE.UNAUTHORIZED, "device revoked");
      }
    }
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const c of [...this.clients]) if (now - c.lastFrameAt > 60_000) { log.info("client idle, closing", c.sock.remote); this.close(c, 1001, "idle"); }
  }
}

export const hub = new ClientHub();
