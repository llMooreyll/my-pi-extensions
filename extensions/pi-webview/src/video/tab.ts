import { type FSWatcher, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { CdpConnection, CdpEvent } from "./cdp.ts";
import { SITE_DOM, siteFor, toMeta, type VideoMeta } from "./sites.ts";
import type { VideoSettings, VideoStore } from "./store.ts";
import { type Cue, findSubtitleFiles, loadSubtitles, matchSubtitleFile } from "./subtitles.ts";

// The world name is per process: Runtime.addBinding installs the binding into every context with this
// name, so a shared name would let one pi process receive the questions asked in another's panel.
const WORLD = `pi-webview-video-${process.pid}`;
const BINDING = "__piVideo";
const INJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), "inject");
/** Set on <html> by the panel: the pi session that owns the tab ("<pid>:<session id>"). */
const OWNER_ATTR = "data-pi-video-owner";

let panelSourceCache: string | undefined;

/** The panel script with its stylesheet, site table and owner bound in, evaluated in the isolated world. */
function panelSource(owner: string): string {
  if (!panelSourceCache) {
    const js = readFileSync(join(INJECT_DIR, "panel.js"), "utf8").trim().replace(/;$/, "");
    const css = readFileSync(join(INJECT_DIR, "panel.css"), "utf8");
    panelSourceCache = `${js}(${JSON.stringify(css)}, ${JSON.stringify(SITE_DOM)}, `;
  }
  return `${panelSourceCache}${JSON.stringify({ owner, attr: OWNER_ATTR })});`;
}

/** The tab is in use by another running pi session. */
export class TabOwnedError extends Error {
  constructor() {
    super("This tab belongs to another pi session");
  }
}

/** Whether `owner` (an OWNER_ATTR value) names a live pi session other than `self`. */
function foreignOwner(owner: unknown, self: string): boolean {
  if (typeof owner !== "string" || !owner || owner === self) return false;
  const pid = Number(owner.split(":")[0]);
  // Our own process holds one session at a time; a mark from an earlier one is stale.
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readOwner(conn: CdpConnection, sessionId: string): Promise<unknown> {
  const r = await conn
    .send<{ result?: { value?: unknown } }>("Runtime.evaluate", { expression: `document.documentElement?.getAttribute(${JSON.stringify(OWNER_ATTR)})`, returnByValue: true }, sessionId, 5000)
    .catch(() => undefined);
  return r?.result?.value;
}

/** Whether another running pi session owns the page in `targetId`. */
export async function ownedElsewhere(conn: CdpConnection, targetId: string, self: string): Promise<boolean> {
  const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  try {
    return foreignOwner(await readOwner(conn, sessionId), self);
  } finally {
    await conn.send("Target.detachFromTarget", { sessionId }, undefined, 2000).catch(() => undefined);
  }
}

/** What the controller provides to every attached tab. */
export interface TabHost {
  store: VideoStore;
  /** "<pid>:<session id>" of the pi session this tab is bound to. */
  owner(): string;
  /** The subtitle chosen for a video in this session: a path, "" for none, undefined if never chosen. */
  subtitleFor(key: string): string | undefined;
  rememberSubtitle(key: string, path: string | undefined): void;
  cwd(): string;
  busy(): boolean;
  threadsFor(key: string): Promise<unknown[]>;
  ask(tab: VideoTab, msg: Record<string, unknown>): Promise<"now" | "queued">;
  settingsChanged(from: VideoTab, settings: VideoSettings): void;
  touched(tab: VideoTab): void;
}

export interface PlaybackState {
  t: number;
  paused: boolean;
  duration: number;
  rate: number;
  /** When the page last reported, for extrapolating the position while playing. */
  at: number;
}

function shortPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** One browser tab with the pi panel injected. */
export class VideoTab {
  meta?: VideoMeta;
  state: PlaybackState = { t: 0, paused: true, duration: 0, rate: 1, at: 0 };
  subtitle?: { path: string; cues: Cue[] };
  lastActive = Date.now();
  private worldCtx?: number;
  private files: string[] = [];
  private watcher?: FSWatcher;
  private reloadTimer?: ReturnType<typeof setTimeout>;
  private metaTimers: ReturnType<typeof setTimeout>[] = [];
  private off?: () => void;
  disposed = false;

  private constructor(
    private readonly conn: CdpConnection,
    readonly targetId: string,
    readonly sessionId: string,
    public url: string,
    private readonly host: TabHost,
  ) {}

  /**
   * Attach to a page target, inject the panel into its current and future documents. A page another
   * running pi session owns is refused with TabOwnedError: one tab, one session.
   */
  static async attach(conn: CdpConnection, targetId: string, url: string, host: TabHost, navigateTo?: string): Promise<VideoTab> {
    const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    if (!navigateTo && foreignOwner(await readOwner(conn, sessionId), host.owner())) {
      await conn.send("Target.detachFromTarget", { sessionId }, undefined, 2000).catch(() => undefined);
      throw new TabOwnedError();
    }
    const tab = new VideoTab(conn, targetId, sessionId, url, host);
    try {
      await tab.init(navigateTo);
    } catch (e) {
      await tab.detach();
      throw e;
    }
    return tab;
  }

  private send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.conn.send<T>(method, params, this.sessionId, timeoutMs);
  }

  private async init(navigateTo?: string): Promise<void> {
    this.off = this.conn.on((e) => {
      if (e.sessionId === this.sessionId) this.onEvent(e);
    });
    await this.send("Runtime.enable");
    await this.send("Page.enable");
    // Only our isolated world gets the binding, so the site's own scripts cannot talk to pi.
    await this.send("Runtime.addBinding", { name: BINDING, executionContextName: WORLD });
    const source = panelSource(this.host.owner());
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source, worldName: WORLD });
    if (navigateTo) {
      await this.send("Page.navigate", { url: navigateTo });
      this.url = navigateTo;
      return;
    }
    const { executionContextId } = await this.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: this.targetId, worldName: WORLD });
    await this.send("Runtime.evaluate", { contextId: executionContextId, expression: source });
  }

  private onEvent(e: CdpEvent): void {
    const p = e.params;
    switch (e.method) {
      case "Runtime.bindingCalled":
        if (p.name !== BINDING) return;
        this.worldCtx = p.executionContextId;
        try {
          void this.onPanel(JSON.parse(p.payload));
        } catch {
          // Malformed payload: ignore.
        }
        return;
      case "Runtime.executionContextDestroyed":
        if (p.executionContextId === this.worldCtx) this.worldCtx = undefined;
        return;
      case "Runtime.executionContextsCleared":
        this.worldCtx = undefined;
        return;
      case "Page.frameNavigated":
        if (p.frame?.id === this.targetId && !p.frame.parentId) this.url = p.frame.url;
        return;
      case "Page.navigatedWithinDocument":
        // In-app navigation (next video, another part): the page fills in its data a little later.
        if (p.frameId === this.targetId) {
          this.url = p.url;
          this.scheduleMeta();
        }
        return;
    }
  }

  private scheduleMeta(): void {
    for (const t of this.metaTimers) clearTimeout(t);
    this.metaTimers = [600, 2500].map((ms) => setTimeout(() => void this.refreshMeta().catch(() => undefined), ms));
  }

  private async onPanel(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case "hello":
        await this.refreshMeta(true);
        await this.pushInit();
        return;
      case "state": {
        const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
        this.state = { t: num(msg.t, 0), paused: msg.paused === true, duration: num(msg.duration, 0), rate: num(msg.rate, 1), at: Date.now() };
        if (!this.state.paused) this.host.touched(this);
        if (msg.ev === "loadedmetadata" || msg.ev === "emptied") this.scheduleMeta();
        return;
      }
      case "ask": {
        const rid = typeof msg.rid === "string" ? msg.rid.slice(0, 40) : "";
        try {
          const delivered = await this.host.ask(this, msg);
          this.push({ type: "ack", rid, ok: true, delivered });
        } catch (e) {
          this.push({ type: "ack", rid, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      case "settings": {
        const settings = this.host.store.updateSettings(msg.settings);
        this.host.settingsChanged(this, settings);
        return;
      }
      case "subtitle": {
        const rel = typeof msg.path === "string" ? msg.path : "";
        // Only files this panel was offered can be chosen; the page never names arbitrary paths.
        const path = rel ? this.files.find((f) => shortPath(f, this.host.cwd()) === rel) : undefined;
        if (rel && !path) return this.push({ type: "toast", text: "That file is no longer offered; rescan the list" });
        await this.setSubtitle(path, true);
        return;
      }
      case "files":
        await this.scanFiles();
        this.push({ type: "files", files: this.files.map((f) => shortPath(f, this.host.cwd())), filesRoot: basename(this.host.cwd()) });
        return;
    }
  }

  /** Current playback position, extrapolated while playing. */
  currentTime(): number {
    const s = this.state;
    if (s.paused || !s.at) return s.t;
    const t = s.t + ((Date.now() - s.at) / 1000) * s.rate;
    return s.duration ? Math.min(t, s.duration) : t;
  }

  /** Read course, episode and title from the page's own data. */
  async refreshMeta(force = false): Promise<void> {
    const adapter = siteFor(this.url);
    let meta: VideoMeta | undefined;
    if (adapter) {
      const r = await this.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>("Runtime.evaluate", {
        expression: adapter.metaExpression,
        returnByValue: true,
      }).catch(() => undefined);
      if (r && !r.exceptionDetails) meta = toMeta(adapter, r.result?.value, this.url);
    }
    const changed = meta?.key !== this.meta?.key;
    this.meta = meta;
    if (!changed && !force) return this.push({ type: "meta", meta: this.metaPayload() });
    if (changed) {
      await this.scanFiles();
      await this.setSubtitle(this.defaultSubtitle(), false, false);
    }
    if (!force) {
      this.push({ type: "meta", meta: this.metaPayload() });
      this.pushCues();
      await this.pushThreads();
    }
  }

  private metaPayload() {
    const adapter = siteFor(this.url);
    return this.meta ? { ...this.meta, siteLabel: adapter?.label } : null;
  }

  private async scanFiles(): Promise<void> {
    this.files = await findSubtitleFiles(this.host.cwd()).catch(() => []);
  }

  /** The choice made for this video in this session, else a file named after it. */
  private defaultSubtitle(): string | undefined {
    if (!this.meta) return undefined;
    const saved = this.host.subtitleFor(this.meta.key);
    if (saved !== undefined) return saved || undefined;
    return matchSubtitleFile(this.files, this.meta.id, this.meta.part);
  }

  /** Show `path` (or nothing). `remember` stores the choice for this video. */
  async setSubtitle(path: string | undefined, remember: boolean, push = true): Promise<void> {
    this.watcher?.close();
    this.watcher = undefined;
    let cues: Cue[] | undefined;
    if (path) {
      try {
        cues = await loadSubtitles(path);
      } catch (e) {
        this.push({ type: "toast", text: `Cannot read ${basename(path)}: ${e instanceof Error ? e.message : String(e)}` });
        path = undefined;
      }
    }
    this.subtitle = path && cues ? { path, cues } : undefined;
    if (remember && this.meta) this.host.rememberSubtitle(this.meta.key, this.subtitle?.path);
    if (this.subtitle) this.watchSubtitle(this.subtitle.path);
    if (push) this.pushCues();
  }

  /** The user edits subtitle files by hand; show the new version when the file is saved. */
  private watchSubtitle(path: string): void {
    try {
      this.watcher = watch(path, { persistent: false }, () => {
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(async () => {
          if (this.subtitle?.path !== path) return;
          try {
            this.subtitle = { path, cues: await loadSubtitles(path) };
            this.pushCues();
          } catch {
            // Mid-save or removed: keep the last good version.
          }
        }, 250);
      });
      this.watcher.on("error", () => undefined);
    } catch {
      // Unwatchable: no live reload.
    }
  }

  private subtitlePayload() {
    return this.subtitle ? { path: shortPath(this.subtitle.path, this.host.cwd()), name: basename(this.subtitle.path) } : null;
  }

  private pushCues(): void {
    this.push({ type: "cues", cues: this.subtitle?.cues ?? [], subtitle: this.subtitlePayload() });
  }

  async pushThreads(): Promise<void> {
    if (!this.meta) return this.push({ type: "threads", threads: [] });
    this.push({ type: "threads", threads: await this.host.threadsFor(this.meta.key) });
  }

  private async pushInit(): Promise<void> {
    this.push({
      type: "init",
      meta: this.metaPayload(),
      settings: this.host.store.settings,
      cues: this.subtitle?.cues ?? [],
      subtitle: this.subtitlePayload(),
      files: this.files.map((f) => shortPath(f, this.host.cwd())),
      filesRoot: basename(this.host.cwd()),
      threads: this.meta ? await this.host.threadsFor(this.meta.key) : [],
      busy: this.host.busy(),
    });
  }

  /** Deliver a message to the panel in the page; dropped while the page is between documents. */
  push(msg: Record<string, unknown>): void {
    if (this.disposed || this.worldCtx === undefined) return;
    void this.send("Runtime.evaluate", { contextId: this.worldCtx, expression: `window.__piVideoPanel?.receive(${JSON.stringify(msg)})` }).catch(() => undefined);
  }

  private async callPanel<T>(expression: string, awaitPromise = false): Promise<T> {
    if (this.worldCtx === undefined) throw new Error("The pi panel is not loaded in this tab yet");
    const r = await this.send<{ result?: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>("Runtime.evaluate", {
      contextId: this.worldCtx,
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0] ?? r.exceptionDetails.text ?? "Page script failed");
    return r.result?.value as T;
  }

  async seek(t: number, play?: boolean): Promise<void> {
    await this.callPanel(`window.__piVideoPanel.seek(${Number(t)})`);
    if (play === true) await this.callPanel("window.__piVideoPanel.play()", true);
    if (play === false) await this.callPanel("window.__piVideoPanel.pause()");
    this.state = { ...this.state, t, at: Date.now(), ...(play === undefined ? {} : { paused: !play }) };
  }

  /**
   * The current frame as JPEG. Drawing the <video> to a canvas works while the window is hidden and
   * excludes our overlays; a cross-origin (tainted) video falls back to a screenshot of its box.
   */
  async captureFrame(): Promise<{ data: string; mimeType: "image/jpeg" }> {
    try {
      const url = await this.callPanel<string>("window.__piVideoPanel.captureFrame(1600)");
      if (typeof url === "string" && url.startsWith("data:image/jpeg;base64,")) return { data: url.slice(url.indexOf(",") + 1), mimeType: "image/jpeg" };
    } catch {
      // Fall through to the screenshot.
    }
    const rect = await this.callPanel<{ x: number; y: number; width: number; height: number } | null>("window.__piVideoPanel.videoRect()");
    if (!rect || !rect.width || !rect.height) throw new Error("No video element is visible in the tab");
    await this.callPanel("window.__piVideoPanel.setHidden(true)");
    try {
      const shot = await this.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 85, clip: { ...rect, scale: 1 } }, 10_000);
      return { data: shot.data, mimeType: "image/jpeg" };
    } finally {
      await this.callPanel("window.__piVideoPanel.setHidden(false)").catch(() => undefined);
    }
  }

  /** Stop listening and forget the tab; the page itself is left alone. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.off?.();
    this.watcher?.close();
    clearTimeout(this.reloadTimer);
    for (const t of this.metaTimers) clearTimeout(t);
  }

  /** Remove the panel from the page and detach; the injected script stops with the DevTools session. */
  async detach(): Promise<void> {
    if (this.worldCtx !== undefined) {
      await this.send("Runtime.evaluate", { contextId: this.worldCtx, expression: "window.__piVideoPanel?.destroy()" }, 2000).catch(() => undefined);
    }
    this.dispose();
    await this.conn.send("Target.detachFromTarget", { sessionId: this.sessionId }, undefined, 2000).catch(() => undefined);
  }
}
