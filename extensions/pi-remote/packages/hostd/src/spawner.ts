import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, sep } from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Trust } from "../../protocol/src/index.ts";
import { err } from "./errors.ts";
import { log } from "./log.ts";
import { registry } from "./registry.ts";
import { runtime } from "./runtime.ts";
import { findSessionInfo } from "./sessions-index.ts";

const execFileP = promisify(execFile);
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const waiters = new Map<string, (processId: string) => void>();

export function notifySpawnToken(token: string, processId: string): void {
  waiters.get(token)?.(processId);
}

function waitForSpawnToken(token: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(token); reject(new Error("timeout")); }, timeoutMs);
    waiters.set(token, (pid) => { clearTimeout(timer); waiters.delete(token); resolve(pid); });
  });
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

export function validateCwd(cwd: string): string {
  if (!isAbsolute(cwd)) throw err("bad_request", "cwd must be an absolute path");
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw err("bad_request", `cwd is not a directory: ${cwd}`);
  const real = realpathSync(cwd);
  if (!isInside(real, realpathSync(homedir()))) throw err("bad_request", "cwd must be inside the home directory");
  return real;
}

async function ensureTmuxSession(name: string): Promise<void> {
  const ok = await execFileP("tmux", ["has-session", "-t", `=${name}`]).then(() => true, () => false);
  if (!ok) await execFileP("tmux", ["new-session", "-d", "-s", name, "-x", "220", "-y", "50", "-n", "hostd"]);
}

export async function spawnPi(opts: { cwd: string; sessionFile?: string; trust: Trust }): Promise<string> {
  const cfg = runtime.config;
  const cwd = validateCwd(opts.cwd);
  await ensureTmuxSession(cfg.tmuxSession);
  const token = randomUUID();
  const args = [cfg.piCommand, opts.trust === "approve" ? "--approve" : "--no-approve"];
  if (opts.sessionFile) args.push("--session", opts.sessionFile);
  // Keep the pane open for a while when pi fails to start, so spawn_timeout can report its output.
  const inner = `${args.map(shQuote).join(" ")} || { echo "[pi-remote] pi exited with code $?"; sleep 120; }`;
  const shellCmd = `${cfg.spawnShell} -lic ${shQuote(inner)}`;
  const windowName = basename(cwd).slice(0, 30) || "pi";
  const wait = waitForSpawnToken(token, 45_000);
  const { stdout } = await execFileP("tmux", [
    "new-window", "-d", "-P", "-F", "#{pane_id}",
    "-t", `=${cfg.tmuxSession}:`, "-n", windowName, "-c", cwd,
    "-e", `PI_REMOTE_SPAWN_TOKEN=${token}`, shellCmd,
  ]);
  const paneId = stdout.trim();
  log.info("spawned pi", paneId, cwd, opts.sessionFile ?? "(new session)");
  try {
    return await wait;
  } catch {
    const tail = await execFileP("tmux", ["capture-pane", "-p", "-t", paneId, "-S", "-20"]).then((r) => r.stdout.trimEnd(), () => "(pane is gone)");
    await execFileP("tmux", ["kill-pane", "-t", paneId]).catch(() => {});
    throw err("spawn_timeout", `pi did not register within 45s. tmux pane ${paneId} last lines:\n${tail}`);
  }
}

export async function openSession(sessionFile: string, trust: Trust): Promise<{ processId: string; spawned: boolean }> {
  const live = registry.findBySessionFile(sessionFile);
  if (live) return { processId: live.info.processId, spawned: false };
  if (!sessionFile.endsWith(".jsonl") || !existsSync(sessionFile)) throw err("bad_request", "sessionFile must be an existing .jsonl file");
  const sessionsRoot = realpathSync(join(getAgentDir(), "sessions"));
  if (!isInside(realpathSync(sessionFile), sessionsRoot)) throw err("bad_request", "sessionFile must be inside the pi sessions directory");
  const info = await findSessionInfo(sessionFile);
  const cwd = info?.cwd;
  if (!cwd || !existsSync(cwd)) throw err("bad_request", `session cwd is missing or no longer exists: ${cwd || "(empty)"}`);
  const processId = await spawnPi({ cwd, sessionFile, trust });
  return { processId, spawned: true };
}
