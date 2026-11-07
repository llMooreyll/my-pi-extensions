import { existsSync, statSync } from "node:fs";
import { hostname } from "node:os";
import type { HostEndpoint } from "../../protocol/src/index.ts";
import { readJson, writeJsonAtomic } from "./fsutil.ts";
import type { Identity } from "./identity.ts";
import { CONFIG_FILE } from "./paths.ts";

export interface RelayConf { url: string; secret: string }
export interface DirectConf { enabled: boolean; listenHost: string; listenPort: number; advertise: string }
export interface Config {
  hostName: string;
  relays: RelayConf[];
  direct: DirectConf;
  tmuxSession: string;
  piCommand: string;
  spawnShell: string;
  snapshotMessages: number;
  ringSize: number;
}

export function defaultConfig(): Config {
  return {
    hostName: hostname(),
    relays: [],
    direct: { enabled: false, listenHost: "0.0.0.0", listenPort: 7444, advertise: "" },
    tmuxSession: "pi-remote",
    piCommand: "pi",
    spawnShell: "zsh",
    snapshotMessages: 200,
    ringSize: 5000,
  };
}

/** ws:// or wss:// base URL without path, query or fragment. */
export function validateWsBase(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`invalid URL: ${url}`); }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") throw new Error(`URL must start with ws:// or wss://: ${url}`);
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) throw new Error(`URL must not contain a path or query: ${url}`);
  return `${u.protocol}//${u.host}`;
}

const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

export function normalizeConfig(raw: unknown): Config {
  const d = defaultConfig();
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const relays: RelayConf[] = [];
  if (Array.isArray(r.relays)) {
    for (const x of r.relays) {
      const o = x as Record<string, unknown>;
      if (o && typeof o.url === "string" && typeof o.secret === "string") {
        try { relays.push({ url: validateWsBase(o.url), secret: o.secret }); } catch { /* skip invalid */ }
      }
    }
  }
  const dr = (r.direct && typeof r.direct === "object" ? r.direct : {}) as Record<string, unknown>;
  return {
    hostName: str(r.hostName, d.hostName),
    relays,
    direct: {
      enabled: bool(dr.enabled, d.direct.enabled),
      listenHost: str(dr.listenHost, d.direct.listenHost),
      listenPort: num(dr.listenPort, d.direct.listenPort),
      advertise: str(dr.advertise, d.direct.advertise),
    },
    tmuxSession: str(r.tmuxSession, d.tmuxSession),
    piCommand: str(r.piCommand, d.piCommand),
    spawnShell: str(r.spawnShell, d.spawnShell),
    snapshotMessages: num(r.snapshotMessages, d.snapshotMessages),
    ringSize: num(r.ringSize, d.ringSize),
  };
}

export function loadConfig(): Config {
  return normalizeConfig(readJson(CONFIG_FILE) ?? {});
}

export function saveConfig(c: Config): void { writeJsonAtomic(CONFIG_FILE, c); }

export function configMtime(): number {
  return existsSync(CONFIG_FILE) ? statSync(CONFIG_FILE).mtimeMs : 0;
}

export function endpoint(id: Identity | { hostId: string; publicKey: string }, c: Config): HostEndpoint {
  const direct = c.direct.enabled && c.direct.advertise ? c.direct.advertise : undefined;
  return { hostId: id.hostId, hostKey: id.publicKey, hostName: c.hostName, relays: c.relays.map((r) => r.url), ...(direct ? { direct } : {}) };
}
