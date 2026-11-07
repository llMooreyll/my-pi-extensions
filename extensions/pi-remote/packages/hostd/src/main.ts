#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import qrcode from "qrcode-terminal";
import type { EndpointQr, PairQr } from "../../protocol/src/index.ts";
import { defaultConfig, endpoint, loadConfig, normalizeConfig, saveConfig, validateWsBase } from "./config.ts";
import { createPairingCode, loadDevices, revokeDevice, saveDevices, type Device } from "./devices.ts";
import { ensureDir, readJson, writeJsonAtomic } from "./fsutil.ts";
import { createIdentity, identityExists, loadIdentity, validateIdentity } from "./identity.ts";
import { CONFIG_DIR, CONFIG_FILE, IDENTITY_FILE, STATUS_FILE } from "./paths.ts";
import { serve } from "./serve.ts";

const USAGE = `usage: pi-hostd <command>
  init [--name <name>] [--force]
  serve
  relay set <ws(s)://host:port> --secret <secret>
  relay show
  relay remove
  direct enable --advertise <ws://ip:port> [--port 7444]
  direct disable
  pair [--json]
  qr [--json]
  devices list
  devices revoke <id>
  export <file>
  import <file> [--force] [--keep-name]`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) die(`${name} requires a value`);
  args.splice(i, 2);
  return v;
}
function has(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}
function die(msg: string): never { process.stderr.write(msg + "\n"); process.exit(1); }
const out = (s: string) => process.stdout.write(s + "\n");

async function confirmYes(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(prompt);
  rl.close();
  return a.trim() === "yes";
}

function printQr(json: string): Promise<void> {
  return new Promise((res) => qrcode.generate(json, { small: true }, (s) => { out(s); res(); }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  switch (cmd) {
    case "init": {
      const name = flag(args, "--name");
      const force = has(args, "--force");
      ensureDir(CONFIG_DIR);
      if (identityExists()) {
        if (!force) die(`identity already exists at ${IDENTITY_FILE}; use --force to replace it (all paired phones stop working)`);
        if (!(await confirmYes("This replaces the host identity and unpairs every phone. Type 'yes' to continue: "))) die("aborted");
        saveDevices([]);
      }
      const id = createIdentity();
      const cfg = existsSync(CONFIG_FILE) ? loadConfig() : defaultConfig();
      if (name) cfg.hostName = name;
      saveConfig(cfg);
      out(`initialized host ${id.hostId} (${cfg.hostName})\nconfig: ${CONFIG_DIR}`);
      return;
    }
    case "serve": await serve(); return;
    case "relay": {
      const sub = args.shift();
      const cfg = loadConfig();
      if (sub === "set") {
        const secret = flag(args, "--secret");
        const url = args.shift();
        if (!url || !secret) die("usage: pi-hostd relay set <ws(s)://host:port> --secret <secret>");
        let base: string;
        try { base = validateWsBase(url); } catch (e) { die((e as Error).message); }
        cfg.relays = [{ url: base, secret }];
        saveConfig(cfg);
        out(`relay set to ${base}`);
      } else if (sub === "show") {
        const st = readJson<{ relay: string; direct: string; at: string; pid: number }>(STATUS_FILE);
        out(`relay:  ${cfg.relays[0]?.url ?? "(none)"}`);
        out(`status: ${st ? st.relay : "hostd not running"}`);
        out(`direct: ${cfg.direct.enabled ? `${cfg.direct.listenHost}:${cfg.direct.listenPort} advertise=${cfg.direct.advertise || "(none)"}` : "disabled"}${st ? ` (${st.direct})` : ""}`);
        if (st) out(`updated: ${st.at} (hostd pid ${st.pid})`);
      } else if (sub === "remove") {
        cfg.relays = [];
        saveConfig(cfg);
        out("relay removed");
      } else die(USAGE);
      return;
    }
    case "direct": {
      const sub = args.shift();
      const cfg = loadConfig();
      if (sub === "enable") {
        const adv = flag(args, "--advertise");
        const port = flag(args, "--port");
        if (!adv) die("usage: pi-hostd direct enable --advertise <ws://ip:port> [--port 7444]");
        try { cfg.direct.advertise = validateWsBase(adv); } catch (e) { die((e as Error).message); }
        cfg.direct.enabled = true;
        if (port) cfg.direct.listenPort = Number(port);
        saveConfig(cfg);
        out(`direct enabled on ${cfg.direct.listenHost}:${cfg.direct.listenPort}, advertised as ${cfg.direct.advertise}`);
      } else if (sub === "disable") {
        cfg.direct.enabled = false;
        saveConfig(cfg);
        out("direct disabled");
      } else die(USAGE);
      return;
    }
    case "pair": {
      const json = has(args, "--json");
      const id = loadIdentity();
      const cfg = loadConfig();
      const ep = endpoint(id, cfg);
      if (!ep.relays.length && !ep.direct) die("configure a relay (pi-hostd relay set) or direct access (pi-hostd direct enable) first");
      const code = createPairingCode();
      const qr: PairQr = { v: 2, kind: "pair", ...ep, code };
      const text = JSON.stringify(qr);
      if (json) { out(text); return; }
      await printQr(text);
      out(`Pairing code: ${code} (valid for 10 minutes, single use)`);
      out(`Pairing info (paste into the app if you cannot scan):\n${text}`);
      return;
    }
    case "qr": {
      const json = has(args, "--json");
      const ep = endpoint(loadIdentity(), loadConfig());
      const qr: EndpointQr = { v: 2, kind: "endpoint", ...ep };
      const text = JSON.stringify(qr);
      if (json) { out(text); return; }
      await printQr(text);
      out(`Connection info:\n${text}`);
      return;
    }
    case "devices": {
      const sub = args.shift();
      if (sub === "list") {
        const ds = loadDevices();
        if (!ds.length) out("no paired devices");
        for (const d of ds) out(`${d.id}  ${d.name}  created ${d.createdAt}  last seen ${d.lastSeenAt ?? "never"}`);
      } else if (sub === "revoke") {
        const id = args.shift();
        if (!id) die("usage: pi-hostd devices revoke <id>");
        out(revokeDevice(id) ? `revoked ${id}` : `no device ${id}`);
      } else die(USAGE);
      return;
    }
    case "export": {
      const file = args.shift();
      if (!file) die("usage: pi-hostd export <file>");
      const identity = readJson(IDENTITY_FILE);
      if (!identity) die("no identity to export");
      writeJsonAtomic(file, { v: 1, identity, config: readJson(CONFIG_FILE) ?? defaultConfig(), devices: loadDevices() });
      out(`exported to ${file}`);
      out("WARNING: this file contains the host private key and the relay secret. Transfer it only over a secure channel and delete it after importing.");
      return;
    }
    case "import": {
      const force = has(args, "--force");
      const keepName = has(args, "--keep-name");
      const file = args.shift();
      if (!file) die("usage: pi-hostd import <file> [--force] [--keep-name]");
      const data = JSON.parse(readFileSync(file, "utf8")) as { v?: number; identity?: unknown; config?: unknown; devices?: unknown };
      if (data.v !== 1) die("unsupported export file version");
      const identity = validateIdentity(data.identity);
      const cfg = normalizeConfig(data.config);
      if (!Array.isArray(data.devices)) die("invalid export file: devices missing");
      const devices = (data.devices as Device[]).filter((d) => d && typeof d.id === "string" && typeof d.secretHash === "string");
      if (identityExists() && !force) die(`identity already exists at ${IDENTITY_FILE}; use --force to overwrite`);
      if (!keepName) cfg.hostName = hostname();
      ensureDir(CONFIG_DIR);
      writeJsonAtomic(IDENTITY_FILE, identity);
      saveConfig(cfg);
      saveDevices(devices);
      out(`imported host ${identity.hostId} with ${devices.length} device(s); restart pi-hostd to apply`);
      return;
    }
    default:
      out(USAGE);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exit(1);
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
