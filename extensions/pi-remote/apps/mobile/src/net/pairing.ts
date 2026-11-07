import { PROTOCOL_VERSION, type EndpointQr, type HostToClient, type PairQr } from "@pi-remote/protocol";
import type { SavedHost } from "../lib/credentials";
import { candidates } from "./endpoints";
import { openSecure } from "./secure-ws";

export class PairError extends Error {
  kind: "invalid_code" | "unreachable" | "identity" | "incompatible";
  constructor(kind: PairError["kind"], message: string) { super(message); this.kind = kind; }
}

const nonEmpty = (v: unknown) => typeof v === "string" && v.length > 0;

/** Parses QR/pasted text. Returns the payload or an English error message. */
export function parseQr(text: string): { ok: true; qr: PairQr | EndpointQr } | { ok: false; error: string } {
  let v: Record<string, unknown>;
  try { v = JSON.parse(text.trim()); } catch { return { ok: false, error: "Not a pi-remote pairing code" }; }
  if (!v || v.v !== 2 || (v.kind !== "pair" && v.kind !== "endpoint")) return { ok: false, error: "Not a pi-remote pairing code" };
  if (!nonEmpty(v.hostId) || !nonEmpty(v.hostKey) || !Array.isArray(v.relays)) return { ok: false, error: "Not a pi-remote pairing code" };
  if (!(v.relays as unknown[]).length && !nonEmpty(v.direct)) return { ok: false, error: "The code contains no relay or direct address" };
  if (v.kind === "pair" && !nonEmpty(v.code)) return { ok: false, error: "Not a pi-remote pairing code" };
  return { ok: true, qr: v as unknown as PairQr | EndpointQr };
}

export async function pairWithQr(qr: PairQr, deviceName: string): Promise<SavedHost> {
  let lastErr: PairError | undefined;
  for (const c of candidates(qr)) {
    let conn;
    try {
      conn = await openSecure(c.url, qr.hostKey, c.via === "direct" ? 4000 : 12000);
    } catch (e) {
      const code = (e as { code?: number }).code;
      lastErr = code === 4002 || code === 1011
        ? new PairError("identity", "Computer identity check failed: the QR code does not match this computer")
        : new PairError("unreachable", `Cannot connect (${c.via}): ${(e as Error).message}. Check the relay address and that pi-hostd is running (pi-hostd relay show).`);
      continue;
    }
    return await new Promise<SavedHost>((resolve, reject) => {
      const timer = setTimeout(() => { conn.close(); reject(new PairError("unreachable", "Pairing timed out")); }, 15000);
      conn.onText = (t) => {
        let f: HostToClient;
        try { f = JSON.parse(t) as HostToClient; } catch { return; }
        if (f.t === "pair_ok") {
          clearTimeout(timer);
          conn.close();
          resolve({
            endpoint: { hostId: qr.hostId, hostKey: qr.hostKey, hostName: f.hostName, relays: qr.relays, ...(qr.direct ? { direct: qr.direct } : {}) },
            deviceId: f.deviceId, secret: f.secret, pairedAt: new Date().toISOString(),
          });
        } else if (f.t === "pair_err") {
          clearTimeout(timer);
          conn.close();
          reject(f.code === "invalid_code"
            ? new PairError("invalid_code", "Pairing code is invalid or expired. Run pi-hostd pair on the computer again.")
            : new PairError("incompatible", "Protocol version mismatch: update the app or pi-hostd"));
        }
      };
      conn.onClose = () => { clearTimeout(timer); reject(new PairError("unreachable", "Connection closed during pairing")); };
      conn.send(JSON.stringify({ t: "pair", protocol: PROTOCOL_VERSION, code: qr.code, deviceName }));
    });
  }
  throw lastErr ?? new PairError("unreachable", "No address to connect to");
}
