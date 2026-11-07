// NOTE: packages/hostd/src/sanitize.ts is a copy of this file. Keep them identical.
import type { WireMessage } from "../../protocol/src/index.ts";

type Obj = Record<string, unknown>;
const TEXT_LIMIT = 32_000;
const DETAILS_LIMIT = 65_536;

function stripImages(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripImages);
  if (v && typeof v === "object") {
    const o = v as Obj;
    if (o.type === "image" && typeof o.data === "string") return { type: "image", mimeType: o.mimeType, omitted: true };
    const out: Obj = {};
    for (const [k, x] of Object.entries(o)) out[k] = stripImages(x);
    return out;
  }
  return v;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c && (c as Obj).type === "text").map((c) => String((c as Obj).text ?? "")).join("");
}

const ASSISTANT_KEEP = ["role", "content", "stopReason", "errorMessage", "model", "provider", "usage", "timestamp", "api", "responseId"];

/** Deep-copies a pi AgentMessage and trims it for the wire (7.1.7). */
export function sanitize(message: unknown): WireMessage {
  const m = stripImages(message) as Obj;
  const role = String(m.role ?? "unknown");
  if (role === "toolResult") {
    const content = m.content;
    if (Array.isArray(content)) {
      const total = textOf(content).length;
      if (total > TEXT_LIMIT) {
        let budget = TEXT_LIMIT;
        const next: unknown[] = [];
        for (const c of content) {
          const o = c as Obj;
          if (o?.type === "text") {
            const t = String(o.text ?? "");
            if (budget <= 0) continue;
            next.push({ ...o, text: t.slice(0, budget) });
            budget -= Math.min(budget, t.length);
          } else next.push(c);
        }
        m.content = next;
        m.truncated = true;
      }
    } else if (typeof content === "string" && content.length > TEXT_LIMIT) {
      m.content = content.slice(0, TEXT_LIMIT);
      m.truncated = true;
    }
    if (m.details !== undefined) {
      let len = 0;
      try { len = JSON.stringify(m.details)?.length ?? 0; } catch { len = Infinity; }
      if (len > DETAILS_LIMIT) delete m.details;
    }
  } else if (role === "bashExecution") {
    if (typeof m.output === "string" && m.output.length > TEXT_LIMIT) { m.output = m.output.slice(0, TEXT_LIMIT); m.truncated = true; }
  } else if (role === "assistant") {
    const out: Obj = {};
    for (const k of ASSISTANT_KEEP) if (m[k] !== undefined) out[k] = m[k];
    if (Array.isArray(out.content)) {
      out.content = (out.content as Obj[]).map((b) => {
        if (!b || typeof b !== "object") return b;
        const c: Obj = {};
        for (const [k, v] of Object.entries(b)) if (!/Signature$/i.test(k) && k !== "encrypted" && k !== "redacted") c[k] = v;
        return c;
      });
    }
    return out as WireMessage;
  }
  return { ...m, role } as WireMessage;
}

/** Converts a session entry to a wire message, or undefined when it is not displayable. */
export function entryMessage(entry: unknown): WireMessage | undefined {
  const e = entry as Obj;
  switch (e?.type) {
    case "message":
      if ((e.message as Obj)?.role === "system") return undefined;
      return { ...sanitize(e.message), entryId: e.id as string };
    case "custom_message":
      if (e.display !== true) return undefined;
      return { role: "custom", customType: e.customType, content: stripImages(e.content), details: e.details, timestamp: e.timestamp, entryId: e.id as string };
    case "compaction": return { role: "compactionSummary", summary: e.summary, timestamp: e.timestamp, entryId: e.id as string };
    case "branch_summary": return { role: "branchSummary", summary: e.summary, timestamp: e.timestamp, entryId: e.id as string };
    default: return undefined;
  }
}
