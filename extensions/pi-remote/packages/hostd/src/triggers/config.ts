import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { STATE_DIR } from "../paths.ts";
import type { HubConfig, Route, SourceConf, WebhookConf } from "./types.ts";

/** Shared with the pi-trigger extension: ~/.pi/agent/pi-trigger/. */
export const TRIGGER_DIR = join(getAgentDir(), "pi-trigger");
export const HUB_CONFIG_FILE = join(TRIGGER_DIR, "hub.json");
/** Written by pi-trigger, one file per session. */
export const SESSION_STATES_DIR = join(TRIGGER_DIR, "sessions");
/** Always watched; `pi-hostd trigger send` writes here. */
export const DROP_DIR = join(TRIGGER_DIR, "drop");
export const DROP_SOURCE = "drop";
export const HUB_STORE_FILE = join(STATE_DIR, "triggers", "store.json");

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function hubConfigMtime(): number {
  return existsSync(HUB_CONFIG_FILE) ? statSync(HUB_CONFIG_FILE).mtimeMs : 0;
}

export function defaultHubConfig(): HubConfig {
  return {
    enabled: true,
    trust: "deny",
    webhook: { enabled: false, host: "127.0.0.1", port: 7450, token: "" },
    sources: [{ name: DROP_SOURCE, type: "dir", path: DROP_DIR }],
    routes: [],
  };
}

/** Invalid entries are skipped and reported in `problems`; a missing file gives the defaults. */
export function loadHubConfig(): { config: HubConfig; problems: string[] } {
  const config = defaultHubConfig();
  const problems: string[] = [];
  if (!existsSync(HUB_CONFIG_FILE)) return { config, problems };
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(HUB_CONFIG_FILE, "utf8"));
    if (!isRecord(parsed)) throw new Error("expected a JSON object");
    raw = parsed;
  } catch (e) {
    problems.push(`${HUB_CONFIG_FILE}: ${(e as Error).message}; using defaults`);
    return { config, problems };
  }

  if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
  if (raw.trust === "approve" || raw.trust === "deny") config.trust = raw.trust;
  else if (raw.trust !== undefined) problems.push(`trust must be "approve" or "deny"`);
  config.webhook = webhookConf(raw.webhook, config.webhook, problems);

  const names = new Set([DROP_SOURCE]);
  if (Array.isArray(raw.sources)) {
    for (const [i, entry] of raw.sources.entries()) {
      try {
        const source = sourceConf(entry);
        if (names.has(source.name)) throw new Error(`duplicate source name "${source.name}"`);
        names.add(source.name);
        config.sources.push(source);
      } catch (e) { problems.push(`sources[${i}]: ${(e as Error).message}`); }
    }
  } else if (raw.sources !== undefined) problems.push("sources must be an array");

  const ids = new Set<string>();
  if (Array.isArray(raw.routes)) {
    for (const [i, entry] of raw.routes.entries()) {
      try {
        const route = routeConf(entry);
        if (ids.has(route.id)) throw new Error(`duplicate route id "${route.id}"`);
        ids.add(route.id);
        config.routes.push(route);
      } catch (e) { problems.push(`routes[${i}]: ${(e as Error).message}`); }
    }
  } else if (raw.routes !== undefined) problems.push("routes must be an array");
  return { config, problems };
}

function webhookConf(raw: unknown, d: WebhookConf, problems: string[]): WebhookConf {
  if (raw === undefined) return d;
  if (!isRecord(raw)) { problems.push("webhook must be an object"); return d; }
  const conf: WebhookConf = {
    enabled: raw.enabled === true,
    host: typeof raw.host === "string" && raw.host ? raw.host : d.host,
    port: typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : d.port,
    token: typeof raw.token === "string" ? raw.token : "",
  };
  if (conf.enabled && conf.token.length < 16) {
    problems.push("webhook.token must have at least 16 characters; webhook disabled");
    conf.enabled = false;
  }
  return conf;
}

function sourceConf(raw: unknown): SourceConf {
  if (!isRecord(raw)) throw new Error("expected an object");
  const name = raw.name;
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) throw new Error("name must be 1-40 letters, digits, - or _");
  switch (raw.type) {
    case "dir":
      return { name, type: "dir", path: absolutePath(raw.path, "path") };
    case "exec": {
      const command = raw.command;
      if (!Array.isArray(command) || command.length === 0 || !command.every((c) => typeof c === "string")) {
        throw new Error("command must be a non-empty array of strings");
      }
      const intervalSec = optionalSeconds(raw.intervalSec, "intervalSec", 10);
      return {
        name, type: "exec",
        command: [expandHome(command[0] as string), ...(command.slice(1) as string[]).map(expandHome)],
        ...(raw.cwd !== undefined ? { cwd: absolutePath(raw.cwd, "cwd") } : {}),
        ...(intervalSec !== undefined ? { intervalSec } : {}),
        restartSec: optionalSeconds(raw.restartSec, "restartSec", 1) ?? 30,
        timeoutSec: optionalSeconds(raw.timeoutSec, "timeoutSec", 1) ?? 300,
      };
    }
    case "module":
      return { name, type: "module", path: absolutePath(raw.path, "path"), options: isRecord(raw.options) ? raw.options : {} };
    default:
      throw new Error(`type must be "dir", "exec" or "module"`);
  }
}

function routeConf(raw: unknown): Route {
  if (!isRecord(raw)) throw new Error("expected an object");
  const id = raw.id;
  if (typeof id !== "string" || !NAME_PATTERN.test(id)) throw new Error("id must be 1-40 letters, digits, - or _");
  const target = raw.target;
  if (typeof target !== "string" || !isTarget(target)) throw new Error(`target must be "@alias" or an absolute .jsonl session file`);
  const matchRaw = isRecord(raw.match) ? raw.match : {};
  let match: RegExp | undefined;
  if (matchRaw.text !== undefined) {
    if (typeof matchRaw.text !== "string") throw new Error("match.text must be a string");
    try { match = new RegExp(matchRaw.text, "i"); } catch (e) { throw new Error(`match.text: ${(e as Error).message}`); }
  }
  const allowed = raw.allowedTools;
  if (allowed !== undefined && (!Array.isArray(allowed) || !allowed.every((t) => typeof t === "string"))) {
    throw new Error("allowedTools must be an array of tool names");
  }
  return {
    id,
    source: patterns(matchRaw.source, "match.source"),
    kind: patterns(matchRaw.kind, "match.kind"),
    ...(match ? { match } : {}),
    target: target.startsWith("@") ? target : expandHome(target),
    ...(typeof raw.instruction === "string" && raw.instruction.trim() ? { instruction: raw.instruction.trim() } : {}),
    wake: raw.wake !== false,
    batchWindowSec: optionalSeconds(raw.batchWindowSec, "batchWindowSec", 0) ?? 0,
    maxPerHour: optionalSeconds(raw.maxPerHour, "maxPerHour", 0) ?? 0,
    ...(allowed ? { allowedTools: allowed as string[] } : {}),
    trusted: raw.trusted === true,
  };
}

export function isTarget(target: string): boolean {
  if (target.startsWith("@")) return /^@[a-z0-9][a-z0-9-]{0,39}$/.test(target);
  const path = expandHome(target);
  return isAbsolute(path) && path.endsWith(".jsonl");
}

function patterns(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || !list.every((v) => typeof v === "string")) throw new Error(`${name} must be a string or an array of strings`);
  return list as string[];
}

function absolutePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
  const path = expandHome(value);
  if (!isAbsolute(path)) throw new Error(`${name} must be absolute or start with ~/`);
  return resolve(path);
}

function optionalSeconds(value: unknown, name: string, min: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) throw new Error(`${name} must be a number ≥ ${min}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
