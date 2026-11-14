import { randomBytes } from "node:crypto";
import { parseBlocks, parseFollowUpSeq, type Ref, stripBlocks, textOf, withoutImage } from "./context.ts";
import { broadcast, type Hub, type Pin, type Thread } from "./hub.ts";
import { renderReply } from "./render.ts";

const MAX_THREADS = 150;
const STREAM_INTERVAL_MS = 150;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export const newId = () => randomBytes(6).toString("hex");

export function refPayload(r: Ref) {
  return { docId: r.docId, label: r.label, anchor: withoutImage(r.anchor) };
}

export function pinPayload(p: Pin) {
  return { id: p.id, ...refPayload(p.ref), note: p.note, hasImage: !!p.imagePath, at: p.at };
}

function replyText(t: Thread): string {
  return [...t.parts, t.live].filter((s) => s.trim()).join("\n\n");
}

export async function threadPayload(t: Thread) {
  if (t.dirty || t.html === undefined) {
    t.dirty = false;
    t.html = await renderReply(replyText(t));
  }
  return {
    id: t.id,
    seq: t.seq,
    ...(t.replyToSeq ? { replyToSeq: t.replyToSeq } : {}),
    refs: t.refs.map(refPayload),
    question: t.question,
    html: t.html,
    status: t.status,
    activity: t.activity,
    at: t.at,
  };
}

/** Push a thread to the pages; streaming updates are coalesced. */
export function publishThread(h: Hub, t: Thread, now = false): void {
  t.dirty = true;
  const pending = timers.get(t.id);
  if (pending && !now) return;
  clearTimeout(pending);
  timers.set(
    t.id,
    setTimeout(
      () => {
        timers.delete(t.id);
        threadPayload(t)
          .then((p) => broadcast(h, "thread", p))
          .catch(() => undefined);
      },
      now ? 0 : STREAM_INTERVAL_MS,
    ),
  );
}

/** A user message entered the conversation: it starts a thread, with references parsed from its context blocks. */
export function startThread(h: Hub, text: string, cwd: string, at = Date.now()): Thread {
  const refs = parseBlocks(text, cwd);
  for (const r of refs) h.knownPaths.set(r.docId, r.path);
  const seq = h.nextSeq++;
  const replyToSeq = parseFollowUpSeq(text);
  const t: Thread = {
    id: newId(),
    seq,
    ...(replyToSeq ? { replyToSeq } : {}),
    refs,
    question: stripBlocks(text).slice(0, 4000),
    parts: [],
    live: "",
    status: "running",
    at,
    dirty: true,
  };
  h.threads.push(t);
  if (h.threads.length > MAX_THREADS) h.threads.splice(0, h.threads.length - MAX_THREADS);
  return t;
}

interface MessageEntry {
  type?: string;
  message?: { role?: string; content?: unknown; timestamp?: number };
}

/** Rebuild all threads from the active session branch, so a resumed session shows its earlier answers. */
export function rebuildThreads(h: Hub, entries: readonly unknown[], cwd: string): void {
  h.threads = [];
  h.nextSeq = 1;
  h.activeThread = undefined;
  let current: Thread | undefined;
  for (const e of entries as MessageEntry[]) {
    const m = e.type === "message" ? e.message : undefined;
    if (!m) continue;
    if (m.role === "user") {
      current = startThread(h, textOf(m.content), cwd, m.timestamp);
      current.status = "done";
    } else if (m.role === "assistant" && current) {
      const text = textOf(m.content);
      if (text.trim()) current.parts.push(text);
    }
  }
}

export function snapshotThreads(h: Hub) {
  return Promise.all(h.threads.map(threadPayload));
}

/** One-line description of a tool call, shown as progress under the streaming answer. */
export function describeTool(name: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const detail = [a.path, a.file, a.command, a.query, a.pattern, a.url].find((v) => typeof v === "string") as string | undefined;
  return detail ? `${name} ${detail.replace(/\s+/g, " ").slice(0, 80)}` : name;
}
