import { realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { ProcessInfo } from "../../protocol/src/index.ts";
import { err, RemoteErr } from "./errors.ts";
import { EventRing } from "./event-ring.ts";
import { encodeNdjson } from "./ndjson.ts";

interface Pending { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }

export class BridgeConn {
  socket: Socket;
  pending = new Map<string, Pending>();
  processId?: string;
  constructor(socket: Socket) { this.socket = socket; }
  send(frame: unknown): void { if (!this.socket.destroyed) this.socket.write(encodeNdjson(frame)); }
  request(op: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(err("timeout", `${op} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ t: "req", id, op, args });
    });
  }
  settle(id: string, ok: boolean, payload: unknown): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (ok) p.resolve(payload);
    else { const e = payload as { code?: string; message?: string }; p.reject(new RemoteErr((e?.code ?? "internal") as never, e?.message ?? "bridge error")); }
  }
  failAll(): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err("bridge_gone", "pi process went away")); }
    this.pending.clear();
  }
}

/**
 * Last activity of a process: the later of what its bridge reports and the session file's mtime. The file
 * is written on every message, so this also orders processes whose bridge predates lastActiveAt.
 */
export function withActivity(info: ProcessInfo): ProcessInfo {
  let mtime = 0;
  if (info.sessionFile) { try { mtime = statSync(info.sessionFile).mtimeMs; } catch { /* not written yet */ } }
  const at = Math.max(info.lastActiveAt ?? 0, Math.floor(mtime));
  return at ? { ...info, lastActiveAt: at } : info;
}

export interface ProcEntry { conn: BridgeConn; info: ProcessInfo; ring: EventRing }

function real(f: string): string { try { return realpathSync(f); } catch { return f; } }

class Registry {
  private procs = new Map<string, ProcEntry>();
  ringSize = 5000;

  upsert(processId: string, conn: BridgeConn, info: ProcessInfo): ProcEntry {
    const prev = this.procs.get(processId);
    if (prev) {
      if (prev.conn !== conn) prev.conn.failAll();
      prev.conn = conn;
      prev.info = { ...withActivity(info), parentProcessId: prev.info.parentProcessId };
      return prev;
    }
    const e: ProcEntry = { conn, info: withActivity(info), ring: new EventRing(this.ringSize, info.lastSeq) };
    this.procs.set(processId, e);
    return e;
  }
  get(processId: string): ProcEntry | undefined { return this.procs.get(processId); }
  remove(processId: string): void { this.procs.delete(processId); }
  entries(): ProcEntry[] { return [...this.procs.values()]; }
  list(): ProcessInfo[] { return this.entries().map((e) => e.info); }
  findBySessionFile(file: string): ProcEntry | undefined {
    const target = real(file);
    return this.entries().find((e) => e.info.sessionFile && (e.info.sessionFile === file || real(e.info.sessionFile) === target));
  }
  request(processId: string, op: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const e = this.procs.get(processId);
    if (!e) return Promise.reject(err("not_found", `process ${processId} not found`));
    return e.conn.request(op, args, timeoutMs);
  }
}

export const registry = new Registry();
