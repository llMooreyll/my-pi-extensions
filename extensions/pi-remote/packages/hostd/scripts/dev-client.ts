#!/usr/bin/env node
// Command-line debug client for pi-hostd (plan 7.2.15).
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import WebSocket from "ws";
import { openClientSecureChannel, type SecureChannel, type Transport } from "@getpaseo/relay/e2ee";
import {
  DIRECT_PATH_CLIENT, PROTOCOL_VERSION, RELAY_PATH_CLIENT,
  type ClientToHost, type HostEndpoint, type HostToClient, type PairQr,
} from "../../protocol/src/index.ts";
import { readJson, writeJsonAtomic } from "../src/fsutil.ts";
import { CONFIG_DIR } from "../src/paths.ts";
import { rawToBuffer } from "../src/secure-socket.ts";

interface Creds { endpoint: HostEndpoint; deviceId: string; secret: string }
const CREDS_FILE = process.env.PI_REMOTE_DEV_CLIENT ?? join(CONFIG_DIR, "dev-client.json");

const argv = process.argv.slice(2);
let via: "relay" | "direct" = "relay";
let dumpWire = false;
for (let i = 0; i < argv.length;) {
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

interface Conn { send(f: ClientToHost): void; close(): void; onFrame: ((f: HostToClient) => void) | null }

function connect(ep: HostEndpoint): Promise<Conn> {
  const url = urlFor(ep);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { maxPayload: 16 * 1024 * 1024 });
    const transport: Transport = {
      send: (d) => { if (dumpWire) process.stderr.write(">> " + (typeof d === "string" ? d : `[binary ${d.byteLength}B] ${Buffer.from(d).toString("base64").slice(0, 80)}`) + "\n"); ws.send(d); },
      close: (c, r) => ws.close(c, r), onmessage: null, onclose: null, onerror: null,
    };
    const conn: Conn = { send: () => {}, close: () => ws.close(), onFrame: null };
    ws.on("message", (data, isBinary) => {
      const buf = rawToBuffer(data);
      if (dumpWire) process.stderr.write("<< " + (isBinary ? `[binary ${buf.length}B] ${buf.toString("base64").slice(0, 80)}` : buf.toString("utf8")) + "\n");
      transport.onmessage?.({ data: isBinary ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer : buf.toString("utf8"), isBinary });
    });
    let opened = false;
    ws.on("close", (code, reason) => {
      transport.onclose?.(code, reason.toString());
      if (!opened) reject(new Error(`closed before handshake: ${code} ${reason}`));
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
            onmessage: (d) => conn.onFrame?.(JSON.parse(typeof d === "string" ? d : new TextDecoder().decode(d)) as HostToClient),
            onerror: (e) => process.stderr.write(`channel error: ${e.message}\n`),
          },
        });
      } catch (e) { reject(e); return; }
      conn.send = (f) => { chain = chain.then(() => ch.send(JSON.stringify(f))); };
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
    default:
      die("usage: dev-client [--via relay|direct] [--dump-wire] pair|procs|sessions|listen|watch|prompt|ui|op ...");
  }
}

main().catch((e) => die(`error: ${typeof e === "object" ? JSON.stringify(e) === "{}" ? String(e) : JSON.stringify(e) : String(e)}`));
