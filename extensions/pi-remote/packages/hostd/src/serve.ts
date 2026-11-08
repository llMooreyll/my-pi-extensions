import { execFile } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { HOSTD_VERSION } from "../../protocol/src/index.ts";
import { startBridgeServer } from "./bridge-server.ts";
import { hub } from "./client-hub.ts";
import { configMtime, loadConfig, type Config } from "./config.ts";
import { devicesMtime } from "./devices.ts";
import { startDirectServer, type DirectServer } from "./direct-server.ts";
import { writeJsonAtomic } from "./fsutil.ts";
import { loadIdentity } from "./identity.ts";
import { enableFileLog, log } from "./log.ts";
import { STATE_DIR, STATUS_FILE } from "./paths.ts";
import { registry } from "./registry.ts";
import { startRelayClient, type RelayClient } from "./relay-client.ts";
import { runtime } from "./runtime.ts";
import { loadTransfers, onTransferChange, startTransferSweeper } from "./transfers.ts";

const SDK_VERSION = "1.5.0";

function cleanOldBridgeLogs(): void {
  try {
    const cutoff = Date.now() - 7 * 86_400_000;
    for (const f of readdirSync(STATE_DIR)) {
      if (!/^bridge-\d+\.log$/.test(f)) continue;
      const p = join(STATE_DIR, f);
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
    }
  } catch { /* state dir may not exist yet */ }
}

async function checkPiVersion(): Promise<void> {
  try {
    const { stdout } = await promisify(execFile)("pi", ["--version"], { timeout: 15_000 });
    const v = stdout.trim().split(/\s+/).pop();
    if (v !== SDK_VERSION) log.warn(`pi --version is ${v}, but hostd is built against SDK ${SDK_VERSION}`);
  } catch (e) { log.warn("could not run pi --version", (e as Error).message); }
}

export async function serve(): Promise<void> {
  enableFileLog();
  runtime.identity = loadIdentity();
  runtime.config = loadConfig();
  registry.ringSize = runtime.config.ringSize;
  log.info(`pi-hostd ${HOSTD_VERSION} starting; hostId ${runtime.identity.hostId}`);
  cleanOldBridgeLogs();
  void checkPiVersion();

  startBridgeServer();
  hub.start();
  onTransferChange((info) => hub.broadcastTransfer(info));
  try { loadTransfers(); } catch (e) { log.warn("could not load transfers", e); }
  startTransferSweeper();

  let relay: RelayClient | undefined;
  let direct: DirectServer | undefined;
  let relayKey = "";
  let directKey = "";
  const apply = (c: Config) => {
    const rk = JSON.stringify(c.relays[0] ?? null);
    if (rk !== relayKey) {
      relayKey = rk;
      relay?.stop(); relay = undefined;
      if (c.relays[0]) relay = startRelayClient(c.relays[0], runtime.identity.hostId);
    }
    const dk = JSON.stringify(c.direct.enabled ? [c.direct.listenHost, c.direct.listenPort] : null);
    if (dk !== directKey) {
      directKey = dk;
      direct?.close(); direct = undefined;
      if (c.direct.enabled) direct = startDirectServer(c.direct.listenHost, c.direct.listenPort);
    }
  };
  apply(runtime.config);

  let cfgM = configMtime();
  let devM = devicesMtime();
  const writeStatus = () => {
    try { writeJsonAtomic(STATUS_FILE, { relay: runtime.relayStatus, direct: runtime.directStatus, pid: process.pid, at: new Date().toISOString(), processes: registry.list().length, clients: hub.count }); } catch (e) { log.warn("status write", e); }
  };
  writeStatus();
  setInterval(() => {
    const m = configMtime();
    if (m !== cfgM) {
      cfgM = m;
      try { runtime.config = loadConfig(); apply(runtime.config); log.info("config reloaded"); } catch (e) { log.error("config reload failed", e); }
    }
    const d = devicesMtime();
    if (d !== devM) { devM = d; hub.enforceRevocations(); }
    writeStatus();
  }, 5_000);
  // Status should reflect relay changes quickly as well.
  setInterval(writeStatus, 1_000).unref();

  const shutdown = () => { log.info("shutting down"); relay?.stop(); direct?.close(); hub.stop(); setTimeout(() => process.exit(0), 200); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
