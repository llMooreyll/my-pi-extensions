import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { CLOSE, RELAY_PATH_CLIENT, RELAY_PATH_HOST_CONTROL, RELAY_PATH_HOST_DATA } from "./wire.ts";

const PORT = Number(process.env.RELAY_PORT ?? 7443);
const HOST = process.env.RELAY_HOST ?? "0.0.0.0";
const SECRET = process.env.RELAY_SECRET ?? "";
const TRUST_PROXY = process.env.RELAY_TRUST_PROXY === "1";
if (!SECRET) {
  process.stderr.write("RELAY_SECRET is required. Generate one with `openssl rand -base64 32` and pass it as an environment variable.\n");
  process.exit(1);
}

interface HostRecord { control: WebSocket; lastSeen: number; ping: ReturnType<typeof setInterval> }
interface PendingClient { ws: WebSocket; hostId: string; ip: string; buffered: { data: RawData; isBinary: boolean }[]; bufferedBytes: number; timer: ReturnType<typeof setTimeout> }
const hosts = new Map<string, HostRecord>();
const pending = new Map<string, PendingClient>();
const clientsPerIp = new Map<string, number>();

const HOST_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const secretBuf = Buffer.from(`Bearer ${SECRET}`);

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + "\n");
}
const short = (h: string) => h.slice(0, 6);

function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "?";
}

function authorized(req: IncomingMessage): boolean {
  const h = Buffer.from(String(req.headers.authorization ?? ""));
  return h.length === secretBuf.length && timingSafeEqual(h, secretBuf);
}

const passCode = (code: number) => (code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000);

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

function onHostControl(ws: WebSocket, req: IncomingMessage, hostId: string): void {
  if (!HOST_ID_RE.test(hostId) || !authorized(req)) { ws.close(CLOSE.BAD_RELAY_SECRET, "bad relay secret"); return; }
  const prev = hosts.get(hostId);
  if (prev) { clearInterval(prev.ping); prev.control.close(CLOSE.HOST_REPLACED, "replaced"); }
  const rec: HostRecord = {
    control: ws, lastSeen: Date.now(),
    ping: setInterval(() => {
      if (Date.now() - rec.lastSeen > 60_000) { ws.terminate(); return; }
      ws.send(JSON.stringify({ t: "ping", ts: Date.now() }));
    }, 25_000),
  };
  hosts.set(hostId, rec);
  log("host_up", { host: short(hostId), ip: clientIp(req) });
  ws.on("message", () => { rec.lastSeen = Date.now(); });
  ws.on("close", () => {
    clearInterval(rec.ping);
    if (hosts.get(hostId) === rec) { hosts.delete(hostId); log("host_down", { host: short(hostId) }); }
  });
  ws.on("error", () => ws.terminate());
}

function onClient(ws: WebSocket, req: IncomingMessage, hostId: string): void {
  const ip = clientIp(req);
  const n = clientsPerIp.get(ip) ?? 0;
  if (n >= 20) { ws.close(CLOSE.RATE_LIMITED, "too many connections"); return; }
  clientsPerIp.set(ip, n + 1);
  ws.on("close", () => { const m = (clientsPerIp.get(ip) ?? 1) - 1; if (m <= 0) clientsPerIp.delete(ip); else clientsPerIp.set(ip, m); });
  const host = hosts.get(hostId);
  if (!host) { ws.close(CLOSE.HOST_OFFLINE, "host offline"); return; }
  const connId = randomBytes(16).toString("base64url");
  const p: PendingClient = {
    ws, hostId, ip, buffered: [], bufferedBytes: 0,
    timer: setTimeout(() => { pending.delete(connId); ws.close(CLOSE.PAIR_TIMEOUT, "host did not answer"); }, 10_000),
  };
  pending.set(connId, p);
  const onMsg = (data: RawData, isBinary: boolean) => {
    const size = Buffer.isBuffer(data) ? data.length : Array.isArray(data) ? data.reduce((s, b) => s + b.length, 0) : (data as ArrayBuffer).byteLength;
    p.buffered.push({ data, isBinary });
    p.bufferedBytes += size;
    if (p.buffered.length > 64 || p.bufferedBytes > 1024 * 1024) ws.close(1009, "too much data before splice");
  };
  ws.on("message", onMsg);
  ws.on("close", () => { if (pending.get(connId) === p) { clearTimeout(p.timer); pending.delete(connId); } });
  ws.on("error", () => ws.terminate());
  (ws as WebSocket & { __onMsg?: typeof onMsg }).__onMsg = onMsg;
  host.control.send(JSON.stringify({ t: "client", connId }));
  log("client_open", { host: short(hostId), ip });
}

function onHostData(ws: WebSocket, req: IncomingMessage, hostId: string, connId: string): void {
  const p = pending.get(connId);
  if (!authorized(req) || !p || p.hostId !== hostId) { ws.close(1008, "unknown connection"); return; }
  pending.delete(connId);
  clearTimeout(p.timer);
  const client = p.ws;
  const onMsg = (client as WebSocket & { __onMsg?: (d: RawData, b: boolean) => void }).__onMsg;
  if (onMsg) client.off("message", onMsg);
  for (const f of p.buffered) ws.send(f.data, { binary: f.isBinary });
  client.on("message", (d, isBinary) => { if (ws.readyState === ws.OPEN) ws.send(d, { binary: isBinary }); });
  ws.on("message", (d, isBinary) => { if (client.readyState === client.OPEN) client.send(d, { binary: isBinary }); });
  const link = (a: WebSocket, b: WebSocket) => {
    a.on("close", (code, reason) => { if (b.readyState === b.OPEN || b.readyState === b.CONNECTING) b.close(passCode(code), reason.toString().slice(0, 120)); });
    a.on("error", () => { a.terminate(); b.terminate(); });
  };
  link(client, ws);
  link(ws, client);
  let closedLogged = false;
  const logClose = () => { if (!closedLogged) { closedLogged = true; log("client_closed", { host: short(hostId), ip: p.ip }); } };
  client.on("close", logClose);
  ws.on("close", logClose);
  log("client_spliced", { host: short(hostId), ip: p.ip });
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, hosts: hosts.size, pending: pending.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const url = new URL(req.url ?? "/", "http://relay");
  const hostId = url.searchParams.get("hostId") ?? "";
  const connId = url.searchParams.get("connId") ?? "";
  let handler: ((ws: WebSocket) => void) | undefined;
  if (url.pathname === RELAY_PATH_HOST_CONTROL) handler = (ws) => onHostControl(ws, req, hostId);
  else if (url.pathname === RELAY_PATH_CLIENT) handler = (ws) => onClient(ws, req, hostId);
  else if (url.pathname === RELAY_PATH_HOST_DATA) handler = (ws) => onHostData(ws, req, hostId, connId);
  if (!handler) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, handler);
});

server.listen(PORT, HOST, () => log("listening", { host: HOST, port: PORT }));
const stop = () => { log("stopping"); for (const h of hosts.values()) h.control.close(1001, "relay restarting"); server.close(); setTimeout(() => process.exit(0), 200); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
