import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ForkPoint, ModelSummary, ProcessInfo, ProcessStatus, Snapshot, TreeNodeWire, WireMessage } from "../../protocol/src/index.ts";
import { emitSafe } from "./host-conn.ts";
import { detectRole } from "./role.ts";
import { entryMessage, sanitize } from "./sanitize.ts";
import { g, type Binding } from "./state.ts";
import { err } from "./types.ts";

type Obj = Record<string, any>;

export function need(): Binding {
  const b = g().binding;
  if (!b) throw err("replacing", "session is being replaced");
  return b;
}

export function summarizeModel(m: Obj): ModelSummary {
  return { provider: m.provider, id: m.id, name: m.name ?? m.id, reasoning: !!m.reasoning, input: m.input ?? ["text"], ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}) };
}

export function currentStatus(): ProcessStatus {
  const s = g();
  if (s.pendingUi.size + s.rpivOpen.size > 0) return "waiting_ui";
  const b = s.binding;
  if (!b) return "idle";
  try { return b.ctx.isIdle() ? "idle" : "running"; } catch { return "idle"; }
}

/** Last activity: set by run and message events; before any, the time of the last entry in the session. */
function lastActiveAt(): number | undefined {
  const s = g();
  if (s.lastActiveAt === undefined && s.binding) {
    try {
      const last = s.binding.ctx.sessionManager.getBranch().at(-1) as { timestamp?: string } | undefined;
      const t = last?.timestamp ? Date.parse(last.timestamp) : NaN;
      if (!Number.isNaN(t)) s.lastActiveAt = t;
    } catch { /* unknown until the next event */ }
  }
  return s.lastActiveAt;
}

export function buildInfo(): ProcessInfo {
  const s = g();
  const b = s.binding;
  const base = {
    processId: s.processId, pid: process.pid, role: detectRole(), childSessionFiles: [...s.childSessionFiles],
    ...(process.env.TMUX_PANE ? { tmuxPane: process.env.TMUX_PANE } : {}),
    spawnedByHostd: !!process.env.PI_REMOTE_SPAWN_TOKEN, piVersion: VERSION, compat: s.compat,
    status: currentStatus(), pendingUiCount: s.pendingUi.size + s.rpivOpen.size,
    ...(s.lastText ? { lastText: s.lastText } : {}), lastSeq: s.seq,
    ...(lastActiveAt() ? { lastActiveAt: lastActiveAt() } : {}),
  };
  if (!b) return { ...base, cwd: process.cwd(), sessionId: "", thinkingLevel: "off" };
  const ctx = b.ctx;
  const sm = ctx.sessionManager;
  let usage: ProcessInfo["contextUsage"];
  try { usage = ctx.getContextUsage() ?? undefined; } catch { usage = undefined; }
  const file = sm.getSessionFile();
  const name = sm.getSessionName();
  return {
    ...base,
    cwd: ctx.cwd, sessionId: sm.getSessionId(),
    ...(file ? { sessionFile: file } : {}), ...(name ? { sessionName: name } : {}),
    ...(ctx.model ? { model: summarizeModel(ctx.model) } : {}),
    thinkingLevel: String(b.pi.getThinkingLevel()),
    ...(usage ? { contextUsage: usage } : {}),
  };
}

/** Emits `info` when the status changed since the last call. */
export function refreshStatus(): void {
  const s = g();
  const st = currentStatus();
  if (st === s.lastStatus) return;
  s.lastStatus = st;
  emitSafe({ type: "info", info: buildInfo() });
}

function branchMessages(): WireMessage[] {
  const b = need();
  return b.ctx.sessionManager.getBranch().map(entryMessage).filter((m): m is WireMessage => !!m);
}

/** Built synchronously so seq and content stay consistent. */
export function getSnapshot(maxMessages: number): Snapshot {
  const s = g();
  const all = branchMessages();
  const messages = all.slice(Math.max(0, all.length - maxMessages));
  const extWidgets: Snapshot["extWidgets"] = {};
  for (const [k, v] of s.extWidgets) extWidgets[k] = { lines: v.lines, placement: v.placement };
  return {
    info: buildInfo(),
    seq: s.seq,
    messages,
    hasMoreBefore: all.length > messages.length,
    ...(s.inflight ? { inflight: sanitize(s.inflight) } : {}),
    runningTools: [...s.runningTools].map(([toolCallId, t]) => ({ toolCallId, toolName: t.toolName, args: t.args, partialText: t.partialText })),
    pendingUi: [...s.pendingUi.values()].map((p) => p.req),
    pendingRpiv: [...s.rpivOpen.values()],
    extStatus: Object.fromEntries(s.extStatus),
    extWidgets,
  };
}

export function getHistory(beforeEntryId: string, limit = 100): { messages: WireMessage[]; hasMoreBefore: boolean } {
  const all = branchMessages();
  const i = all.findIndex((m) => m.entryId === beforeEntryId);
  if (i < 0) throw err("not_found", "entry not found on the active branch");
  const start = Math.max(0, i - limit);
  return { messages: all.slice(start, i), hasMoreBefore: start > 0 };
}

function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) for (const c of content) if (c?.type === "text" && c.text) return String(c.text);
  return "";
}

function kindOf(e: Obj): TreeNodeWire["kind"] {
  if (e.type === "message") {
    const r = e.message?.role;
    if (r === "user" || r === "assistant" || r === "toolResult") return r;
    if (r === "bashExecution") return "bash";
    if (r === "custom") return "custom";
    return "other";
  }
  if (e.type === "custom_message") return "custom";
  if (e.type === "compaction") return "compaction";
  if (e.type === "branch_summary") return "branch_summary";
  return "other";
}

function previewOf(e: Obj): string {
  if (e.type === "message") {
    const m = e.message ?? {};
    if (m.role === "bashExecution") return `$ ${m.command ?? ""}`;
    if (m.role === "toolResult") return `${m.toolName ?? "tool"}: ${firstText(m.content)}`;
    const t = firstText(m.content);
    if (t) return t;
    if (Array.isArray(m.content)) {
      const tc = m.content.find((c: Obj) => c?.type === "toolCall");
      if (tc) return "";
    }
    return "";
  }
  if (e.type === "custom_message") return firstText(e.content);
  if (e.type === "compaction" || e.type === "branch_summary") return String(e.summary ?? "");
  return String(e.type ?? "");
}

export function getTree(): { nodes: TreeNodeWire[]; leafId: string | null } {
  const sm = need().ctx.sessionManager;
  const active = new Set(sm.getBranch().map((e) => e.id));
  const leafId = sm.getLeafId();
  const out: TreeNodeWire[] = [];
  const stack = [...sm.getTree()].reverse();
  // Iterative pre-order walk: session trees can be deep enough to overflow recursion.
  while (stack.length) {
    const n = stack.pop()!;
    const e = n.entry as unknown as Obj;
    out.push({
      id: e.id, parentId: e.parentId ?? null, kind: kindOf(e), preview: previewOf(e).replace(/\s+/g, " ").slice(0, 120),
      ...(n.label ? { label: n.label } : {}), timestamp: e.timestamp, onActivePath: active.has(e.id), isLeaf: e.id === leafId, childCount: n.children.length,
    });
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  return { nodes: out, leafId: leafId ?? null };
}

export function getForkPoints(): ForkPoint[] {
  const sm = need().ctx.sessionManager;
  const out: ForkPoint[] = [];
  for (const e of sm.getBranch() as unknown as Obj[]) {
    if (e.type === "message" && e.message?.role === "user") out.push({ entryId: e.id, text: firstText(e.message.content), timestamp: e.timestamp });
  }
  return out;
}

export function lastAssistantText(): string | undefined {
  const b = g().binding;
  if (!b) return undefined;
  const branch = b.ctx.sessionManager.getBranch() as unknown as Obj[];
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!;
    if (e.type === "message" && e.message?.role === "assistant") {
      const c = e.message.content;
      const t = Array.isArray(c) ? c.filter((x: Obj) => x?.type === "text").map((x: Obj) => x.text).join("") : String(c ?? "");
      if (t.trim()) return t.trim().slice(0, 120);
    }
  }
  return undefined;
}
