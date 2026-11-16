import { spawn } from "node:child_process";

export interface CdpEvent {
  method: string;
  params: Record<string, any>;
  sessionId?: string;
}

interface Pending {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** DevTools endpoint of the browser the video tabs live in. */
export function cdpEndpoint(): string {
  return (process.env.PI_WEBVIEW_CDP?.trim() || "http://127.0.0.1:9444").replace(/\/+$/, "");
}

async function browserWsUrl(endpoint: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { webSocketDebuggerUrl?: unknown };
    return typeof data.webSocketDebuggerUrl === "string" ? data.webSocketDebuggerUrl : undefined;
  } catch {
    return undefined;
  }
}

/** Start the browser with PI_WEBVIEW_CDP_LAUNCH when its endpoint is down, then wait for it. */
async function launchBrowser(endpoint: string): Promise<string | undefined> {
  const command = process.env.PI_WEBVIEW_CDP_LAUNCH?.trim();
  if (!command) return undefined;
  const child = spawn("zsh", ["-c", command], { detached: true, stdio: "ignore" });
  child.once("error", () => undefined);
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const url = await browserWsUrl(endpoint);
    if (url) return url;
  }
  return undefined;
}

/** A browser-level DevTools connection; page sessions are attached in flat mode and addressed by sessionId. */
export class CdpConnection {
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Set<(event: CdpEvent) => void>();
  private readonly closeHandlers = new Set<() => void>();
  closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (m) => this.onMessage(String(m.data)));
    ws.addEventListener("close", () => this.onClosed());
    ws.addEventListener("error", () => this.onClosed());
  }

  static async connect(endpoint = cdpEndpoint()): Promise<CdpConnection> {
    const url = (await browserWsUrl(endpoint)) ?? (await launchBrowser(endpoint));
    if (!url) {
      throw new Error(
        `Cannot reach the browser DevTools endpoint ${endpoint}. Start the browser with --remote-debugging-port (or set PI_WEBVIEW_CDP / PI_WEBVIEW_CDP_LAUNCH).`,
      );
    }
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error(`DevTools WebSocket failed: ${url}`)), { once: true });
    });
    return new CdpConnection(ws);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("The browser connection is closed"));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools call timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(handler: (event: CdpEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  close(): void {
    if (this.closed) return;
    try {
      this.ws.close();
    } catch {
      // Already closing.
    }
    this.onClosed();
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, any>; sessionId?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? "DevTools error"));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      const event: CdpEvent = { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId };
      for (const h of this.handlers) {
        try {
          h(event);
        } catch {
          // A failing handler must not stop the others.
        }
      }
    }
  }

  private onClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("The browser connection closed"));
    }
    this.pending.clear();
    for (const h of this.closeHandlers) h();
  }
}
