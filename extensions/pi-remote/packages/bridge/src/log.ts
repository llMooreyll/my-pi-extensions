import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Never write to stdout/stderr here: it would corrupt the pi TUI.
const DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi-remote");
const FILE = join(DIR, `bridge-${process.pid}.log`);
let ready = false;

function write(level: string, msg: string): void {
  try {
    if (!ready) { mkdirSync(DIR, { recursive: true, mode: 0o700 }); ready = true; }
    try { if (statSync(FILE).size > 5 * 1024 * 1024) writeFileSync(FILE, ""); } catch { /* missing */ }
    appendFileSync(FILE, `${new Date().toISOString()} ${level} ${msg}\n`);
  } catch { /* logging must never throw */ }
}

const fmt = (e: unknown) => (e instanceof Error ? e.stack ?? e.message : typeof e === "string" ? e : (() => { try { return JSON.stringify(e); } catch { return String(e); } })());

export const logInfo = (msg: string) => write("INFO", msg);
export const logWarn = (msg: string) => write("WARN", msg);
export const logError = (where: string, e: unknown) => write("ERROR", `${where}: ${fmt(e)}`);
