import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Anchor, buildBlock, buildFollowUpBlock, composeMessage, foldContexts, imageData, parseAsk, type Ref, textOf, thinkingOf, toolCallNameOf, withoutImage } from "./context.ts";
import { CACHE_DIR, type Doc, displayPath, expandPath, kindOf, pruneCache } from "./docs.ts";
import { baseUrl, broadcast, ensureServer, type Hub, hub, type Pin, statusPayload, stopServer } from "./hub.ts";
import { createRouter, ensureDoc, HttpError, refreshRendition } from "./routes.ts";
import { describeTool, newId, pinPayload, publishThread, rebuildThreads, snapshotThreads, startThread } from "./threads.ts";

const WIDGET = "pi-webview";
const PINS_ENTRY = "pi-webview-pins";
const PI_ASR_SYMBOL = Symbol.for("pi.asr.v1");

interface PiAsrService {
  readonly version: number;
  getStatus(): Promise<{ available: boolean; configured: boolean; modelId?: string; reason?: string }>;
  transcribeAudio(
    audio: Uint8Array,
    options?: { mimeType?: string; signal?: AbortSignal },
  ): Promise<{ text: string; warning?: string; modelId: string; seconds: number }>;
}

function getAsrService(): PiAsrService | undefined {
  const svc = (globalThis as unknown as Record<symbol, unknown>)[PI_ASR_SYMBOL] as Partial<PiAsrService> | undefined;
  if (!svc || svc.version !== 1 || typeof svc.getStatus !== "function" || typeof svc.transcribeAudio !== "function") {
    return undefined;
  }
  return svc as PiAsrService;
}

async function queryAsrStatus() {
  const svc = getAsrService();
  if (!svc) return { available: false, configured: false, reason: "Pi Voice service is not loaded in this Pi session" };
  return svc.getStatus();
}

async function transcribeWithAsr(body: Buffer, mimeType: string | undefined, signal: AbortSignal) {
  const svc = getAsrService();
  if (!svc) throw new HttpError(503, "Pi Voice service is not loaded. Enable pi-voice in Pi settings to use speech input.");
  if (!body.byteLength) throw new HttpError(400, "Audio payload is empty");
  try {
    const result = await svc.transcribeAudio(body, { mimeType, signal });
    return { text: result.text, ...(result.warning ? { warning: result.warning } : {}), modelId: result.modelId, seconds: result.seconds };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const message = e instanceof Error ? e.message : String(e);
    const unavailable = /not configured|missing|shutting down|FFmpeg/i.test(message);
    throw new HttpError(unavailable ? 503 : 500, message);
  }
}

interface Target {
  line?: number;
  page?: number;
}

function openBrowser(url: string): Promise<void> {
  const custom = process.env.PI_WEBVIEW_BROWSER?.trim();
  const [cmd, ...args] = custom ? custom.split(/\s+/) : ["xdg-open"];
  return new Promise((resolveOpen, rejectOpen) => {
    const child = spawn(cmd!, [...args, url], { detached: true, stdio: "ignore" });
    child.once("error", rejectOpen);
    child.once("spawn", () => {
      child.unref();
      resolveOpen();
    });
  });
}

function exists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function refreshWidget(h: Hub): void {
  const ui = h.binding?.ctx.hasUI ? h.binding.ctx.ui : undefined;
  if (!ui) return;
  if (!h.pinned.length) return ui.setWidget(WIDGET, undefined);
  ui.setWidget(WIDGET, [
    `⌖ ${h.pinned.length} pinned browser reference${h.pinned.length > 1 ? "s" : ""} will be attached to your next message (/view-clear to drop)`,
    ...h.pinned.map((p) => `  · ${p.ref.label}${p.note ? ` — ${p.note.replace(/\s+/g, " ").slice(0, 60)}` : ""}`),
  ]);
}

/** Pins changed: tell the pages and the TUI, and save them in the session. */
function publishPins(h: Hub): void {
  broadcast(h, "pins", h.pinned.map(pinPayload));
  broadcast(h, "status", statusPayload(h));
  refreshWidget(h);
  savePins(h);
}

// Pins are session state: a custom entry (never sent to the model) holds the current list,
// and the last such entry on the active branch restores it after a restart, /resume or /tree.
let pinsDirty = false;
let pinsTimer: ReturnType<typeof setTimeout> | undefined;

function savePins(h: Hub): void {
  pinsDirty = true;
  clearTimeout(pinsTimer);
  // Note edits arrive while typing; write once they pause.
  pinsTimer = setTimeout(() => flushPins(h), 800);
}

/** Write pending pin changes. While pi is working this waits for agent_settled, unless forced at shutdown. */
function flushPins(h: Hub, force = false): void {
  clearTimeout(pinsTimer);
  const binding = h.binding;
  if (!pinsDirty || !binding) return;
  if (!force && !binding.ctx.isIdle()) return;
  pinsDirty = false;
  const pins = h.pinned.map(({ id, ref, note, imagePath, at }) => ({ id, ref, note, imagePath, at }));
  binding.pi.appendEntry(PINS_ENTRY, { pins });
}

function restorePins(h: Hub, ctx: ExtensionContext): void {
  let saved: unknown = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === PINS_ENTRY) saved = (entry.data as { pins?: unknown } | undefined)?.pins ?? [];
  }
  h.pinned = Array.isArray(saved) ? saved.filter((p): p is Pin => !!p && typeof p.id === "string" && !!p.ref?.anchor) : [];
  pinsDirty = false;
}

/** Pins and threads follow the active branch: rebuild both after /resume, /fork or /tree. */
async function loadSessionState(h: Hub, ctx: ExtensionContext): Promise<void> {
  restorePins(h, ctx);
  rebuildThreads(h, ctx.sessionManager.getBranch(), ctx.cwd);
  refreshWidget(h);
  broadcast(h, "pins", h.pinned.map(pinPayload));
  broadcast(h, "status", statusPayload(h));
  if (h.clients.size) broadcast(h, "threads", await snapshotThreads(h));
}

/** A pinned region screenshot, read from disk when the current model accepts images. */
function pinImage(h: Hub, pin: Pin): ImageContent | undefined {
  if (!pin.imagePath || !h.binding?.ctx.model?.input?.includes("image")) return undefined;
  try {
    return { type: "image", data: readFileSync(pin.imagePath).toString("base64"), mimeType: "image/png" };
  } catch {
    return undefined;
  }
}

function docOfRef(h: Hub, ref: Ref): Doc | undefined {
  return h.docs.get(ref.docId) ?? (exists(ref.path) ? ensureDoc(h, ref.path) : undefined);
}

function pinBlock(h: Hub, pin: Pin): string | undefined {
  const doc = docOfRef(h, pin.ref);
  return doc ? buildBlock(doc, pin.ref.anchor, { cwd: h.cwd, note: pin.note, imagePath: pin.imagePath }).block : undefined;
}

/** Send blocks + question as one user message; queued as a follow-up while pi is busy. */
function sendToPi(h: Hub, blocks: string[], question: string, images: ImageContent[]): "now" | "queued" {
  const binding = h.binding;
  if (!binding) throw new HttpError(503, "The pi session is not ready (it may be switching sessions); try again");
  const text = composeMessage(blocks, question);
  const idle = binding.ctx.isIdle();
  binding.pi.sendUserMessage(images.length ? [{ type: "text", text }, ...images] : text, idle ? undefined : { deliverAs: "followUp" });
  return idle ? "now" : "queued";
}

/** Take every pin for an outgoing message. */
function drainPins(h: Hub): { blocks: string[]; images: ImageContent[] } {
  const pins = h.pinned.splice(0);
  return {
    blocks: pins.map((p) => pinBlock(h, p)).filter((b): b is string => !!b),
    images: pins.flatMap((p) => pinImage(h, p) ?? []),
  };
}

async function deliverAsk(h: Hub, payload: unknown) {
  const binding = h.binding;
  if (!binding) throw new HttpError(503, "The pi session is not ready (it may be switching sessions); try again");
  let req;
  try {
    req = parseAsk(payload);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
  const doc = h.docs.get(req.doc);
  if (!doc) throw new HttpError(404, "Document is not open; run /view again in pi");
  if (req.mode === "ask" && !req.question) throw new HttpError(400, "The question is empty");

  // Region crops are always written to disk; they ride along as image blocks only for vision models.
  let imagePath: string | undefined;
  let image: ImageContent | undefined;
  const data = imageData(req.anchor);
  if (data) {
    const dir = join(CACHE_DIR, "shots");
    await mkdir(dir, { recursive: true });
    // Several pi processes may write here; the random part keeps names unique.
    imagePath = join(dir, `${Date.now()}-${newId()}-${basename(doc.path).replace(/[^\w.-]+/g, "_")}.png`);
    await writeFile(imagePath, Buffer.from(data, "base64"));
    if (binding.ctx.model?.input?.includes("image")) image = { type: "image", data, mimeType: "image/png" };
  }

  const anchor: Anchor = withoutImage(req.anchor);
  if (req.mode === "pin") {
    const label = buildBlock(doc, anchor, { cwd: h.cwd }).label;
    h.pinned.push({ id: newId(), ref: { docId: doc.id, path: doc.path, label, anchor }, note: req.question, imagePath, at: Date.now() });
    publishPins(h);
    return { delivered: "pinned", pinned: h.pinned.length };
  }

  const pins = drainPins(h);
  const own = buildBlock(doc, anchor, { cwd: h.cwd, imagePath }).block;
  const prev = req.replyTo ? h.threads.find((t) => t.id === req.replyTo) : undefined;
  const followUp = prev ? buildFollowUpBlock(prev.seq, prev.question, prev.parts) : undefined;
  const blocks = [...pins.blocks, own, ...(followUp ? [followUp] : [])];
  const delivered = sendToPi(h, blocks, req.question, image ? [...pins.images, image] : pins.images);
  publishPins(h);
  return { delivered, pinned: 0 };
}

async function deliverSay(h: Hub, payload: unknown) {
  const question = typeof (payload as { question?: unknown })?.question === "string" ? (payload as { question: string }).question.trim().slice(0, 8000) : "";
  if (!question && !h.pinned.length) throw new HttpError(400, "Nothing to send");
  if (!h.binding) throw new HttpError(503, "The pi session is not ready; try again");
  const pins = drainPins(h);
  const delivered = sendToPi(h, pins.blocks, question, pins.images);
  publishPins(h);
  return { delivered, pinned: 0 };
}

function editPin(h: Hub, id: string, payload: unknown) {
  const pin = h.pinned.find((p) => p.id === id);
  if (!pin) throw new HttpError(404, "Pin not found (it may have been sent already)");
  const note = (payload as { note?: unknown })?.note;
  if (typeof note !== "string") throw new HttpError(400, "Expected { note: string }");
  pin.note = note.slice(0, 4000);
  publishPins(h);
  return { ok: true };
}

function deletePin(h: Hub, id: string | undefined) {
  h.pinned = id ? h.pinned.filter((p) => p.id !== id) : [];
  publishPins(h);
  return { ok: true, pinned: h.pinned.length };
}

/** Parse "/view path[:N] [--new]". A trailing :N is a line (md/html) or page (pdf/office). */
function parseViewArgs(raw: string, cwd: string): { path: string; target?: Target; fresh: boolean } {
  let text = raw.trim();
  const fresh = /(^|\s)--new(\s|$)/.test(text);
  text = text.replace(/(^|\s)--new(\s|$)/, " ").trim().replace(/^(['"])(.*)\1$/, "$2");
  const whole = expandPath(text, cwd);
  const m = /^(.*):(\d+)$/.exec(text);
  if (m && !exists(whole)) {
    const path = expandPath(m[1]!, cwd);
    const n = Number(m[2]);
    const paged = kindOf(path) === "pdf" || kindOf(path) === "office";
    return { path, target: paged ? { page: n } : { line: n }, fresh };
  }
  return { path: whole, fresh };
}

async function openDoc(h: Hub, path: string, target: Target | undefined, fresh: boolean) {
  if (!exists(path)) throw new Error(`File not found: ${path}`);
  await ensureServer(h);
  void pruneCache().catch(() => undefined);
  const doc = ensureDoc(h, path);
  if (doc.kind === "office") refreshRendition(doc);
  const hash = target?.page ? `#page=${target.page}` : target?.line ? `#L${target.line}` : "";
  const url = `${baseUrl(h)}/v/${doc.id}${hash}`;
  const live = [...h.clients].some((c) => c.docId === doc.id);
  if (live && !fresh) {
    if (target) broadcast(h, "goto", target, doc.id);
    return { url, reused: true, file: displayPath(path, h.cwd) };
  }
  await openBrowser(url);
  return { url, reused: false, file: displayPath(path, h.cwd) };
}

function installHandlers(h: Hub): void {
  h.handle = createRouter(h, {
    ask: (body) => deliverAsk(h, body),
    say: (body) => deliverSay(h, body),
    editPin: (id, body) => editPin(h, id, body),
    deletePin: (id) => deletePin(h, id),
    snapshot: async () => ({ pins: h.pinned.map(pinPayload), threads: await snapshotThreads(h) }),
    asrStatus: () => queryAsrStatus(),
    asrTranscribe: (body, mime, signal) => transcribeWithAsr(body, mime, signal),
  });
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  h.onFsChange = (dir, name) => {
    for (const doc of h.docs.values()) {
      if (doc.dir !== dir) continue;
      const relevant = doc.kind === "html" ? !name || /\.(html?|css|m?js|svg|png|jpe?g|gif|webp|json)$/i.test(name) : !name || name === doc.name;
      if (!relevant) continue;
      clearTimeout(timers.get(doc.id));
      timers.set(
        doc.id,
        setTimeout(async () => {
          timers.delete(doc.id);
          if (!exists(doc.path)) return;
          if (doc.kind === "office") {
            broadcast(h, "converting", {}, doc.id);
            await refreshRendition(doc)?.catch(() => undefined);
          }
          broadcast(h, "change", {}, doc.id);
        }, 160),
      );
    }
  };
}

function sessionLabel(pi: ExtensionAPI, ctx: ExtensionContext): string {
  return pi.getSessionName() ?? basename(ctx.cwd);
}

export default function piWebview(pi: ExtensionAPI): void {
  const h = hub();
  // Handlers only; the server itself starts on the first /view or view_open.
  installHandlers(h);

  pi.on("session_start", async (_event, ctx) => {
    h.binding = { pi, ctx };
    h.cwd = ctx.cwd;
    h.session = sessionLabel(pi, ctx);
    h.busy = !ctx.isIdle();
    await loadSessionState(h, ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await loadSessionState(h, ctx);
  });

  pi.on("session_info_changed", async (_event, ctx) => {
    h.session = sessionLabel(pi, ctx);
    broadcast(h, "status", statusPayload(h));
  });

  pi.on("session_shutdown", async (event) => {
    // Save unsaved pin edits into the session being left; session_start restores the next one.
    flushPins(h, true);
    h.binding = undefined;
    if (event.reason === "quit") stopServer(h);
  });

  pi.on("agent_start", async () => {
    h.busy = true;
    broadcast(h, "status", statusPayload(h));
  });

  pi.on("agent_settled", async (event) => {
    h.busy = false;
    flushPins(h);
    const t = h.activeThread;
    if (t) {
      t.status = event.aborted ? "aborted" : "done";
      t.phase = undefined;
      t.thinking = undefined;
      t.activity = undefined;
      t.steps = undefined;
      publishThread(h, t, true);
      h.activeThread = undefined;
    }
    broadcast(h, "status", statusPayload(h));
  });

  // Every user message opens a thread; the assistant output after it streams into that thread.
  pi.on("message_start", async (event) => {
    if (event.message.role === "assistant") {
      const t = h.activeThread;
      if (t) {
        t.phase = "waiting";
        t.thinking = undefined;
        t.activity = undefined;
        publishThread(h, t, true);
      }
      return;
    }
    if (event.message.role !== "user") return;
    const prev = h.activeThread;
    if (prev?.status === "running") {
      prev.status = "done";
      prev.phase = undefined;
      prev.thinking = undefined;
      prev.activity = undefined;
      prev.steps = undefined;
      publishThread(h, prev, true);
    }
    h.activeThread = startThread(h, textOf(event.message.content), h.cwd ?? process.cwd());
    publishThread(h, h.activeThread, true);
  });

  pi.on("message_update", async (event) => {
    const t = h.activeThread;
    if (!t || event.message.role !== "assistant") return;
    const ev = event.assistantMessageEvent as { type?: string; toolName?: string } | undefined;
    const content = event.message.content;
    t.live = textOf(content);
    const think = thinkingOf(content);
    if (think) t.thinking = think.slice(-600);

    if (ev?.type === "thinking_start" || ev?.type === "thinking_delta") {
      t.phase = "thinking";
      t.activity = undefined;
    } else if (ev?.type === "toolcall_start" || ev?.type === "toolcall_delta" || ev?.type === "toolcall_end") {
      t.phase = "toolcall";
      const name = ev.toolName || toolCallNameOf(content);
      t.activity = name ? `Preparing ${name}` : "Preparing tool call";
    } else if (ev?.type === "text_start" || ev?.type === "text_delta" || t.live.trim()) {
      t.phase = "answering";
      t.activity = undefined;
    } else if (think) {
      t.phase = "thinking";
    }
    publishThread(h, t);
  });

  pi.on("message_end", async (event) => {
    const t = h.activeThread;
    if (!t || event.message.role !== "assistant") return;
    const text = textOf(event.message.content);
    if (text.trim()) t.parts.push(text);
    t.live = "";
    t.thinking = undefined;
    if (t.phase !== "tool" && t.phase !== "toolcall") t.phase = "waiting";
    publishThread(h, t);
  });

  pi.on("tool_execution_start", async (event) => {
    const t = h.activeThread;
    if (!t) return;
    const label = describeTool(event.toolName, event.args);
    t.phase = "tool";
    t.thinking = undefined;
    t.activity = label;
    t.steps ??= [];
    t.steps.push({ label, state: "running" });
    if (t.steps.length > 8) t.steps.splice(0, t.steps.length - 8);
    publishThread(h, t, true);
  });

  pi.on("tool_execution_end", async (event) => {
    const t = h.activeThread;
    if (!t) return;
    const label = describeTool(event.toolName, event.args);
    const step = [...(t.steps ?? [])].reverse().find((s) => s.state === "running" && s.label === label) ?? t.steps?.at(-1);
    if (step && step.state === "running") step.state = event.isError ? "error" : "done";
    t.activity = undefined;
    t.phase = "waiting";
    publishThread(h, t, true);
  });

  // Pins made in the browser travel with the next plain message typed in pi.
  pi.on("input", async (event) => {
    // Slash input (skills, templates) must keep its leading "/" to expand.
    if (!h.pinned.length || event.source === "extension" || event.text.trimStart().startsWith("/")) return { action: "continue" };
    const pins = drainPins(h);
    publishPins(h);
    return {
      action: "transform",
      text: composeMessage(pins.blocks, event.text),
      images: pins.images.length ? [...(event.images ?? []), ...pins.images] : event.images,
    };
  });

  pi.registerMarkdownTransformer((markdown, { messageType }) => (messageType === "user" ? foldContexts(markdown) : markdown));

  pi.registerCommand("view", {
    description: "Open md/html/pdf/pptx/docx in the browser and ask pi about selections. Usage: /view <file>[:line|:page] [--new]",
    handler: async (args, ctx) => {
      try {
        if (!args.trim()) {
          await ensureServer(h);
          await openBrowser(`${baseUrl(h)}/`);
          return;
        }
        const { path, target, fresh } = parseViewArgs(args, ctx.cwd);
        const r = await openDoc(h, path, target, fresh);
        ctx.ui.notify(r.reused ? `${r.file} is already open in the browser${target ? "; scrolled there" : " (add --new for another tab)"}` : `Opened ${r.file}`, "info");
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerCommand("view-clear", {
    description: "Drop the browser references pinned for the next message",
    handler: async (_args, ctx) => {
      const n = h.pinned.length;
      deletePin(h, undefined);
      ctx.ui.notify(n ? `Dropped ${n} pinned reference${n > 1 ? "s" : ""}` : "Nothing pinned", "info");
    },
  });

  pi.registerCommand("view-stop", {
    description: "Disconnect all pi-webview tabs and stop the local server; pins stay in the session",
    handler: async (_args, ctx) => {
      if (!h.server) return ctx.ui.notify("pi-webview is not running", "info");
      const tabs = h.clients.size;
      flushPins(h, true);
      stopServer(h);
      ctx.ui.notify(`Stopped pi-webview (${tabs} tab${tabs === 1 ? "" : "s"} disconnected)`, "info");
    },
  });

  pi.registerTool({
    name: "view_open",
    label: "View",
    description:
      "Open a local document (md, html, pdf, pptx/ppt/odp, docx/doc/odt/rtf) in the user's browser viewer, optionally at a line (md/html) or page/slide (pdf/office). If the document is already open, the tab scrolls there instead of opening a new one.",
    promptSnippet: "Show a local md/html/pdf/office document to the user in the browser, at a line or page",
    promptGuidelines: [
      "Use view_open when the user asks to see, read or present a document in the browser, or when pointing them to a specific line or page helps.",
      "User messages containing <browser-context> blocks come from selections the user made in the pi-webview browser viewer; read the cited file at the given line/lines/page directly (or check script-line / linked JS when dynamic='true') before answering.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "File path, relative to the working directory or absolute" }),
      line: Type.Optional(Type.Integer({ minimum: 1, description: "Line to scroll to (md, html)" })),
      page: Type.Optional(Type.Integer({ minimum: 1, description: "Page or slide to show (pdf, office)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = expandPath(params.path, ctx.cwd);
      const target = params.line || params.page ? { line: params.line, page: params.page } : undefined;
      const r = await openDoc(h, path, target, false);
      return {
        content: [{ type: "text", text: `${r.reused ? "Already open; scrolled the existing tab" : "Opened in the browser"}: ${r.file}${target ? ` (${params.page ? `page ${params.page}` : `line ${params.line}`})` : ""}` }],
        details: { url: r.url, reused: r.reused },
      };
    },
  });
}
