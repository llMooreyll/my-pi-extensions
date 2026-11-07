import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import { DIRECT_PATH_CLIENT } from "../../protocol/src/index.ts";
import { hub } from "./client-hub.ts";
import { log } from "./log.ts";
import { runtime } from "./runtime.ts";
import { secureServerSocket } from "./secure-socket.ts";

export interface DirectServer { close(): void }

export function startDirectServer(host: string, port: number): DirectServer {
  const perIp = new Map<string, number>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const server: Server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); return; }
    res.writeHead(404); res.end();
  });
  server.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "").split("?")[0];
    const ip = req.socket.remoteAddress ?? "?";
    if (path !== DIRECT_PATH_CLIENT || (perIp.get(ip) ?? 0) >= 10) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      ws.on("close", () => { const n = (perIp.get(ip) ?? 1) - 1; if (n <= 0) perIp.delete(ip); else perIp.set(ip, n); });
      secureServerSocket(ws, runtime.identity.keyPair, `direct:${ip}`)
        .then((sock) => hub.accept(sock))
        .catch((e) => log.info("direct handshake failed", ip, (e as Error).message));
    });
  });
  server.on("error", (e) => { log.error("direct server error", e); runtime.directStatus = "off"; });
  server.listen(port, host, () => { runtime.directStatus = "listening"; log.info(`direct listening on ${host}:${port}`); });
  return {
    close() {
      runtime.directStatus = "off";
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.close();
    },
  };
}
