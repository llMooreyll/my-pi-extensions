import { existsSync, statSync } from "node:fs";
import { hostname } from "node:os";
import type { HostEndpoint } from "../../protocol/src/index.ts";
import { readJson, writeJsonAtomic } from "./fsutil.ts";
import type { Identity } from "./identity.ts";
import { CONFIG_FILE } from "./paths.ts";

export interface RelayConf { url: string; secret: string }
export interface DirectConf { enabled: boolean; listenHost: string; listenPort: number; advertise: string }
export interface FilesConf { inboxDir: string; maxFileBytes: number; offerTtlHours: number; denyPaths: string[] }
export interface Config {
  hostName: string;
  relays: RelayConf[];
  direct: DirectConf;
  tmuxSession: string;
  piCommand: string;
  spawnShell: string;
  snapshotMessages: number;
  ringSize: number;
  files: FilesConf;
}

/** Folders are packed without zip64, so one transfer stays below 4 GiB. */
export const MAX_FILE_BYTES_CAP = 4 * 1024 * 1024 * 1024 - 64 * 1024 * 1024;

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
    files: { inboxDir: "~/Downloads/pi-remote", maxFileBytes: 2 * 1024 * 1024 * 1024, offerTtlHours: 168, denyPaths: [] },
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
    files: normalizeFiles(r.files, d.files),
  };
}

function normalizeFiles(raw: unknown, d: FilesConf): FilesConf {
  const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const max = Math.min(Math.max(num(f.maxFileBytes, d.maxFileBytes), 1), MAX_FILE_BYTES_CAP);
  return {
    inboxDir: str(f.inboxDir, d.inboxDir) || d.inboxDir,
    maxFileBytes: Math.floor(max),
    offerTtlHours: Math.max(num(f.offerTtlHours, d.offerTtlHours), 1),
    denyPaths: Array.isArray(f.denyPaths) ? f.denyPaths.filter((x): x is string => typeof x === "string") : [],
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
