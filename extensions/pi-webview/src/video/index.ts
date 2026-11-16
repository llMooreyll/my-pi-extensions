import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildFollowUpBlock, composeMessage, registerContextBlock } from "../shared/blocks.ts";
import { deliverUserMessage, type SessionBinding } from "../shared/send.ts";
import { addTurnConsumer, findTurn, isLatestTurn, newId, renderTurnReply, type Turn, turnState } from "../shared/turns.ts";
import { CdpConnection } from "./cdp.ts";
import { buildVideoBlock, foldVideoBlocks, formatTime, parseTime, parseVideoBlock, stripVideoBlocks, type VideoRef } from "./context.ts";
import { looksLikeVideoPage, normalizeVideoUrl, videoIdentity } from "./sites.ts";
import { VideoStore } from "./store.ts";
import { type Cue, findSubtitleFiles, isSubtitleFile } from "./subtitles.ts";
import { ownedElsewhere, type TabHost, TabOwnedError, VideoTab } from "./tab.ts";

const FILE_PICKER_SYMBOL = Symbol.for("pi.file-picker.v1");
/** Session entry (never sent to the model) holding the tabs bound to the session and its subtitle choices. */
const STATE_ENTRY = "pi-webview-video";
const FRAMES_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi-webview", "frames");
const FRAME_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const STREAM_INTERVAL_MS = 150;
/** Terminal messages carry the position only while the learner is (or was recently) watching. */
const AUTO_CONTEXT_MAX_IDLE_MS = 30 * 60 * 1000;

interface FilePickerService {
  readonly version: number;
  pick(
    ui: ExtensionContext["ui"],
    options: { cwd: string; title?: string; accept?: (absolutePath: string) => boolean },
  ): Promise<{ path: string; isDirectory: boolean } | undefined>;
}

function getFilePicker(): FilePickerService | undefined {
  const svc = (globalThis as unknown as Record<symbol, Partial<FilePickerService> | undefined>)[FILE_PICKER_SYMBOL];
  return svc?.version === 1 && typeof svc.pick === "function" ? (svc as FilePickerService) : undefined;
}

interface SavedTab {
  targetId: string;
  url: string;
}

interface SessionVideoState {
  tabs: SavedTab[];
  /** Video key → subtitle path chosen in this session; "" means none. */
  subtitles: Record<string, string>;
}

/** The last state entry on the active branch; entries are written by this extension but read defensively. */
function readSessionState(ctx: ExtensionContext): SessionVideoState {
  let saved: unknown;
  for (const e of ctx.sessionManager.getBranch()) if (e.type === "custom" && e.customType === STATE_ENTRY) saved = e.data;
  const d = (saved && typeof saved === "object" ? saved : {}) as Record<string, unknown>;
  const tabs = Array.isArray(d.tabs)
    ? d.tabs.filter((t): t is SavedTab => !!t && typeof t === "object" && typeof (t as SavedTab).targetId === "string" && typeof (t as SavedTab).url === "string")
    : [];
  const subs = d.subtitles && typeof d.subtitles === "object" ? d.subtitles : {};
  return { tabs, subtitles: Object.fromEntries(Object.entries(subs).filter((e): e is [string, string] => typeof e[1] === "string")) };
}

/** Validate one panel ask; the page is untrusted input. */
function parseAskMessage(msg: Record<string, unknown>) {
  const question = typeof msg.question === "string" ? msg.question.trim().slice(0, 8000) : "";
  if (!question) throw new Error("The question is empty");
  const time = typeof msg.time === "number" && Number.isFinite(msg.time) && msg.time >= 0 ? msg.time : 0;
  const cues: Cue[] = Array.isArray(msg.cues)
    ? msg.cues
        .slice(0, 200)
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
        .map((c) => ({ start: Number(c.start) || 0, end: Number(c.end) || 0, text: typeof c.text === "string" ? c.text.slice(0, 2000) : "" }))
        .filter((c) => c.text.trim())
    : [];
  const replyTo = typeof msg.replyTo === "string" ? msg.replyTo.slice(0, 40) : undefined;
  return { question, time, cues, replyTo, frame: msg.frame === true };
}

async function pruneFrames(): Promise<void> {
  const now = Date.now();
  for (const name of await readdir(FRAMES_DIR).catch(() => [] as string[])) {
    const path = join(FRAMES_DIR, name);
    const st = await stat(path).catch(() => undefined);
    if (st && now - st.mtimeMs > FRAME_MAX_AGE_MS) await rm(path, { force: true }).catch(() => undefined);
  }
}

/** Video learning: /watch attaches a browser tab, injects the subtitle panel and relays questions. */
export function registerVideo(pi: ExtensionAPI): void {
  const store = new VideoStore();
  const tabs = new Map<string, VideoTab>();
  let conn: CdpConnection | undefined;
  let binding: SessionBinding | undefined;
  let sessionId = "";
  let cwd = process.cwd();
  let framesPruned = false;

  // ---------- per-session state ----------
  // Tabs belong to one pi session. Leaving the session (/new, /resume, /reload, quit) removes the panels;
  // starting it again attaches them again. Subtitle choices are kept with the session, like the Q&A.
  let subtitles: Record<string, string> = {};
  let stateDirty = false;
  let lastSaved = "";

  const savedTabs = (): SavedTab[] => [...tabs.values()].filter((t) => !t.disposed).map((t) => ({ targetId: t.targetId, url: t.url }));

  /** Record the session state; while pi is working this waits for agent_settled, unless forced. */
  function saveState(force = false): void {
    stateDirty = true;
    if (!binding || (!force && !binding.ctx.isIdle())) return;
    stateDirty = false;
    const state: SessionVideoState = { tabs: savedTabs(), subtitles };
    const json = JSON.stringify(state);
    if (json === lastSaved) return;
    lastSaved = json;
    pi.appendEntry(STATE_ENTRY, state);
  }

  function loadState(ctx: ExtensionContext): SessionVideoState {
    const state = readSessionState(ctx);
    subtitles = state.subtitles;
    stateDirty = false;
    lastSaved = JSON.stringify(state);
    return state;
  }

  registerContextBlock("video-context", { strip: stripVideoBlocks, fold: foldVideoBlocks });

  // ---------- turns → panels ----------
  const refCache = new WeakMap<Turn, VideoRef | null>();
  const refOf = (t: Turn): VideoRef | undefined => {
    let r = refCache.get(t);
    if (r === undefined) {
      r = parseVideoBlock(t.text) ?? null;
      refCache.set(t, r);
    }
    return r ?? undefined;
  };

  async function threadPayload(t: Turn, r: VideoRef) {
    return {
      id: t.id,
      seq: t.seq,
      ...(t.replyToSeq ? { replyToSeq: t.replyToSeq } : {}),
      question: t.question,
      html: await renderTurnReply(t, true),
      status: t.status,
      ...(t.status === "running" && t.phase ? { phase: t.phase } : {}),
      ...(t.activity ? { activity: t.activity } : {}),
      time: r.time,
      ...(r.from !== undefined ? { from: r.from, to: r.to, excerpt: r.excerpt } : {}),
      at: t.at,
    };
  }

  async function threadsFor(key: string) {
    const out = [];
    for (const t of turnState().turns) {
      const r = refOf(t);
      if (r?.key === key) out.push(await threadPayload(t, r));
    }
    return out;
  }

  const streamTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function publish(t: Turn, now: boolean): void {
    const r = refOf(t);
    if (!r || ![...tabs.values()].some((tab) => tab.meta?.key === r.key)) return;
    const pending = streamTimers.get(t.id);
    if (pending && !now) return;
    clearTimeout(pending);
    streamTimers.set(
      t.id,
      setTimeout(
        () => {
          streamTimers.delete(t.id);
          threadPayload(t, r)
            .then((thread) => {
              for (const tab of tabs.values()) if (tab.meta?.key === r.key) tab.push({ type: "thread", thread });
            })
            .catch(() => undefined);
        },
        now ? 0 : STREAM_INTERVAL_MS,
      ),
    );
  }

  addTurnConsumer("video", {
    reset() {
      for (const tab of tabs.values()) void tab.pushThreads();
    },
    update: publish,
    busy(busy) {
      for (const tab of tabs.values()) tab.push({ type: "busy", busy });
    },
  });

  // ---------- browser ----------
  const host: TabHost = {
    store,
    owner: () => `${process.pid}:${sessionId}`,
    subtitleFor: (key) => subtitles[key],
    rememberSubtitle(key, path) {
      subtitles = { ...subtitles, [key]: path ?? "" };
      saveState();
    },
    cwd: () => cwd,
    busy: () => turnState().busy,
    threadsFor,
    ask: (tab, msg) => deliverAsk(tab, msg),
    settingsChanged(from, settings) {
      for (const tab of tabs.values()) if (tab !== from) tab.push({ type: "settings", settings });
    },
    touched(tab) {
      tab.lastActive = Date.now();
    },
  };

  async function connection(): Promise<CdpConnection> {
    if (conn && !conn.closed) return conn;
    const c = await CdpConnection.connect();
    c.onClose(() => {
      for (const tab of tabs.values()) tab.dispose();
      tabs.clear();
      if (conn === c) conn = undefined;
    });
    c.on((e) => {
      // The tab was closed or navigated away from DevTools' reach.
      if (e.method !== "Target.detachedFromTarget") return;
      const tab = [...tabs.values()].find((t) => t.sessionId === e.params.sessionId);
      if (!tab) return;
      // Our own detach disposes the tab first; anything else means the user closed or left the tab.
      const ours = tab.disposed;
      tab.dispose();
      tabs.delete(tab.targetId);
      if (!ours) saveState();
    });
    conn = c;
    return c;
  }

  async function attach(targetId: string, url: string, navigateTo?: string, activate = true): Promise<VideoTab> {
    const c = await connection();
    let tab = tabs.get(targetId);
    if (!tab || tab.disposed) {
      tab = await VideoTab.attach(c, targetId, url, host, navigateTo);
      tabs.set(targetId, tab);
      saveState();
    }
    tab.lastActive = Date.now();
    if (activate) await c.send("Target.activateTarget", { targetId }).catch(() => undefined);
    return tab;
  }

  async function pageTargets(): Promise<{ targetId: string; url: string; title: string }[]> {
    const c = await connection();
    const { targetInfos } = await c.send<{ targetInfos: { targetId: string; type: string; url: string; title: string }[] }>("Target.getTargets");
    return targetInfos.filter((t) => t.type === "page");
  }

  /** Reuse a tab that already shows this video and no other pi session owns, else open one. */
  async function watchUrl(url: string): Promise<{ tab: VideoTab; skipped: boolean }> {
    const id = videoIdentity(url);
    let skipped = false;
    for (const t of (await pageTargets()).filter((x) => id && videoIdentity(x.url) === id)) {
      try {
        return { tab: await attach(t.targetId, t.url), skipped };
      } catch (e) {
        if (!(e instanceof TabOwnedError)) throw e;
        skipped = true;
      }
    }
    const c = await connection();
    // Open blank first so the panel script is registered before the video page's document starts.
    const { targetId } = await c.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    return { tab: await attach(targetId, "about:blank", url), skipped };
  }

  async function detachAll(): Promise<void> {
    await Promise.all([...tabs.values()].map((t) => t.detach()));
    tabs.clear();
  }

  /** Attach the tabs saved with the session again; tabs that are gone or taken by another session are skipped. */
  async function restoreTabs(saved: SavedTab[]): Promise<void> {
    const targets = await pageTargets();
    for (const s of saved) {
      const id = videoIdentity(s.url);
      // After a browser restart target ids change: fall back to a tab showing the same video.
      const t = targets.find((x) => x.targetId === s.targetId) ?? targets.find((x) => id && videoIdentity(x.url) === id && !tabs.has(x.targetId));
      if (t) await attach(t.targetId, t.url, undefined, false).catch(() => undefined);
    }
  }

  /** The tab the learner is using: the most recently playing or attached one. */
  function activeTab(): VideoTab | undefined {
    let best: VideoTab | undefined;
    for (const t of tabs.values()) if (!t.disposed && (!best || t.lastActive > best.lastActive)) best = t;
    return best;
  }

  // ---------- asking ----------
  async function saveFrame(frame: { data: string }): Promise<string> {
    await mkdir(FRAMES_DIR, { recursive: true });
    if (!framesPruned) {
      framesPruned = true;
      void pruneFrames();
    }
    const path = join(FRAMES_DIR, `${Date.now()}-${newId()}.jpg`);
    await writeFile(path, Buffer.from(frame.data, "base64"));
    return path;
  }

  const visionModel = () => !!binding?.ctx.model?.input?.includes("image");

  async function deliverAsk(tab: VideoTab, msg: Record<string, unknown>): Promise<"now" | "queued"> {
    if (!binding) throw new Error("The pi session is not ready (it may be switching sessions); try again");
    if (!tab.meta) throw new Error("No video is recognised on this page");
    const req = parseAskMessage(msg);
    const images: ImageContent[] = [];
    let framePath: string | undefined;
    if (req.frame) {
      const frame = await tab.captureFrame();
      framePath = await saveFrame(frame);
      if (visionModel()) images.push({ type: "image", data: frame.data, mimeType: frame.mimeType });
    }
    const block = buildVideoBlock(tab.meta, req.time, req.cues, framePath);
    const prev = findTurn(req.replyTo);
    const followUp = prev && !isLatestTurn(prev) ? buildFollowUpBlock(prev.seq, prev.question, prev.parts) : undefined;
    tab.lastActive = Date.now();
    return deliverUserMessage(binding, followUp ? [block, followUp] : [block], req.question, images);
  }

  // Questions typed in the pi terminal carry the playback position too.
  pi.on("input", async (event) => {
    if (event.source === "extension" || event.text.trimStart().startsWith("/") || event.text.includes("<video-context")) return { action: "continue" };
    if (!store.settings.autoContext) return { action: "continue" };
    const tab = activeTab();
    if (!tab?.meta || Date.now() - Math.max(tab.state.at, tab.lastActive) > AUTO_CONTEXT_MAX_IDLE_MS) return { action: "continue" };
    return { action: "transform", text: composeMessage([buildVideoBlock(tab.meta, tab.currentTime())], event.text), images: event.images };
  });

  // ---------- session lifecycle ----------
  pi.on("session_start", async (_event, ctx) => {
    binding = { pi, ctx };
    sessionId = ctx.sessionManager.getSessionId();
    cwd = ctx.cwd;
    const state = loadState(ctx);
    // Attach again in the background; a closed browser simply means nothing to restore.
    if (state.tabs.length) void restoreTabs(state.tabs).catch(() => undefined);
  });

  pi.on("session_tree", async (_event, ctx) => {
    loadState(ctx);
  });

  pi.on("agent_settled", async () => {
    if (stateDirty) saveState();
  });

  pi.on("session_shutdown", async () => {
    saveState(true);
    binding = undefined;
    store.flush();
    await detachAll();
    conn?.close();
    conn = undefined;
  });

  // ---------- commands ----------
  async function pickSubtitle(ctx: ExtensionContext): Promise<string | undefined> {
    const picker = getFilePicker();
    if (ctx.mode === "tui" && picker) {
      const picked = await picker.pick(ctx.ui, { cwd: ctx.cwd, title: "Subtitle file", accept: (f) => isSubtitleFile(f) });
      return picked?.path;
    }
    const files = await findSubtitleFiles(ctx.cwd);
    if (!files.length) throw new Error("No .srt / .vtt / .ass files under the working directory");
    const choice = await ctx.ui.select("Subtitle file", files);
    return choice ?? undefined;
  }

  async function chooseTab(ctx: ExtensionContext): Promise<VideoTab | undefined> {
    const c = await connection();
    const pages = (await pageTargets()).filter((t) => looksLikeVideoPage(t.url) || tabs.has(t.targetId));
    const candidates = [];
    for (const t of pages) if (tabs.has(t.targetId) || !(await ownedElsewhere(c, t.targetId, host.owner()).catch(() => false))) candidates.push(t);
    if (!candidates.length) {
      throw new Error(pages.length ? "Every video tab is in use by another pi session. Use /watch <url> to open a new tab." : "No video tab is open in the browser. Use /watch <url>.");
    }
    if (candidates.length === 1) return attach(candidates[0]!.targetId, candidates[0]!.url);
    const labels = candidates.map((t, i) => `${i + 1}. ${t.title || t.url}`);
    const choice = await ctx.ui.select("Attach to which tab?", labels);
    if (!choice) return undefined;
    const t = candidates[labels.indexOf(choice)]!;
    return attach(t.targetId, t.url);
  }

  /** Remove the panels from this session's tabs and drop the DevTools connection; the tabs stay open. */
  async function stopWatching(quitBrowser: boolean): Promise<string> {
    const n = tabs.size;
    await detachAll();
    saveState(true);
    let quit = false;
    if (quitBrowser && conn && !conn.closed) quit = await conn.send("Browser.close", {}, undefined, 5000).then(() => true, () => false);
    conn?.close();
    conn = undefined;
    const detached = n ? `Detached ${n} tab${n > 1 ? "s" : ""}` : "No tab was attached";
    return quitBrowser ? `${detached}; ${quit ? "the browser was closed" : "the browser could not be closed (not connected)"}` : `${detached}; disconnected from the browser`;
  }

  pi.registerCommand("watch", {
    description:
      "Study a browser video with a pi subtitle panel. Usage: /watch [url] | /watch sub [file|off] | /watch auto on|off. Close tabs with /watch-close, disconnect with /watch-stop.",
    handler: async (args, ctx) => {
      try {
        const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
        const restText = args.trim().slice(sub.length).trim().replace(/^(['"])(.*)\1$/, "$2");
        if (sub === "off") return ctx.ui.notify(await stopWatching(false), "info");
        if (sub === "auto") {
          const on = rest[0] === "on" ? true : rest[0] === "off" ? false : !store.settings.autoContext;
          const settings = store.updateSettings({ autoContext: on });
          for (const tab of tabs.values()) tab.push({ type: "settings", settings });
          return ctx.ui.notify(`Terminal messages ${on ? "carry" : "no longer carry"} the video position`, "info");
        }
        if (sub === "sub") {
          const tab = activeTab();
          if (!tab?.meta) throw new Error("Attach a video tab first: /watch [url]");
          if (restText === "off") {
            await tab.setSubtitle(undefined, true);
            return ctx.ui.notify("Subtitle hidden for this video", "info");
          }
          const path = restText ? resolve(ctx.cwd, restText.replace(/^~(?=\/)/, homedir())) : await pickSubtitle(ctx);
          if (!path) return;
          if (!isSubtitleFile(path)) throw new Error("Pick a .srt, .vtt, .ass or .ssa file");
          await tab.setSubtitle(path, true);
          if (!tab.subtitle) throw new Error(`Could not load ${path}`);
          return ctx.ui.notify(`${tab.subtitle.cues.length} subtitle lines from ${path}`, "info");
        }
        let tab: VideoTab | undefined;
        let skipped = false;
        if (sub) {
          const url = normalizeVideoUrl(args.trim());
          if (!url) throw new Error(`Not a video URL: ${args.trim()}`);
          ({ tab, skipped } = await watchUrl(url));
        } else {
          tab = await chooseTab(ctx);
        }
        if (!tab) return;
        if (!tab.meta) await tab.refreshMeta(true).catch(() => undefined);
        const m = tab.meta;
        const note = skipped ? " (in a new tab: the open one belongs to another pi session)" : "";
        ctx.ui.notify(`${m ? `Watching ${m.course ? `${m.course} · ` : ""}${m.episode ? `E${m.episode} · ` : ""}${m.episodeTitle}` : "Attached; waiting for the video page to load"}${note}`, "info");
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerCommand("watch-close", {
    description: "Close the browser tabs this pi session is watching",
    handler: async (_args, ctx) => {
      try {
        const list = [...tabs.values()].filter((t) => !t.disposed);
        if (!list.length) return ctx.ui.notify("This session has no video tab", "info");
        let chosen = list;
        if (list.length > 1) {
          const labels = list.map((t, i) => `${i + 1}. ${t.meta?.episodeTitle ?? t.url}`);
          const all = `All ${list.length} tabs`;
          const choice = await ctx.ui.select("Close which tab?", [all, ...labels]);
          if (!choice) return;
          if (choice !== all) chosen = [list[labels.indexOf(choice)]!];
        }
        const c = await connection();
        for (const t of chosen) {
          await t.detach();
          tabs.delete(t.targetId);
          await c.send("Target.closeTarget", { targetId: t.targetId }).catch(() => undefined);
        }
        saveState(true);
        ctx.ui.notify(`Closed ${chosen.length} tab${chosen.length > 1 ? "s" : ""}`, "info");
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerCommand("watch-stop", {
    description: "Remove the pi panel from this session's video tabs and disconnect from the browser; --browser also quits the browser",
    handler: async (args, ctx) => {
      try {
        const quitBrowser = args.split(/\s+/).includes("--browser");
        if (quitBrowser && !(await ctx.ui.confirm("Quit the browser?", "Every tab of the browser at the DevTools endpoint closes, not only the video tabs."))) return;
        ctx.ui.notify(await stopWatching(quitBrowser), "info");
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  // ---------- tools ----------
  const noTab = () => ({
    content: [{ type: "text" as const, text: "No video tab is attached. Ask the user to open the lesson and run /watch." }],
    details: {},
    isError: true,
  });

  pi.registerTool({
    name: "video_state",
    label: "Video",
    description: "Read which lesson video the user is watching in the browser: course, episode, title, playback position and the subtitle line shown now.",
    promptSnippet: "Check the course, episode and playback position of the video the user is studying",
    promptGuidelines: [
      "User messages containing <video-context> blocks come from the pi-webview video panel: time is the playback position, course/episode/episode-title identify the lesson, <subtitle> holds the lines the user selected. Find course materials (subtitles, notes, slides) yourself in the working directory.",
      "Use video_state when the user refers to the video (\"here\", \"just now\") without a <video-context> block.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const tab = activeTab();
      if (!tab?.meta) return noTab();
      const m = tab.meta;
      const t = tab.currentTime();
      const cues = tab.subtitle?.cues ?? [];
      let line: Cue | undefined;
      for (const c of cues) {
        if (c.start > t + 0.05) break;
        line = c;
      }
      const lines = [
        `site: ${m.site}`,
        m.course ? `course: ${m.course}` : "",
        m.episode ? `episode: ${m.episode}${m.total ? `/${m.total}` : ""}` : "",
        `episode-title: ${m.episodeTitle}`,
        `time: ${formatTime(t)}${tab.state.duration ? ` / ${formatTime(tab.state.duration)}` : ""} (${tab.state.paused ? "paused" : "playing"})`,
        line && t <= line.end + 1 ? `current subtitle [${formatTime(line.start)}]: ${line.text.replace(/\s*\n\s*/g, " ")}` : "",
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }], details: { meta: m, time: t } };
    },
  });

  pi.registerTool({
    name: "video_seek",
    label: "Seek",
    description: "Move the user's lesson video to a time, e.g. to show the moment an explanation refers to.",
    promptSnippet: "Jump the user's lesson video to a timestamp",
    parameters: Type.Object({
      time: Type.String({ description: 'Target position: "m:ss", "h:mm:ss" or seconds' }),
      play: Type.Optional(Type.Boolean({ description: "true to start playing, false to pause; omit to keep the current state" })),
    }),
    async execute(_id, params) {
      const tab = activeTab();
      if (!tab?.meta) return noTab();
      const t = parseTime(params.time);
      if (t === undefined) throw new Error(`Cannot read time "${params.time}"; use m:ss, h:mm:ss or seconds`);
      await tab.seek(t, params.play);
      return { content: [{ type: "text", text: `Moved to ${formatTime(t)}${params.play === true ? " and playing" : params.play === false ? " (paused)" : ""}` }], details: { time: t } };
    },
  });

  pi.registerTool({
    name: "video_frame",
    label: "Frame",
    description: "Capture the frame currently shown in the user's lesson video (slides, diagrams, board writing) as an image.",
    promptSnippet: "See the current frame of the user's lesson video",
    promptGuidelines: ["Use video_frame when a question concerns what is on screen in the lesson video (a slide, circuit, formula or board)."],
    parameters: Type.Object({}),
    async execute() {
      const tab = activeTab();
      if (!tab?.meta) return noTab();
      const frame = await tab.captureFrame();
      const path = await saveFrame(frame);
      const t = tab.currentTime();
      const text = `Frame at ${formatTime(t)} of ${tab.meta.episodeTitle} (saved to ${path})`;
      return {
        content: [{ type: "text", text }, { type: "image", data: frame.data, mimeType: frame.mimeType }],
        details: { path, time: t },
      };
    },
  });
}
