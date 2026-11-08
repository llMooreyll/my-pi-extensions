#!/usr/bin/env node
// Command-line debug client for pi-hostd (plan 7.2.15).
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { basename } from "node:path";
import { join } from "node:path";
import WebSocket from "ws";
import { openClientSecureChannel, type SecureChannel, type Transport } from "@getpaseo/relay/e2ee";
import {
  DIRECT_PATH_CLIENT, PROTOCOL_VERSION, RELAY_PATH_CLIENT,
  FILE_WINDOW_BYTES, FILE_CHUNK_BYTES,
  type ClientToHost, type HostEndpoint, type HostToClient, type PairQr, type TransferInfo,
} from "../../protocol/src/index.ts";
import { readJson, writeJsonAtomic } from "../src/fsutil.ts";
import { CONFIG_DIR } from "../src/paths.ts";
import { rawToBuffer } from "../src/secure-socket.ts";

interface Creds { endpoint: HostEndpoint; deviceId: string; secret: string }
const CREDS_FILE = process.env.PI_REMOTE_DEV_CLIENT ?? join(CONFIG_DIR, "dev-client.json");

const argv = process.argv.slice(2);
let via: "relay" | "direct" = "relay";
let dumpWire = false;
let stopAfterArg = NaN;
for (let i = 0; i < argv.length;) {
  if (argv[i] === "--stop-after") { stopAfterArg = Number(argv[i + 1]); argv.splice(i, 2); continue; }
  if (argv[i] === "--via") { via = argv[i + 1] as "relay" | "direct"; argv.splice(i, 2); }
  else if (argv[i] === "--dump-wire") { dumpWire = true; argv.splice(i, 1); }
  else i++;
}
const out = (v: unknown) => process.stdout.write((typeof v === "string" ? v : JSON.stringify(v)) + "\n");
const die = (m: string, code = 1): never => { process.stderr.write(m + "\n"); process.exit(code); };

function urlFor(ep: HostEndpoint): string {
  if (via === "direct") {
    if (!ep.direct) die("endpoint has no direct address");
    return ep.direct!.replace(/\/$/, "") + DIRECT_PATH_CLIENT;
  }
  const r = ep.relays[0];
  if (!r) die("endpoint has no relay");
  return r.replace(/\/$/, "") + RELAY_PATH_CLIENT + "?hostId=" + encodeURIComponent(ep.hostId);
}

interface Conn {
  send(f: ClientToHost): void;
  sendBinary(b: Uint8Array): Promise<void>;
  close(): void;
  onFrame: ((f: HostToClient) => void) | null;
  onBinary: ((b: Uint8Array) => void) | null;
  /** Called on close instead of exiting the process (file lanes). */
  onClosed?: (code: number, reason: string) => void;
}

function connect(ep: HostEndpoint): Promise<Conn> {
  const url = urlFor(ep);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { maxPayload: 16 * 1024 * 1024 });
    const transport: Transport = {
      send: (d) => { if (dumpWire) process.stderr.write(">> " + (typeof d === "string" ? d : `[binary ${d.byteLength}B] ${Buffer.from(d).toString("base64").slice(0, 80)}`) + "\n"); ws.send(d); },
      close: (c, r) => ws.close(c, r), onmessage: null, onclose: null, onerror: null,
    };
    const conn: Conn = { send: () => {}, sendBinary: async () => {}, close: () => ws.close(), onFrame: null, onBinary: null };
    ws.on("message", (data, isBinary) => {
      const buf = rawToBuffer(data);
      if (dumpWire) process.stderr.write("<< " + (isBinary ? `[binary ${buf.length}B] ${buf.toString("base64").slice(0, 80)}` : buf.toString("utf8")) + "\n");
      transport.onmessage?.({ data: isBinary ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer : buf.toString("utf8"), isBinary });
    });
    let opened = false;
    ws.on("close", (code, reason) => {
      transport.onclose?.(code, reason.toString());
      if (!opened) reject(new Error(`closed before handshake: ${code} ${reason}`));
      else if (conn.onClosed) conn.onClosed(code, reason.toString());
      else { process.stderr.write(`connection closed: ${code} ${reason}\n`); process.exit(code === 1000 ? 0 : 2); }
    });
    ws.on("error", (e) => { transport.onerror?.(e); if (!opened) reject(e); });
    ws.on("open", async () => {
      let ch: SecureChannel;
      let chain: Promise<void> = Promise.resolve();
      try {
        ch = await openClientSecureChannel(transport, {
          daemonPublicKeyB64: ep.hostKey,
          minimumMode: "protected",
          events: {
            onopen: () => { opened = true; resolve(conn); },
            onmessage: (d) => {
              if (typeof d === "string") conn.onFrame?.(JSON.parse(d) as HostToClient);
              else conn.onBinary?.(new Uint8Array(d as ArrayBuffer));
            },
            onerror: (e) => process.stderr.write(`channel error: ${e.message}\n`),
          },
        });
      } catch (e) { reject(e); return; }
      conn.send = (f) => { chain = chain.then(() => ch.send(JSON.stringify(f))); };
      conn.sendBinary = (b) => { const p = chain.then(() => ch.send(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)); chain = p; return p; };
      conn.close = () => ch.close(1000, "bye");
    });
    setTimeout(() => { if (!opened) { ws.terminate(); reject(new Error("handshake timeout")); } }, 10_000);
  });
}

async function session(): Promise<{ conn: Conn; request: (op: string, args: object) => Promise<unknown>; onEvent: (h: (f: HostToClient) => void) => void }> {
  const creds = readJson<Creds>(CREDS_FILE);
  if (!creds) die(`no credentials at ${CREDS_FILE}; run: dev-client pair '<PairQr JSON>'`);
  const conn = await connect(creds!.endpoint);
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  let handler: ((f: HostToClient) => void) | null = null;
  let authed!: () => void;
  const authP = new Promise<void>((r) => { authed = r; });
  conn.onFrame = (f) => {
    if (f.t === "auth_ok") { authed(); return; }
    if (f.t === "auth_err") die(`auth failed: ${f.code}`, 3);
    if (f.t === "res") { const p = pending.get(f.id); if (p) { pending.delete(f.id); f.ok ? p.resolve(f.data) : p.reject(f.error); } return; }
    handler?.(f);
  };
  conn.send({ t: "auth", protocol: PROTOCOL_VERSION, deviceId: creds!.deviceId, secret: creds!.secret });
  await authP;
  const ping = setInterval(() => conn.send({ t: "ping", ts: Date.now() }), 20_000);
  ping.unref();
  return {
    conn,
    request: (op, args) => new Promise((resolve, reject) => { const id = randomUUID(); pending.set(id, { resolve, reject }); conn.send({ t: "req", id, op, args: args as Record<string, unknown> }); }),
    onEvent: (h) => { handler = h; },
  };
}

/** Open a file lane: a second connection authenticated with purpose "lane". */
async function lane(): Promise<Conn> {
  const creds = readJson<Creds>(CREDS_FILE);
  if (!creds) die(`no credentials at ${CREDS_FILE}`);
  const conn = await connect(creds!.endpoint);
  await new Promise<void>((resolve) => {
    conn.onFrame = (f) => { if (f.t === "auth_ok") resolve(); else if (f.t === "auth_err") die(`auth failed: ${f.code}`, 3); };
    conn.send({ t: "auth", protocol: PROTOCOL_VERSION, deviceId: creds!.deviceId, secret: creds!.secret, purpose: "lane" });
  });
  return conn;
}

async function getFile(id: string, outFile: string, offsetArg?: string): Promise<void> {
  const offset = offsetArg !== undefined ? Number(offsetArg) : existsSync(outFile) ? statSync(outFile).size : 0;
  const stopAfter = stopAfterArg;
  const fd = openSync(outFile, offset > 0 ? "r+" : "w");
  let pos = offset;
  const started = Date.now();
  const conn = await lane();
  conn.onClosed = (code, reason) => {
    closeSync(fd);
    const secs = (Date.now() - started) / 1000;
    out({ closed: code, reason, bytes: pos, received: pos - offset, seconds: secs, mbPerSec: +((pos - offset) / 1048576 / secs).toFixed(2) });
    process.exit(reason === "done" ? 0 : 4);
  };
  conn.onFrame = (f) => {
    if (f.t === "lane_ok") out({ lane_ok: f });
    else if (f.t === "lane_err") out({ lane_err: f });
  };
  conn.onBinary = (b) => {
    writeSync(fd, b, 0, b.byteLength, pos);
    pos += b.byteLength;
    if (pos - offset >= stopAfter) { conn.close(); return; }
    conn.send({ t: "ack", bytes: pos });
  };
  conn.send({ t: "lane", kind: "get", id, offset });
}

async function putFile(file: string, id?: string): Promise<void> {
  const size = statSync(file).size;
  const stopAfter = stopAfterArg;
  if (!id) {
    const s = await session();
    const r = (await s.request("upload_begin", { name: basename(file), size })) as { transfer: TransferInfo };
    id = r.transfer.id;
    out({ upload: r.transfer });
    s.conn.onClosed = () => {};
    s.conn.close();
  }
  const conn = await lane();
  const fd = openSync(file, "r");
  const buf = Buffer.allocUnsafe(FILE_CHUNK_BYTES);
  let sent = 0;
  let acked = 0;
  let start = 0;
  let pumping = false;
  const started = Date.now();
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    while (sent < size && sent - acked < FILE_WINDOW_BYTES) {
      if (sent - start >= stopAfter) { conn.close(); pumping = false; return; }
      const n = readSync(fd, buf, 0, Math.min(FILE_CHUNK_BYTES, size - sent), sent);
      await conn.sendBinary(buf.subarray(0, n));
      sent += n;
    }
    pumping = false;
  };
  conn.onClosed = (code, reason) => {
    closeSync(fd);
    const secs = (Date.now() - started) / 1000;
    out({ closed: code, reason, id, acked, sent: acked - start, seconds: secs, mbPerSec: +((acked - start) / 1048576 / secs).toFixed(2) });
    process.exit(reason === "done" ? 0 : 4);
  };
  conn.onFrame = (f) => {
    if (f.t === "lane_ok") { out({ lane_ok: f }); sent = acked = start = f.offset; void pump(); }
    else if (f.t === "ack") { acked = f.bytes; void pump(); }
    else if (f.t === "put_done") out({ put_done: f.info });
    else if (f.t === "lane_err") out({ lane_err: f });
  };
  conn.send({ t: "lane", kind: "put", id: id! });
}

async function main(): Promise<void> {
  const cmd = argv.shift();
  switch (cmd) {
    case "pair": {
      const qr = JSON.parse(argv[0] ?? die("usage: dev-client pair '<PairQr JSON>'")) as PairQr;
      if (qr.v !== 2 || qr.kind !== "pair") die("not a pairing QR");
      const conn = await connect(qr);
      conn.onFrame = (f) => {
        if (f.t === "pair_ok") {
          const endpoint: HostEndpoint = { hostId: qr.hostId, hostKey: qr.hostKey, hostName: f.hostName, relays: qr.relays, ...(qr.direct ? { direct: qr.direct } : {}) };
          writeJsonAtomic(CREDS_FILE, { endpoint, deviceId: f.deviceId, secret: f.secret });
          out(`paired as ${f.deviceId} with ${f.hostName}; credentials saved to ${CREDS_FILE}`);
          conn.close();
          setTimeout(() => process.exit(0), 100);
        } else if (f.t === "pair_err") die(`pairing failed: ${f.code}`, 3);
      };
      conn.send({ t: "pair", protocol: PROTOCOL_VERSION, code: qr.code, deviceName: "dev-client" });
      return;
    }
    case "procs": { const s = await session(); out(await s.request("list_processes", {})); process.exit(0); }
    case "sessions": { const s = await session(); out(await s.request("list_sessions", argv[0] ? { cwd: argv[0] } : {})); process.exit(0); }
    case "listen": { const s = await session(); s.onEvent((f) => out(f)); return; }
    case "watch": {
      const processId = argv[0] ?? die("usage: dev-client watch <processId> [sinceSeq]");
      const s = await session();
      s.onEvent((f) => { if (f.t === "evt" && f.processId === processId) out(f); else if (f.t === "proc" && f.info.processId === processId && f.kind === "down") out(f); });
      const args: Record<string, unknown> = { processId };
      if (argv[1]) args.sinceSeq = Number(argv[1]);
      out(await s.request("subscribe", args));
      return;
    }
    case "prompt": {
      const processId = argv.shift() ?? die("usage: dev-client prompt <processId> <text...>");
      const text = argv.join(" ");
      const s = await session();
      const procs = (await s.request("list_processes", {})) as { processes: { processId: string; status: string }[] };
      const p = procs.processes.find((x) => x.processId === processId);
      const args: Record<string, unknown> = { processId, text };
      if (p && p.status !== "idle" && !text.startsWith("/")) args.deliverAs = "steer";
      out(await s.request("prompt", args));
      process.exit(0);
    }
    case "ui": {
      const [processId, uiId, json] = argv;
      if (!processId || !uiId || !json) die("usage: dev-client ui <processId> <uiId> '<json>'");
      const s = await session();
      out(await s.request("ui_respond", { processId, uiId, response: JSON.parse(json!) }));
      process.exit(0);
    }
    case "op": {
      const op = argv[0] ?? die("usage: dev-client op <opName> '<json args>'");
      const s = await session();
      out(await s.request(op, JSON.parse(argv[1] ?? "{}")));
      process.exit(0);
    }
    case "rtt": {
      // Request latency on one open connection, as the app sees it: rtt [count] [intervalMs]
      const n = Number(argv[0] ?? 10), every = Number(argv[1] ?? 2000);
      const s = await session();
      for (let i = 0; i < n; i++) {
        const t0 = Date.now();
        await s.request("list_processes", {});
        out(`rtt ${Date.now() - t0}ms`);
        await new Promise((r) => setTimeout(r, every));
      }
      process.exit(0);
    }
    case "transfers": { const s = await session(); out(await s.request("list_transfers", {})); process.exit(0); }
    case "get": {
      const [id, outFile, offset] = argv;
      if (!id || !outFile) die("usage: dev-client get <id> <outFile> [offset] [--stop-after <bytes>]");
      await getFile(id!, outFile!, offset);
      return;
    }
    case "put": {
      const [file, id] = argv;
      if (!file) die("usage: dev-client put <file> [transferId to resume] [--stop-after <bytes>]");
      await putFile(file!, id);
      return;
    }
    default:
      die("usage: dev-client [--via relay|direct] [--dump-wire] pair|procs|sessions|listen|watch|prompt|ui|op|transfers|get|put ...");
  }
}

main().catch((e) => die(`error: ${typeof e === "object" ? JSON.stringify(e) === "{}" ? String(e) : JSON.stringify(e) : String(e)}`));
