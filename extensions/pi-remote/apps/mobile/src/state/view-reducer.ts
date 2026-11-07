import type { AssistantDelta, BridgeEvent, Snapshot, WireMessage } from "@pi-remote/protocol";
import { textOf } from "../lib/format";
import type { AssistantDraft, Block, ProcessView, Toast } from "./types";

let toastSeq = 0;
const toast = (text: string, level: string): Toast => ({ id: `t${++toastSeq}`, text, level, at: Date.now() });

export function fromSnapshot(s: Snapshot): ProcessView {
  const runningTools: ProcessView["runningTools"] = {};
  for (const t of s.runningTools) runningTools[t.toolCallId] = { toolName: t.toolName, args: t.args, partialText: t.partialText };
  return {
    seq: s.seq,
    info: s.info,
    messages: s.messages,
    hasMoreBefore: s.hasMoreBefore,
    inflight: s.inflight ? draftFromMessage(s.inflight) : undefined,
    runningTools,
    pendingUi: s.pendingUi,
    pendingRpiv: s.pendingRpiv,
    extStatus: s.extStatus,
    extWidgets: s.extWidgets,
    toasts: [],
    queued: [],
    lastViewedAt: Date.now(),
  };
}

function draftFromMessage(m: WireMessage): AssistantDraft {
  return { role: "assistant", content: Array.isArray(m.content) ? (m.content as Block[]) : [] };
}

function applyDelta(draft: AssistantDraft | undefined, d: AssistantDelta): AssistantDraft {
  const content = draft ? [...draft.content] : [];
  const i = d.contentIndex;
  const cur = content[i] as Record<string, any> | undefined;
  switch (d.type) {
    case "text_start": content[i] = { type: "text", text: "" }; break;
    case "text_delta": content[i] = { type: "text", text: (cur?.text ?? "") + d.delta }; break;
    case "text_end": content[i] = { type: "text", text: d.content }; break;
    case "thinking_start": content[i] = { type: "thinking", thinking: "" }; break;
    case "thinking_delta": content[i] = { type: "thinking", thinking: (cur?.thinking ?? "") + d.delta }; break;
    case "thinking_end": content[i] = { type: "thinking", thinking: d.content }; break;
    case "toolcall_start": content[i] = { type: "toolCall", id: d.id, name: d.toolName, arguments: {}, argsText: "" }; break;
    case "toolcall_delta": content[i] = { ...(cur ?? { type: "toolCall", id: "", name: "", arguments: {} }), argsText: (cur?.argsText ?? "") + d.delta } as Block; break;
    case "toolcall_end": content[i] = d.toolCall as Block; break;
  }
  for (let k = 0; k < content.length; k++) if (content[k] === undefined) content[k] = { type: "text", text: "" };
  return { role: "assistant", content };
}

export interface ReduceResult { view: ProcessView; needsResync?: boolean }

/** Pure reducer: returns a new view and never mutates its input. */
export function applyEvent(v: ProcessView, ev: BridgeEvent, seq: number): ReduceResult {
  const n: ProcessView = { ...v, seq };
  switch (ev.type) {
    case "session_changed": n.info = ev.info; n.queued = []; return { view: n, needsResync: true };
    case "info": n.info = ev.info; break;
    case "agent_start": break;
    // Once pi is idle nothing is waiting any more: delivered, or dropped by an abort.
    case "agent_settled": n.inflight = undefined; n.runningTools = {}; n.queued = []; break;
    case "message_start": if (ev.message.role === "assistant") n.inflight = { role: "assistant", content: [] }; break;
    case "message_update": n.inflight = applyDelta(v.inflight, ev.delta); break;
    case "message_end":
      n.messages = [...v.messages, ev.message];
      if (ev.message.role === "assistant") n.inflight = undefined;
      if (ev.message.role === "user" && v.queued.length) {
        // The queued message has been delivered: it now appears in the conversation for real.
        const c = (ev.message as { content?: unknown }).content;
        const text = (typeof c === "string" ? c : textOf(c)).trim();
        const at = v.queued.findIndex((q) => q.text.trim() === text);
        if (at >= 0) n.queued = v.queued.filter((_, i) => i !== at);
      }
      break;
    case "tool_start": n.runningTools = { ...v.runningTools, [ev.toolCallId]: { toolName: ev.toolName, args: ev.args, partialText: "" } }; break;
    case "tool_update": {
      const t = v.runningTools[ev.toolCallId];
      if (t) n.runningTools = { ...v.runningTools, [ev.toolCallId]: { ...t, partialText: ev.partialText } };
      break;
    }
    case "tool_end": { const r = { ...v.runningTools }; delete r[ev.toolCallId]; n.runningTools = r; break; }
    case "model_changed": n.info = { ...v.info, model: ev.model }; break;
    case "thinking_changed": n.info = { ...v.info, thinkingLevel: ev.level }; break;
    case "compaction":
      n.toasts = [...v.toasts, toast(ev.phase === "end" ? "Context compacted" : `Compaction failed${ev.error ? `: ${ev.error}` : ""}`, ev.phase === "end" ? "info" : "error")];
      if (ev.phase === "end") return { view: n, needsResync: true };
      break;
    case "context_usage": n.info = { ...v.info, contextUsage: ev.usage }; break;
    case "ui_request": n.pendingUi = [...v.pendingUi.filter((u) => u.uiId !== ev.req.uiId), ev.req]; break;
    case "ui_closed": n.pendingUi = v.pendingUi.filter((u) => u.uiId !== ev.uiId); break;
    case "rpiv_prompt": n.pendingRpiv = [...v.pendingRpiv.filter((p) => p.toolCallId !== ev.prompt.toolCallId), ev.prompt]; break;
    case "rpiv_closed": n.pendingRpiv = v.pendingRpiv.filter((p) => p.toolCallId !== ev.toolCallId); break;
    case "notify": n.toasts = [...v.toasts, toast(ev.message, ev.level)]; break;
    case "ext_status": {
      const s = { ...v.extStatus };
      if (ev.text) s[ev.key] = ev.text; else delete s[ev.key];
      n.extStatus = s;
      break;
    }
    case "ext_widget": {
      const w = { ...v.extWidgets };
      if (ev.lines && ev.lines.length) w[ev.key] = { lines: ev.lines, placement: ev.placement }; else delete w[ev.key];
      n.extWidgets = w;
      break;
    }
    case "error": n.toasts = [...v.toasts, toast(ev.message, "error")]; break;
  }
  return { view: n };
}
