import { DIRECT_PATH_CLIENT, RELAY_PATH_CLIENT, type HostEndpoint } from "@pi-remote/protocol";

const trim = (u: string) => u.replace(/\/+$/, "");

export interface Candidate { url: string; via: "direct" | "relay"; base: string }

/** Direct address first (fast fail), then relays. */
export function candidates(h: HostEndpoint): Candidate[] {
  const out: Candidate[] = [];
  if (h.direct) out.push({ url: trim(h.direct) + DIRECT_PATH_CLIENT, via: "direct", base: h.direct });
  for (const r of h.relays ?? []) out.push({ url: `${trim(r)}${RELAY_PATH_CLIENT}?hostId=${encodeURIComponent(h.hostId)}`, via: "relay", base: r });
  return out;
}

/** ws:// or wss:// base URL without path or query. Returns the normalized URL or throws. */
export function validateWsBase(input: string): string {
  const s = input.trim();
  const m = /^(wss?):\/\/([^/?#\s]+)\/?$/.exec(s);
  if (!m) throw new Error("Use ws://host:port or wss://host without a path");
  return `${m[1]}://${m[2]}`;
}

export const fingerprint = (hostKey: string) => (hostKey.replace(/[^A-Za-z0-9]/g, "").slice(0, 16).match(/.{1,4}/g) ?? []).join(" ");
