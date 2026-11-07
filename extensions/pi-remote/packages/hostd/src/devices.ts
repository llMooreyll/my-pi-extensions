import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { readJson, writeJsonAtomic } from "./fsutil.ts";
import { DEVICES_FILE, PAIRING_FILE } from "./paths.ts";

export interface Device { id: string; name: string; secretHash: string; createdAt: string; lastSeenAt?: string }
interface DevicesFile { devices: Device[] }
interface PairingFile { codeHash: string; expiresAt: string; failures: number }

export const PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const normalizeCode = (c: string) => c.replace(/[-\s]/g, "").toUpperCase();

export function loadDevices(): Device[] {
  return readJson<DevicesFile>(DEVICES_FILE)?.devices ?? [];
}
export function saveDevices(devices: Device[]): void { writeJsonAtomic(DEVICES_FILE, { devices }); }
export function devicesMtime(): number { return existsSync(DEVICES_FILE) ? statSync(DEVICES_FILE).mtimeMs : 0; }

export function verifyDevice(deviceId: string, secret: string): Device | undefined {
  const d = loadDevices().find((x) => x.id === deviceId);
  if (!d || typeof secret !== "string") return undefined;
  const a = Buffer.from(sha256(secret), "hex");
  const b = Buffer.from(d.secretHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b) ? d : undefined;
}

export function touchDevice(deviceId: string): void {
  const all = loadDevices();
  const d = all.find((x) => x.id === deviceId);
  if (!d) return;
  d.lastSeenAt = new Date().toISOString();
  saveDevices(all);
}

export function revokeDevice(id: string): boolean {
  const all = loadDevices();
  const next = all.filter((d) => d.id !== id);
  if (next.length === all.length) return false;
  saveDevices(next);
  return true;
}

/** Creates a new one-time pairing code (valid 10 minutes). Returns it as XXXX-XXXX. */
export function createPairingCode(): string {
  const bytes = randomBytes(8);
  let raw = "";
  for (const b of bytes) raw += PAIR_ALPHABET[b % PAIR_ALPHABET.length];
  const file: PairingFile = { codeHash: sha256(raw), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), failures: 0 };
  writeJsonAtomic(PAIRING_FILE, file);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Returns credentials on success, undefined on failure. Not reentrant: callers serialize. */
export function consumePairing(code: string, deviceName: string): { deviceId: string; secret: string } | undefined {
  const p = readJson<PairingFile>(PAIRING_FILE);
  if (!p) return undefined;
  if (Date.parse(p.expiresAt) < Date.now()) { rmSync(PAIRING_FILE, { force: true }); return undefined; }
  const a = Buffer.from(sha256(normalizeCode(String(code))), "hex");
  const b = Buffer.from(p.codeHash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    p.failures += 1;
    if (p.failures >= 10) rmSync(PAIRING_FILE, { force: true });
    else writeJsonAtomic(PAIRING_FILE, p);
    return undefined;
  }
  rmSync(PAIRING_FILE, { force: true });
  const secret = randomBytes(32).toString("base64url");
  const device: Device = { id: randomUUID(), name: String(deviceName).slice(0, 100) || "device", secretHash: sha256(secret), createdAt: new Date().toISOString() };
  saveDevices([...loadDevices(), device]);
  return { deviceId: device.id, secret };
}
