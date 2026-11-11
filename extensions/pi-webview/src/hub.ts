import { randomBytes } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Ref } from "./context.ts";
import { type Doc, removeOfficeProfile } from "./docs.ts";

/**
 * A reference held back until the next message; its note can be edited until then.
 * Pins are saved in the session (see index.ts), so they survive closed tabs and pi restarts.
 */
export interface Pin {
  id: string;
  ref: Ref;
  note: string;
  /** Region screenshot on disk; read and attached at send time for vision models. */
  imagePath?: string;
  at: number;
}

export type ThreadStatus = "running" | "done" | "aborted";

/** One user message and the assistant output that followed it. */
export interface Thread {
  id: string;
  refs: Ref[];
  question: string;
  /** Finished assistant texts of this run. */
  parts: string[];
  /** The assistant text currently streaming. */
  live: string;
  status: ThreadStatus;
  /** Tool currently running, shown as progress. */
  activity?: string;
  at: number;
  html?: string;
  dirty: boolean;
}

export interface SseClient {
  res: ServerResponse;
  docId: string;
}

/**
 * Process-wide state. It lives on globalThis so /reload keeps the port, the token and the
 * connected tabs; the reloaded code re-assigns the handler fields below.
 */
export interface Hub {
  server?: Server;
  starting?: Promise<void>;
  port: number;
  token: string;
  docs: Map<string, Doc>;
  clients: Set<SseClient>;
  watchers: Map<string, FSWatcher>;
  heartbeat?: ReturnType<typeof setInterval>;
  pinned: Pin[];
  threads: Thread[];
  activeThread?: Thread;
  /** Paths of documents referenced in session history, so their links work before they are opened. */
  knownPaths: Map<string, string>;
  busy: boolean;
  session: string;
  cwd?: string;
  binding?: { pi: ExtensionAPI; ctx: ExtensionContext };
  handle?: (req: IncomingMessage, res: ServerResponse) => void;
  onFsChange?: (dir: string, name: string | null) => void;
}

const HUB_KEY = Symbol.for("pi-webview.hub");

export function hub(): Hub {
  const g = globalThis as unknown as Record<symbol, Hub | undefined>;
  g[HUB_KEY] ??= {
    port: 0,
    token: randomBytes(18).toString("base64url"),
    docs: new Map(),
    clients: new Set(),
    watchers: new Map(),
    pinned: [],
    threads: [],
    knownPaths: new Map(),
    busy: false,
    session: "pi",
  };
  const h = g[HUB_KEY]!;
  // A hub created by an older version of this extension survives /reload; fill in newer fields.
  h.threads ??= [];
  h.knownPaths ??= new Map();
  h.pinned = h.pinned.filter((p) => p && typeof p === "object" && "ref" in p);
  return h;
}

export async function ensureServer(h: Hub): Promise<void> {
  if (h.server?.listening) return;
  h.starting ??= new Promise<void>((resolveStart, rejectStart) => {
    const server = createServer((req, res) => {
      if (h.handle) h.handle(req, res);
      else res.writeHead(503).end("pi-webview is reloading");
    });
    server.once("error", rejectStart);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectStart);
      server.unref();
      h.server = server;
      h.port = (server.address() as AddressInfo).port;
      resolveStart();
    });
  }).finally(() => {
    h.starting = undefined;
  });
  await h.starting;
  h.heartbeat ??= setInterval(() => {
    for (const c of h.clients) c.res.write(": ping\n\n");
  }, 20_000);
  h.heartbeat.unref?.();
}

/** Close every page connection and the server. Pins and threads belong to the session and stay. */
export function stopServer(h: Hub): void {
  // Tell open tabs the server is going away on purpose, so they stop reconnecting.
  broadcast(h, "bye", {});
  for (const c of h.clients) c.res.end();
  h.clients.clear();
  for (const w of h.watchers.values()) w.close();
  h.watchers.clear();
  if (h.heartbeat) clearInterval(h.heartbeat);
  h.heartbeat = undefined;
  h.server?.closeAllConnections();
  h.server?.close();
  h.server = undefined;
  h.port = 0;
  h.docs.clear();
  removeOfficeProfile();
}

export function baseUrl(h: Hub): string {
  return `http://127.0.0.1:${h.port}/${h.token}`;
}

export function broadcast(h: Hub, event: string, data: unknown, docId?: string): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of h.clients) if (!docId || c.docId === docId) c.res.write(frame);
}

export function statusPayload(h: Hub) {
  return { session: h.session, busy: h.busy, pinned: h.pinned.length };
}

/** Stop watching a directory once no open tab shows a document in it. */
export function releaseDir(h: Hub, dir: string): void {
  const inUse = [...h.clients].some((c) => h.docs.get(c.docId)?.dir === dir);
  if (inUse) return;
  h.watchers.get(dir)?.close();
  h.watchers.delete(dir);
}

/** One non-recursive watcher per directory; editors that save by rename still report the file name. */
export function watchDir(h: Hub, dir: string): void {
  if (h.watchers.has(dir)) return;
  try {
    const w = watch(dir, { persistent: false }, (_event, name) => h.onFsChange?.(dir, name ? name.toString() : null));
    w.on("error", () => {
      w.close();
      h.watchers.delete(dir);
    });
    h.watchers.set(dir, w);
  } catch {
    // Unwatchable directories only lose auto-reload.
  }
}
