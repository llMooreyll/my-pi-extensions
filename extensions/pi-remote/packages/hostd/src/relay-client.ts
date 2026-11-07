import WebSocket from "ws";
import { CLOSE, RELAY_PATH_HOST_CONTROL, RELAY_PATH_HOST_DATA, type RelayToHost } from "../../protocol/src/index.ts";
import type { RelayConf } from "./config.ts";
import { hub } from "./client-hub.ts";
import { log } from "./log.ts";
import { runtime } from "./runtime.ts";
import { secureServerSocket } from "./secure-socket.ts";

export interface RelayClient { stop(): void }

export function startRelayClient(relay: RelayConf, hostId: string): RelayClient {
  let stopped = false;
  let ws: WebSocket | undefined;
  let backoff = 1000;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let lastFrameAt = 0;
  const headers = { authorization: `Bearer ${relay.secret}` };
  const q = `?hostId=${encodeURIComponent(hostId)}`;

  const schedule = (ms: number) => {
    if (stopped) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, ms);
  };

  const openData = (connId: string) => {
    const data = new WebSocket(`${relay.url}${RELAY_PATH_HOST_DATA}${q}&connId=${encodeURIComponent(connId)}`, { headers, maxPayload: 16 * 1024 * 1024 });
    data.on("error", (e) => log.warn("relay data error", connId.slice(0, 6), e.message));
    data.once("open", () => {
      secureServerSocket(data, runtime.identity.keyPair, `relay:${connId.slice(0, 6)}`)
        .then((sock) => hub.accept(sock))
        .catch((e) => log.info("relay handshake failed", connId.slice(0, 6), (e as Error).message));
    });
  };

  function connect(): void {
    if (stopped) return;
    if (runtime.relayStatus !== "auth_failed") runtime.relayStatus = "connecting";
    const sock = new WebSocket(`${relay.url}${RELAY_PATH_HOST_CONTROL}${q}`, { headers, handshakeTimeout: 15_000 });
    ws = sock;
    let authFailed = false;
    sock.on("open", () => {
      runtime.relayStatus = "connected";
      backoff = 1000;
      lastFrameAt = Date.now();
      log.info("relay connected", relay.url);
    });
    sock.on("message", (raw) => {
      lastFrameAt = Date.now();
      let f: RelayToHost;
      try { f = JSON.parse(raw.toString()) as RelayToHost; } catch { return; }
      if (f.t === "ping") sock.send(JSON.stringify({ t: "pong", ts: f.ts }));
      else if (f.t === "client" && typeof f.connId === "string") openData(f.connId);
    });
    sock.on("close", (code) => {
      if (ws !== sock) return;
      ws = undefined;
      if (stopped) return;
      if (code === CLOSE.BAD_RELAY_SECRET) authFailed = true;
      runtime.relayStatus = authFailed ? "auth_failed" : "connecting";
      const delay = authFailed ? 60_000 : backoff;
      if (!authFailed) backoff = Math.min(backoff * 2, 30_000);
      log.warn(`relay disconnected (code ${code}); retry in ${delay}ms`);
      schedule(delay);
    });
    sock.on("error", (e) => log.debug("relay control error", e.message));
  }

  watchdog = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastFrameAt > 60_000) { log.warn("relay silent for 60s, reconnecting"); ws.terminate(); }
  }, 10_000);
  connect();
  return {
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(watchdog);
      runtime.relayStatus = "off";
      ws?.close(1000, "stop");
      ws = undefined;
    },
  };
}
