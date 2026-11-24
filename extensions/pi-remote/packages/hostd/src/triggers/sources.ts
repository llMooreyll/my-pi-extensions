import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, type FSWatcher } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { log } from "../log.ts";
import type { SourceConf, WebhookConf } from "./types.ts";

/** `origin` is the configured source name; `raw` is whatever the source produced, validated by the hub. */
export type Emit = (origin: string, raw: unknown) => void;

export interface RunningSource { name: string; stop(): void }

const DIR_SCAN_MS = 10_000;
/** Files younger than this may still be written by someone not using write-then-rename. */
const DIR_SETTLE_MS = 1_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const WEBHOOK_MAX_BODY = 1024 * 1024;
const EXEC_MAX_BACKOFF_SEC = 600;

export function startSource(conf: SourceConf, emit: Emit): RunningSource {
  switch (conf.type) {
    case "dir": return startDirSource(conf.name, conf.path, emit);
    case "exec": return startExecSource(conf, emit);
    case "module": return startModuleSource(conf, emit);
  }
}

/** Text files become events titled by their first line; JSON files hold one event or an array of events. */
export function eventsFromFile(name: string, content: string): unknown[] {
  if (extname(name).toLowerCase() === ".json") {
    const parsed: unknown = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  return [{ ...textEvent(content, name), kind: "file", data: { file: name } }];
}

function textEvent(content: string, fallbackTitle: string): { kind: string; title: string; text: string } {
  const title = content.split("\n").map((l) => l.trim()).find(Boolean) ?? fallbackTitle;
  return { kind: "text", title: title.slice(0, 200), text: content };
}

function startDirSource(name: string, dir: string, emit: Emit): RunningSource {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let scanning = false;
  const scan = () => {
    if (scanning) return;
    scanning = true;
    try {
      for (const file of readdirSync(dir)) {
        if (file.startsWith(".") || file.endsWith(".tmp")) continue;
        const path = join(dir, file);
        try {
          const st = statSync(path);
          if (!st.isFile() || Date.now() - st.mtimeMs < DIR_SETTLE_MS) continue;
          const content = st.size > MAX_FILE_BYTES ? undefined : readFileSync(path, "utf8");
          rmSync(path, { force: true });
          if (content === undefined) { log.warn(`triggers: ${name}: ${file} is larger than 1 MiB; deleted`); continue; }
          for (const raw of eventsFromFile(file, content)) emit(name, raw);
        } catch (e) {
          log.warn(`triggers: ${name}: could not read ${file}: ${(e as Error).message}`);
          rmSync(path, { force: true });
        }
      }
    } catch (e) {
      log.warn(`triggers: ${name}: scan failed: ${(e as Error).message}`);
    } finally {
      scanning = false;
    }
  };
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(dir, () => {
      clearTimeout(debounce);
      debounce = setTimeout(scan, DIR_SETTLE_MS + 100);
    });
    watcher.on("error", (e) => log.warn(`triggers: ${name}: watch error: ${e.message}`));
  } catch (e) {
    log.warn(`triggers: ${name}: cannot watch ${dir}, scanning every ${DIR_SCAN_MS / 1000}s: ${(e as Error).message}`);
  }
  const interval = setInterval(scan, DIR_SCAN_MS);
  scan();
  log.info(`triggers: source ${name} watching ${dir}`);
  return {
    name,
    stop() { clearInterval(interval); clearTimeout(debounce); watcher?.close(); },
  };
}

/** Each stdout line holding a JSON object is one event; stderr goes to the hostd log. */
function startExecSource(conf: Extract<SourceConf, { type: "exec" }>, emit: Emit): RunningSource {
  let stopped = false;
  let child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let backoffSec = conf.restartSec;

  const run = () => {
    if (stopped || child) return;
    const startedAt = Date.now();
    let proc: ChildProcess;
    try {
      proc = spawn(conf.command[0]!, conf.command.slice(1), {
        cwd: conf.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_TRIGGER_SOURCE: conf.name },
      });
    } catch (e) {
      log.warn(`triggers: ${conf.name}: cannot start: ${(e as Error).message}`);
      scheduleNext(false);
      return;
    }
    child = proc;
    const kill = conf.intervalSec !== undefined
      ? setTimeout(() => { log.warn(`triggers: ${conf.name}: still running after ${conf.timeoutSec}s; killed`); proc.kill("SIGTERM"); }, conf.timeoutSec * 1000)
      : undefined;
    lines(proc.stdout!, (line) => {
      if (!line.trim()) return;
      try { emit(conf.name, JSON.parse(line)); } catch (e) { log.warn(`triggers: ${conf.name}: bad output line: ${(e as Error).message}: ${line.slice(0, 200)}`); }
    });
    lines(proc.stderr!, (line) => { if (line.trim()) log.info(`triggers: ${conf.name}: ${line.slice(0, 500)}`); });
    proc.on("error", (e) => log.warn(`triggers: ${conf.name}: ${e.message}`));
    proc.on("close", (code, signal) => {
      clearTimeout(kill);
      child = undefined;
      if (stopped) return;
      const quick = Date.now() - startedAt < 10_000;
      if (conf.intervalSec === undefined) log.warn(`triggers: ${conf.name}: exited (${signal ?? code}); restarting`);
      else if (code !== 0) log.warn(`triggers: ${conf.name}: exited with ${signal ?? code}`);
      scheduleNext(quick && code !== 0);
    });
  };

  const scheduleNext = (failedFast: boolean) => {
    if (stopped) return;
    let delaySec: number;
    if (conf.intervalSec !== undefined) delaySec = conf.intervalSec;
    else {
      backoffSec = failedFast ? Math.min(backoffSec * 2, EXEC_MAX_BACKOFF_SEC) : conf.restartSec;
      delaySec = backoffSec;
    }
    timer = setTimeout(run, delaySec * 1000);
  };

  run();
  log.info(`triggers: source ${conf.name} running ${conf.command.join(" ")}${conf.intervalSec !== undefined ? ` every ${conf.intervalSec}s` : ""}`);
  return {
    name: conf.name,
    stop() { stopped = true; clearTimeout(timer); child?.kill("SIGTERM"); },
  };
}

function lines(stream: Readable, onLine: (line: string) => void): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      onLine(buffer.slice(0, index).replace(/\r$/, ""));
      buffer = buffer.slice(index + 1);
    }
    if (buffer.length > MAX_LINE_BYTES) { log.warn("triggers: output line over 1 MiB dropped"); buffer = ""; }
  });
  stream.on("end", () => { if (buffer) onLine(buffer); buffer = ""; });
}

/**
 * A module exporting `start(ctx)` (or a default function) that calls `ctx.emit(event)` and may return a
 * stop function. Runs inside pi-hostd, so it should not block or throw.
 */
function startModuleSource(conf: Extract<SourceConf, { type: "module" }>, emit: Emit): RunningSource {
  const abort = new AbortController();
  let stopFn: (() => void) | undefined;
  const ctx = {
    name: conf.name,
    options: conf.options,
    signal: abort.signal,
    emit: (raw: unknown) => { if (!abort.signal.aborted) emit(conf.name, raw); },
    log: {
      info: (...a: unknown[]) => log.info(`triggers: ${conf.name}:`, ...a),
      warn: (...a: unknown[]) => log.warn(`triggers: ${conf.name}:`, ...a),
      error: (...a: unknown[]) => log.error(`triggers: ${conf.name}:`, ...a),
    },
  };
  import(pathToFileURL(conf.path).href).then(async (mod: { start?: unknown; default?: unknown }) => {
    const start = typeof mod.start === "function" ? mod.start : mod.default;
    if (typeof start !== "function") throw new Error("the module exports neither start() nor a default function");
    const result: unknown = await start(ctx);
    if (typeof result === "function") {
      if (abort.signal.aborted) (result as () => void)();
      else stopFn = result as () => void;
    }
    log.info(`triggers: source ${conf.name} started from ${conf.path}`);
  }).catch((e: unknown) => log.error(`triggers: ${conf.name}: ${(e as Error)?.message ?? String(e)}`));
  return {
    name: conf.name,
    stop() {
      abort.abort();
      try { stopFn?.(); } catch (e) { log.warn(`triggers: ${conf.name}: stop failed: ${(e as Error).message}`); }
    },
  };
}

/** POST a JSON event (or array), or plain text, with `Authorization: Bearer <token>` or `?token=`. */
export function startWebhook(conf: WebhookConf, emit: Emit): RunningSource {
  const server: Server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "POST" || (url.pathname !== "/" && url.pathname !== "/event")) { reply(404, { error: "POST /event" }); return; }
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("token") ?? "";
    if (token !== conf.token) { reply(401, { error: "unauthorized" }); return; }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > WEBHOOK_MAX_BODY) { reply(413, { error: "body over 1 MiB" }); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > WEBHOOK_MAX_BODY) return;
      const body = Buffer.concat(chunks).toString("utf8");
      try {
        const isJson = (req.headers["content-type"] ?? "").includes("json");
        const events = isJson ? eventsFromFile("body.json", body) : [textEvent(body, "webhook")];
        for (const raw of events) emit("webhook", raw);
        reply(202, { accepted: events.length });
      } catch (e) {
        reply(400, { error: (e as Error).message });
      }
    });
  });
  server.on("error", (e) => log.error(`triggers: webhook: ${e.message}`));
  server.listen(conf.port, conf.host, () => log.info(`triggers: webhook listening on http://${conf.host}:${conf.port}/event`));
  return { name: "webhook", stop() { server.close(); } };
}
