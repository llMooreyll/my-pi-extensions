import { openDaemonSecureChannel, SecureChannelRejectedError, type KeyPair, type SecureChannel, type Transport } from "@getpaseo/relay/e2ee";
import type { RawData, WebSocket } from "ws";
import { log } from "./log.ts";

/** Application-level socket after the Noise handshake. Control frames are JSON text; file lanes also carry binary frames. */
export interface ClientSocket {
  send(text: string): void;
  /** Resolves once the frame is handed to the transport; file lanes use it to pace reads. */
  sendBinary(data: Uint8Array): Promise<void>;
  onBinary: ((data: Uint8Array) => void) | null;
  close(code: number, reason: string): void;
  onText: ((text: string) => void) | null;
  onClose: (() => void) | null;
  remote: string;
}

const HANDSHAKE_TIMEOUT_MS = 10_000;

export function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

const toArrayBuffer = (buf: Buffer): ArrayBuffer => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

/** Wrap a ws WebSocket as an e2ee Transport. The library reassigns the on* handlers, so look them up on each call. */
export function wsTransport(ws: WebSocket): Transport {
  const transport: Transport = {
    send: (data) => { ws.send(data); },
    close: (code, reason) => { try { ws.close(code, reason); } catch { ws.terminate(); } },
    onmessage: null, onclose: null, onerror: null,
  };
  ws.on("message", (data, isBinary) => {
    const buf = rawToBuffer(data);
    transport.onmessage?.({ data: isBinary ? toArrayBuffer(buf) : buf.toString("utf8"), isBinary });
  });
  ws.on("close", (code, reason) => transport.onclose?.(code, reason.toString()));
  ws.on("error", (e) => transport.onerror?.(e));
  return transport;
}

export async function secureServerSocket(ws: WebSocket, keyPair: KeyPair, remote: string): Promise<ClientSocket> {
  const transport = wsTransport(ws);
  const sock: ClientSocket = { send: () => {}, sendBinary: async () => {}, close: () => {}, onText: null, onBinary: null, onClose: null, remote };
  let closed = false;
  const fireClose = () => { if (closed) return; closed = true; sock.onClose?.(); };
  ws.on("close", fireClose);
  const timer = setTimeout(() => { log.warn("handshake timeout", remote); ws.close(1008, "handshake timeout"); }, HANDSHAKE_TIMEOUT_MS);
  let channel: SecureChannel;
  try {
    channel = await openDaemonSecureChannel(transport, {
      daemonKeyPair: keyPair,
      minimumMode: "protected",
      events: {
        onmessage: (d) => {
          if (typeof d === "string") sock.onText?.(d);
          else sock.onBinary?.(d instanceof Uint8Array ? d : new Uint8Array(d as ArrayBuffer));
        },
        onclose: () => fireClose(),
        onerror: (e) => log.warn("channel error", remote, e.message),
      },
    });
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof SecureChannelRejectedError) ws.close(e.closeCode, e.closeReason);
    else if (ws.readyState === ws.OPEN) ws.close(1011, "handshake failed");
    throw e;
  }
  clearTimeout(timer);
  let chain: Promise<void> = Promise.resolve();
  sock.send = (text) => { chain = chain.then(() => channel.send(text)).catch((e) => log.warn("send failed", remote, e)); };
  sock.sendBinary = (data) => {
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const p = chain.then(() => channel.send(buf));
    chain = p.catch((e) => log.warn("send failed", remote, e));
    return p;
  };
  sock.close = (code, reason) => {
    // Flush queued sends before closing so final frames (auth_err, pair_err) arrive.
    chain = chain.then(() => { try { channel.close(code, reason); } catch { ws.terminate(); } });
  };
  return sock;
}
