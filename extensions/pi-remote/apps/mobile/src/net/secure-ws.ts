import { openClientSecureChannel, type SecureChannel, type Transport } from "@getpaseo/relay/e2ee";

export interface SecureConn {
  send(text: string): void;
  close(): void;
  onText: ((t: string) => void) | null;
  onClose: ((code: number, reason: string) => void) | null;
}

export class ConnectError extends Error {
  code?: number;
  constructor(message: string, code?: number) { super(message); this.code = code; }
}

/** Opens a WebSocket and runs the Noise NK handshake against the host's public key. Resolves when the channel is usable. */
export function openSecure(url: string, hostKey: string, timeoutMs: number): Promise<SecureConn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const transport: Transport = {
      send: (d) => ws.send(d),
      close: (c, r) => ws.close(c, r),
      onmessage: null, onclose: null, onerror: null,
    };
    const conn: SecureConn = { send: () => {}, close: () => { try { ws.close(); } catch { /* ignore */ } }, onText: null, onClose: null };
    let settled = false;
    let closedNotified = false;
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      reject(e);
    };
    const timer = setTimeout(() => fail(new ConnectError("connect timeout")), timeoutMs);
    ws.onmessage = (m) => transport.onmessage?.({ data: m.data as string | ArrayBuffer, isBinary: typeof m.data !== "string" });
    ws.onclose = (e) => {
      transport.onclose?.(e.code, e.reason);
      if (!settled) { fail(new ConnectError(closeText(e.code, e.reason), e.code)); return; }
      if (!closedNotified) { closedNotified = true; conn.onClose?.(e.code, e.reason); }
    };
    ws.onerror = () => transport.onerror?.(new Error("websocket error"));
    ws.onopen = async () => {
      try {
        let chain: Promise<void> = Promise.resolve();
        const ch: SecureChannel = await openClientSecureChannel(transport, {
          daemonPublicKeyB64: hostKey,
          minimumMode: "protected",
          events: {
            onopen: () => { if (settled) return; settled = true; clearTimeout(timer); resolve(conn); },
            onmessage: (d) => conn.onText?.(typeof d === "string" ? d : new TextDecoder().decode(d)),
          },
        });
        conn.send = (t) => { chain = chain.then(() => ch.send(t)).catch(() => {}); };
        conn.close = () => { try { ch.close(1000, "bye"); } catch { ws.close(); } };
      } catch (e) { fail(e); }
    };
  });
}

function closeText(code: number, reason: string): string {
  switch (code) {
    case 4404: return "Computer is offline (pi-hostd is not connected to the relay)";
    case 4504: return "Computer did not answer through the relay";
    case 4429: return "Too many connections to the relay";
    case 4002: case 1011: return "Computer identity check failed (wrong key)";
    default: return `Connection closed (${code}${reason ? `: ${reason}` : ""})`;
  }
}
