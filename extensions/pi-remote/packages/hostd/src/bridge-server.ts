import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { PROTOCOL_VERSION, type BridgeToHost, type ProcessInfo } from "../../protocol/src/index.ts";
import { hub } from "./client-hub.ts";
import { recompute } from "./links.ts";
import { log } from "./log.ts";
import { NdjsonDecoder } from "./ndjson.ts";
import { BRIDGE_SOCKET, RUNTIME_DIR } from "./paths.ts";
import { BridgeConn, registry, withActivity } from "./registry.ts";
import { notifySpawnToken } from "./spawner.ts";

function relink(): void {
  for (const info of recompute()) hub.broadcastProc("changed", info);
}

export function startBridgeServer(): Server {
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  if (existsSync(BRIDGE_SOCKET)) unlinkSync(BRIDGE_SOCKET);
  const server = createServer((socket) => {
    const conn = new BridgeConn(socket);
    let gone = false;
    const onGone = () => {
      if (gone) return;
      gone = true;
      conn.failAll();
      const id = conn.processId;
      if (!id) return;
      const e = registry.get(id);
      if (!e || e.conn !== conn) return;   // already replaced by a newer connection of the same process
      registry.remove(id);
      log.info("bridge down", id, e.info.pid);
      hub.broadcastProc("down", e.info);
      relink();
    };
    const decoder = new NdjsonDecoder((v) => {
      try { onFrame(v as BridgeToHost); } catch (e) { log.warn("bridge frame error", e); }
    }, (e, line) => log.warn("bad bridge line", (e as Error).message, line.slice(0, 200)));
    const onFrame = (f: BridgeToHost) => {
      switch (f.t) {
        case "hello": {
          if (f.protocol !== PROTOCOL_VERSION) { log.warn("bridge protocol mismatch", f.protocol); socket.destroy(); return; }
          conn.processId = f.info.processId;
          conn.send({ t: "welcome", protocol: PROTOCOL_VERSION });
          const existed = !!registry.get(f.info.processId);
          const e = registry.upsert(f.info.processId, conn, f.info);
          log.info("bridge up", f.info.processId, f.info.pid, f.info.cwd, existed ? "(reconnect)" : "");
          hub.broadcastProc(existed ? "changed" : "up", e.info);
          if (f.spawnToken) notifySpawnToken(f.spawnToken, f.info.processId);
          relink();
          return;
        }
        case "ev": {
          const e = registry.get(f.processId);
          if (!e || e.conn !== conn) return;
          e.ring.push(f.seq, f.ev);
          e.info.lastSeq = f.seq;
          if (f.ev.type === "info" || f.ev.type === "session_changed") {
            const parent = e.info.parentProcessId;
            e.info = withActivity({ ...(f.ev.info as ProcessInfo), lastSeq: f.seq });
            if (parent) e.info.parentProcessId = parent;
            relink();
            hub.broadcastProc("changed", e.info);
          }
          hub.dispatchEvent(f.processId, f.seq, f.ev);
          return;
        }
        case "res": conn.settle(f.id, f.ok, f.ok ? f.data : f.error); return;
        case "bye": onGone(); socket.end(); return;
      }
    };
    socket.on("data", (d) => decoder.push(d));
    socket.on("close", onGone);
    socket.on("error", (e) => log.debug("bridge socket error", e.message));
  });
  server.listen(BRIDGE_SOCKET, () => { chmodSync(BRIDGE_SOCKET, 0o600); log.info("bridge socket listening", BRIDGE_SOCKET); });
  return server;
}
