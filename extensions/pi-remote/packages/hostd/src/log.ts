import { appendFileSync, mkdirSync } from "node:fs";
import { HOSTD_LOG, STATE_DIR } from "./paths.ts";

let toFile = false;

export function enableFileLog(): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  toFile = true;
}

function fmt(a: unknown): string {
  if (a instanceof Error) return a.stack ?? a.message;
  if (typeof a === "string") return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

function write(level: string, args: unknown[]): void {
  const line = `${new Date().toISOString()} ${level} ${args.map(fmt).join(" ")}`;
  process.stderr.write(line + "\n");
  if (toFile) { try { appendFileSync(HOSTD_LOG, line + "\n"); } catch { /* ignore */ } }
}

export const log = {
  debug: (...a: unknown[]) => { if (process.env.PI_REMOTE_DEBUG) write("DEBUG", a); },
  info: (...a: unknown[]) => write("INFO", a),
  warn: (...a: unknown[]) => write("WARN", a),
  error: (...a: unknown[]) => write("ERROR", a),
};
