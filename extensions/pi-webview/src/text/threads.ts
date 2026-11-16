import { addTurnConsumer, renderTurnReply, type Turn, turnState } from "../shared/turns.ts";
import { parseBlocks, type Ref, withoutImage } from "./context.ts";
import { broadcast, type Hub, type Pin, type Star, statusPayload } from "./hub.ts";

const STREAM_INTERVAL_MS = 150;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const refsCache = new WeakMap<Turn, Ref[]>();

export function refPayload(r: Ref) {
  return { docId: r.docId, label: r.label, anchor: withoutImage(r.anchor) };
}

export function pinPayload(p: Pin) {
  return { id: p.id, ...refPayload(p.ref), note: p.note, hasImage: !!p.imagePath, at: p.at };
}

export function starPayload(s: Star) {
  return {
    id: s.id,
    docId: s.docId,
    anchorKey: s.anchorKey,
    anchor: withoutImage(s.anchor),
    label: s.label,
    threadSeq: s.threadSeq,
    question: s.question,
    scope: s.scope,
    excerpt: s.excerpt,
    html: s.html,
    at: s.at,
  };
}

/** Document references of a turn, parsed from its <browser-context> blocks once. */
function refsOf(h: Hub, t: Turn): Ref[] {
  let refs = refsCache.get(t);
  if (!refs) {
    refs = parseBlocks(t.text, h.cwd ?? process.cwd());
    for (const r of refs) h.knownPaths.set(r.docId, r.path);
    refsCache.set(t, refs);
  }
  return refs;
}

export async function threadPayload(h: Hub, t: Turn) {
  return {
    id: t.id,
    seq: t.seq,
    ...(t.replyToSeq ? { replyToSeq: t.replyToSeq } : {}),
    refs: refsOf(h, t).map(refPayload),
    question: t.question,
    html: await renderTurnReply(t),
    status: t.status,
    ...(t.status === "running" && t.phase ? { phase: t.phase } : {}),
    ...(t.status === "running" && t.thinking ? { thinking: t.thinking } : {}),
    ...(t.activity ? { activity: t.activity } : {}),
    ...(t.status === "running" && t.steps?.length ? { steps: t.steps } : {}),
    at: t.at,
  };
}

/** Push a turn to the pages; streaming updates are coalesced. */
function publishThread(h: Hub, t: Turn, now = false): void {
  const pending = timers.get(t.id);
  if (pending && !now) return;
  clearTimeout(pending);
  timers.set(
    t.id,
    setTimeout(
      () => {
        timers.delete(t.id);
        threadPayload(h, t)
          .then((p) => broadcast(h, "thread", p))
          .catch(() => undefined);
      },
      now ? 0 : STREAM_INTERVAL_MS,
    ),
  );
}

export function snapshotThreads(h: Hub) {
  return Promise.all(turnState().turns.map((t) => threadPayload(h, t)));
}

/** Parse references of every turn, so links to documents seen only in history resolve before any page asks. */
export function primeThreads(h: Hub): void {
  for (const t of turnState().turns) refsOf(h, t);
}

/** Mirror session turns into the document pages. Every turn is shown (the Wire lists them all). */
export function installThreadMirror(h: Hub): void {
  addTurnConsumer("text", {
    // The text module's own session_start/session_tree handler runs right after the rebuild, once
    // h.cwd is current; it primes references and pushes the new list (see loadSessionState).
    reset() {},
    update(t, now) {
      refsOf(h, t);
      publishThread(h, t, now);
    },
    busy(busy) {
      h.busy = busy;
      broadcast(h, "status", statusPayload(h));
    },
  });
}
