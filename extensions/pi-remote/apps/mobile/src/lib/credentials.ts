import { kv } from "./kv";
import type { HostEndpoint, Trust } from "@pi-remote/protocol";

export interface SavedHost {
  endpoint: HostEndpoint;
  deviceId: string;
  secret: string;
  pairedAt: string;
}

const HOSTS_KEY = "pi-remote.hosts";
const TRUST_KEY = "pi-remote.trust";
const PREFS_KEY = "pi-remote.prefs";

export async function loadHosts(): Promise<SavedHost[]> {
  try {
    const raw = await kv.get(HOSTS_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
export async function saveHosts(hosts: SavedHost[]): Promise<void> {
  await kv.set(HOSTS_KEY, JSON.stringify(hosts));
}

export async function loadTrustMap(): Promise<Record<string, Trust>> {
  try { return JSON.parse((await kv.get(TRUST_KEY)) ?? "{}"); } catch { return {}; }
}
export async function rememberTrust(cwd: string, trust: Trust): Promise<void> {
  const m = await loadTrustMap();
  m[cwd] = trust;
  await kv.set(TRUST_KEY, JSON.stringify(m));
}
export async function clearTrust(): Promise<void> { await kv.del(TRUST_KEY); }

export interface AppPrefs { keepAlive: boolean; notifyChildDone: boolean }
export const DEFAULT_PREFS: AppPrefs = { keepAlive: true, notifyChildDone: false };
export async function loadPrefs(): Promise<AppPrefs> {
  try { return { ...DEFAULT_PREFS, ...JSON.parse((await kv.get(PREFS_KEY)) ?? "{}") }; } catch { return DEFAULT_PREFS; }
}
export async function savePrefs(p: AppPrefs): Promise<void> { await kv.set(PREFS_KEY, JSON.stringify(p)); }
