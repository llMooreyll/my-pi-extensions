import { randomBytes } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseFollowUpSeq, stripContextBlocks } from "./blocks.ts";
import { renderReply } from "./markdown.ts";
import { textOf, thinkingOf, toolCallNameOf } from "./messages.ts";

export type TurnStatus = "running" | "done" | "aborted";
export type TurnPhase = "waiting" | "thinking" | "toolcall" | "tool" | "answering";

export interface TurnStep {
  label: string;
  state: "running" | "done" | "error";
  /** Tool call id, to finish the right step when calls run in parallel. */
  id?: string;
}

/**
 * One user message and the assistant output that followed it. Turns are derived from the session
 * alone; feature modules read their own context blocks from `text` to decide which turns they show.
 */
export interface Turn {
  id: string;
  /** 1-based deterministic turn number within the active session branch. */
  seq: number;
  /** Referenced earlier turn number when this message is a follow-up. */
  replyToSeq?: number;
  /** The full user message, context blocks included. */
  text: string;
  /** What the user typed: the message without context blocks. */
  question: string;
  /** Finished assistant texts of this run. */
  parts: string[];
  /** The assistant text currently streaming. */
  live: string;
  status: TurnStatus;
  /** Current live execution phase while running. */
  phase?: TurnPhase;
  /** Live thinking excerpt while the model is reasoning. */
  thinking?: string;
  /** Tool currently running, shown as progress. */
  activity?: string;
  /** Compact list of tool steps executed in the active run. */
  steps?: TurnStep[];
  at: number;
}

/** A feature module that mirrors turns into its own pages. */
export interface TurnConsumer {
  /** The whole list was rebuilt (session start, /resume, /tree). */
  reset(turns: readonly Turn[]): void;
  /** One turn changed; `now` asks to skip stream coalescing (state transitions). */
  update(turn: Turn, now: boolean): void;
  busy?(busy: boolean): void;
}

interface TurnState {
  turns: Turn[];
  nextSeq: number;
  active?: Turn;
  busy: boolean;
  consumers: Map<string, TurnConsumer>;
}

const MAX_TURNS = 150;
const STATE_KEY = Symbol.for("pi-webview.turns");

export const newId = () => randomBytes(6).toString("hex");

/** Process-wide, so /reload keeps the list; session_start rebuilds it from the branch anyway. */
export function turnState(): TurnState {
  const g = globalThis as unknown as Record<symbol, TurnState | undefined>;
  g[STATE_KEY] ??= { turns: [], nextSeq: 1, busy: false, consumers: new Map() };
  return g[STATE_KEY]!;
}

export function addTurnConsumer(name: string, consumer: TurnConsumer): void {
  turnState().consumers.set(name, consumer);
}

export function findTurn(id: string | undefined): Turn | undefined {
  return id ? turnState().turns.find((t) => t.id === id) : undefined;
}

/** True when `turn` is the latest turn, so a follow-up needs no explicit back-reference. */
export function isLatestTurn(turn: Turn): boolean {
  return turnState().turns.at(-1)?.id === turn.id;
}

export function replyText(t: Turn): string {
  return [...t.parts, t.live].filter((s) => s.trim()).join("\n\n");
}

const renderCache = new WeakMap<Turn, { text: string; html: string; mathml: boolean }[]>();

/** Rendered reply HTML, cached per turn and math mode until the reply text changes. */
export async function renderTurnReply(t: Turn, mathml = false): Promise<string> {
  const text = replyText(t);
  const entries = renderCache.get(t) ?? [];
  const hit = entries.find((e) => e.mathml === mathml);
  if (hit && hit.text === text) return hit.html;
  const html = await renderReply(text, { mathml });
  renderCache.set(t, [...entries.filter((e) => e.mathml !== mathml), { text, html, mathml }]);
  return html;
}

/** One-line description of a tool call, shown as progress under the streaming answer. */
export function describeTool(name: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const detail = [a.path, a.file, a.command, a.query, a.pattern, a.url].find((v) => typeof v === "string") as string | undefined;
  return detail ? `${name} ${detail.replace(/\s+/g, " ").slice(0, 80)}` : name;
}

function notify(t: Turn, now: boolean): void {
  for (const c of turnState().consumers.values()) c.update(t, now);
}

function notifyBusy(busy: boolean): void {
  const s = turnState();
  s.busy = busy;
  for (const c of s.consumers.values()) c.busy?.(busy);
}

function startTurn(text: string, at = Date.now()): Turn {
  const s = turnState();
  const replyToSeq = parseFollowUpSeq(text);
  const t: Turn = {
    id: newId(),
    seq: s.nextSeq++,
    ...(replyToSeq ? { replyToSeq } : {}),
    text,
    question: stripContextBlocks(text).slice(0, 4000),
    parts: [],
    live: "",
    status: "running",
    phase: "waiting",
    at,
  };
  s.turns.push(t);
  if (s.turns.length > MAX_TURNS) s.turns.splice(0, s.turns.length - MAX_TURNS);
  return t;
}

function finish(t: Turn, status: TurnStatus): void {
  t.status = status;
  t.phase = undefined;
  t.thinking = undefined;
  t.activity = undefined;
  t.steps = undefined;
}

interface MessageEntry {
  type?: string;
  message?: { role?: string; content?: unknown; timestamp?: number };
}

/** Rebuild all turns from the active session branch, so a resumed session shows its earlier answers. */
function rebuild(entries: readonly unknown[]): void {
  const s = turnState();
  s.turns = [];
  s.nextSeq = 1;
  s.active = undefined;
  let current: Turn | undefined;
  for (const e of entries as MessageEntry[]) {
    const m = e.type === "message" ? e.message : undefined;
    if (!m) continue;
    if (m.role === "user") {
      current = startTurn(textOf(m.content), m.timestamp);
      current.status = "done";
      current.phase = undefined;
    } else if (m.role === "assistant" && current) {
      const text = textOf(m.content);
      if (text.trim()) current.parts.push(text);
    }
  }
  for (const c of s.consumers.values()) c.reset(s.turns);
}

/** Register the session listeners that derive turns. Call once, before feature modules register theirs. */
export function installTurnTracking(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    turnState().busy = !ctx.isIdle();
    rebuild(ctx.sessionManager.getBranch());
  });

  pi.on("session_tree", async (_event, ctx) => {
    rebuild(ctx.sessionManager.getBranch());
  });

  pi.on("agent_start", async () => {
    notifyBusy(true);
  });

  pi.on("agent_settled", async (event) => {
    const s = turnState();
    const t = s.active;
    if (t) {
      finish(t, event.aborted ? "aborted" : "done");
      notify(t, true);
      s.active = undefined;
    }
    notifyBusy(false);
  });

  // Every user message opens a turn; the assistant output after it streams into that turn.
  pi.on("message_start", async (event) => {
    const s = turnState();
    if (event.message.role === "assistant") {
      const t = s.active;
      if (t) {
        t.phase = "waiting";
        t.thinking = undefined;
        t.activity = undefined;
        notify(t, true);
      }
      return;
    }
    if (event.message.role !== "user") return;
    const prev = s.active;
    if (prev?.status === "running") {
      finish(prev, "done");
      notify(prev, true);
    }
    s.active = startTurn(textOf(event.message.content));
    notify(s.active, true);
  });

  pi.on("message_update", async (event) => {
    const t = turnState().active;
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
    notify(t, false);
  });

  pi.on("message_end", async (event) => {
    const t = turnState().active;
    if (!t || event.message.role !== "assistant") return;
    const text = textOf(event.message.content);
    if (text.trim()) t.parts.push(text);
    t.live = "";
    t.thinking = undefined;
    if (t.phase !== "tool" && t.phase !== "toolcall") t.phase = "waiting";
    notify(t, false);
  });

  pi.on("tool_execution_start", async (event) => {
    const t = turnState().active;
    if (!t) return;
    const label = describeTool(event.toolName, event.args);
    t.phase = "tool";
    t.thinking = undefined;
    t.activity = label;
    t.steps ??= [];
    t.steps.push({ label, state: "running", id: event.toolCallId });
    if (t.steps.length > 8) t.steps.splice(0, t.steps.length - 8);
    notify(t, true);
  });

  pi.on("tool_execution_end", async (event) => {
    const t = turnState().active;
    if (!t) return;
    const step = t.steps?.find((s) => s.id === event.toolCallId) ?? [...(t.steps ?? [])].reverse().find((s) => s.state === "running");
    if (step && step.state === "running") step.state = event.isError ? "error" : "done";
    t.activity = undefined;
    t.phase = "waiting";
    notify(t, true);
  });
}
