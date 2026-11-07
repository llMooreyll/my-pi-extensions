import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { AUDIT_FILE, STATE_DIR } from "./paths.ts";
import { log } from "./log.ts";

export interface AuditRecord { deviceId?: string; op: string; processId?: string; summary?: string; remote?: string }

export function audit(r: AuditRecord): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    if (existsSync(AUDIT_FILE) && statSync(AUDIT_FILE).size > 20 * 1024 * 1024) renameSync(AUDIT_FILE, AUDIT_FILE + ".1");
    appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...r }) + "\n", { mode: 0o600 });
  } catch (e) { log.warn("audit write failed", e); }
}
