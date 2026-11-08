import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantDelta } from "../../protocol/src/index.ts";
import { emitSafe } from "./host-conn.ts";
import { logError } from "./log.ts";
import { runReloadNow } from "./remote-op-cmd.ts";
import { sanitize } from "./sanitize.ts";
import { buildInfo, lastAssistantText, refreshStatus, summarizeModel } from "./snapshot.ts";
import { g } from "./state.ts";

type Obj = Record<string, any>;
const SUBAGENT_TOOLS = new Set(["subagent", "subagent_resume"]);
const TOOL_UPDATE_MIN_MS = 250;

const active = () => { const s = g(); return s.enabled && !!s.binding; };

/** Wrap a handler: never throws, never returns a value (return values can alter pi behavior). */
function on(pi: ExtensionAPI, name: string, fn: (event: Obj) => void): void {
  (pi.on as (n: string, h: (e: Obj) => Promise<void>) => void)(name, async (event) => {
    try { if (active()) fn(event); } catch (e) { logError(name, e); }
  });
}

function stripDelta(ev: Obj): AssistantDelta | undefined {
  if (!ev || ev.type === "start" || ev.type === "done" || ev.type === "error") return undefined;
  const { partial: _p, message: _m, ...rest } = ev;
  return rest as AssistantDelta;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c?.type === "text").map((c) => String(c.text ?? "")).join("");
}

export function childFileOf(message: Obj): string | undefined {
  if (message?.role !== "toolResult" || !SUBAGENT_TOOLS.has(message.toolName)) return undefined;
  const d = message.details ?? {};
  const f = d.sessionFile ?? d.sessionPath;
  return typeof f === "string" && f ? f : undefined;
}

export function rememberChild(file: string): void {
  const s = g();
  s.childSessionFiles = [file, ...s.childSessionFiles.filter((x) => x !== file)].slice(0, 50);
}

/** Rebuild childSessionFiles from the active branch (plan 7.1.4). */
export function rebuildChildren(): void {
  const s = g();
  const b = s.binding;
  if (!b) return;
  const files: string[] = [];
  for (const e of b.ctx.sessionManager.getBranch() as unknown as Obj[]) {
    if (e.type !== "message") continue;
    const f = childFileOf(e.message);
    if (f) files.push(f);
  }
  const out: string[] = [];
  for (let i = files.length - 1; i >= 0 && out.length < 50; i--) if (!out.includes(files[i]!)) out.push(files[i]!);
  s.childSessionFiles = out;
}

/** Hidden custom messages and the per-run system prompt message are never shown to the user. */
const isHiddenCustom = (m: Obj) => (m?.role === "custom" && m.display === false) || m?.role === "system";

/**
 * Context usage grows with every assistant reply, not only when the run settles, and the TUI footer
 * re-reads it on each render. Emit it on every change so a long run does not leave the phone on "?".
 */
function emitContextUsage(): void {
  let usage: ReturnType<NonNullable<ReturnType<typeof g>["binding"]>["ctx"]["getContextUsage"]>;
  try { usage = g().binding?.ctx.getContextUsage(); } catch { return; }
  if (!usage) return;
  emitSafe({ type: "context_usage", usage });
}

export function registerEventForwarders(pi: ExtensionAPI): void {
  on(pi, "agent_start", () => { g().lastActiveAt = Date.now(); emitSafe({ type: "agent_start" }); refreshStatus(); });

  on(pi, "agent_settled", (event) => {
    const s = g();
    s.lastActiveAt = Date.now();
    s.lastText = lastAssistantText();
    s.inflight = undefined;
    s.runningTools.clear();
    emitSafe({ type: "agent_settled", aborted: !!event.aborted, ...(s.lastText ? { lastText: s.lastText } : {}) });
    emitContextUsage();
    s.lastStatus = undefined;   // force an info frame so lastText reaches the list
    refreshStatus();
    if (s.reloadPending) { s.reloadPending = false; runReloadNow(); }
  });

  on(pi, "message_start", (event) => {
    const m = event.message as Obj;
    if (isHiddenCustom(m)) return;
    if (m?.role === "assistant") g().inflight = m;
    emitSafe({ type: "message_start", message: sanitize(m) });
  });

  on(pi, "message_update", (event) => {
    g().inflight = event.message;
    const delta = stripDelta(event.assistantMessageEvent);
    if (delta) emitSafe({ type: "message_update", delta });
  });

  on(pi, "message_end", (event) => {
    const m = event.message as Obj;
    if (isHiddenCustom(m)) return;
    if (m?.role === "assistant") g().inflight = undefined;
    emitSafe({ type: "message_end", message: sanitize(m) });
    const child = childFileOf(m);
    if (child) { rememberChild(child); emitSafe({ type: "info", info: buildInfo() }); }
  });

  on(pi, "tool_execution_start", (event) => {
    g().runningTools.set(event.toolCallId, { toolName: event.toolName, args: event.args, partialText: "", lastSentAt: 0 });
    emitSafe({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
  });

  on(pi, "tool_execution_update", (event) => {
    const t = g().runningTools.get(event.toolCallId);
    const partialText = textOfContent(event.partialResult?.content).slice(-8000);
    if (t) t.partialText = partialText;
    const now = Date.now();
    if (t && now - t.lastSentAt < TOOL_UPDATE_MIN_MS) return;
    if (t) t.lastSentAt = now;
    emitSafe({ type: "tool_update", toolCallId: event.toolCallId, partialText });
  });

  on(pi, "tool_execution_end", (event) => {
    g().runningTools.delete(event.toolCallId);
    emitSafe({ type: "tool_end", toolCallId: event.toolCallId, toolName: event.toolName, isError: !!event.isError, ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}) });
  });

  on(pi, "model_select", (event) => {
    emitSafe({ type: "model_changed", model: summarizeModel(event.model) });
    emitSafe({ type: "info", info: buildInfo() });
  });

  on(pi, "thinking_level_select", (event) => {
    emitSafe({ type: "thinking_changed", level: String(event.level) });
    emitSafe({ type: "info", info: buildInfo() });
  });

  on(pi, "session_compact", () => {
    emitSafe({ type: "compaction", phase: "end" });
    emitContextUsage();
  });

  // By turn_end the assistant message and its tool results are persisted, so the estimate is current.
  on(pi, "turn_end", () => emitContextUsage());

  on(pi, "session_compact_failed", (event) => {
    emitSafe({ type: "compaction", phase: "failed", ...(event.errorMessage ? { error: String(event.errorMessage) } : event.aborted ? { error: "aborted" } : {}) });
  });

  on(pi, "session_info_changed", () => emitSafe({ type: "info", info: buildInfo() }));

  // /tree navigation changes the active branch without replacing the session; clients must re-snapshot.
  on(pi, "session_tree", () => emitSafe({ type: "session_changed", reason: "tree", info: buildInfo() }));
}
