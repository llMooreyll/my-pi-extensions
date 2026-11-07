import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RpivAnswer, RpivPrompt } from "../../protocol/src/index.ts";
import { emitSafe } from "./host-conn.ts";
import { logError } from "./log.ts";
import { need, refreshStatus } from "./snapshot.ts";
import { g } from "./state.ts";

// Event contract: @juicesharp/rpiv-ask-user-question docs/tool-schema.md "Event contract".
const PROMPT = "rpiv:ask-user:prompt";
const BLOCKED = "rpiv:ask-user:blocked";
const ANSWER = "rpiv:ask-user:answer";
const ANSWER_RESULT = "rpiv:ask-user:answer-result";

const openedAt = new Map<string, number>();
const resultWaiters = new Map<string, (v: { ok?: boolean; code?: string; reason?: string }) => void>();

export function registerRpiv(pi: ExtensionAPI): void {
  pi.events.on(PROMPT, (raw: unknown) => {
    try {
      const p = raw as { toolCallId?: string; questions?: any[] };
      if (!g().enabled || typeof p?.toolCallId !== "string") return;
      const prompt: RpivPrompt = {
        toolCallId: p.toolCallId,
        questions: (p.questions ?? []).map((q: any) => ({
          question: String(q.question ?? ""), header: String(q.header ?? ""), multiSelect: !!q.multiSelect,
          options: (q.options ?? []).map((o: any) => ({ label: String(o.label ?? ""), ...(o.description ? { description: String(o.description) } : {}), ...(o.hasPreview ? { hasPreview: true } : {}) })),
        })),
      };
      g().rpivOpen.set(prompt.toolCallId, prompt);
      openedAt.set(prompt.toolCallId, Date.now());
      emitSafe({ type: "rpiv_prompt", prompt });
      claimRecentCustom(prompt.toolCallId);
      refreshStatus();
    } catch (e) { logError("rpiv prompt", e); }
  });
  pi.events.on(BLOCKED, (raw: unknown) => {
    try {
      const p = raw as { active?: boolean; toolCallId?: string };
      if (p?.active === false && typeof p.toolCallId === "string" && g().rpivOpen.delete(p.toolCallId)) {
        openedAt.delete(p.toolCallId);
        emitSafe({ type: "rpiv_closed", toolCallId: p.toolCallId });
        refreshStatus();
      }
    } catch (e) { logError("rpiv blocked", e); }
  });
  pi.events.on(ANSWER_RESULT, (raw: unknown) => {
    const v = raw as { requestId?: string; ok?: boolean; code?: string; reason?: string };
    if (v?.requestId) resultWaiters.get(v.requestId)?.(v);
  });
}

/**
 * The questionnaire a custom() dialog belongs to: the most recently opened one that is still open.
 * ask_user_question may mount its custom() more than once per questionnaire (e.g. it re-mounts as a stacked
 * overlay when the inline slot must yield), possibly long after the prompt event, so no time window applies.
 */
export function latestUncoveredRpiv(): string | undefined {
  let best: string | undefined;
  let bestAt = -1;
  for (const [id, at] of openedAt) if (g().rpivOpen.has(id) && at > bestAt) { best = id; bestAt = at; }
  return best;
}

/** Reverse order: a custom() opened just before its prompt event is tagged afterwards and re-announced. */
function claimRecentCustom(toolCallId: string): void {
  const now = Date.now();
  for (const pending of g().pendingUi.values()) {
    const req = pending.req;
    if (req.kind !== "custom" || req.coveredBy || now - (customOpenedAt.get(req.uiId) ?? 0) > 3000) continue;
    req.coveredBy = toolCallId;
    emitSafe({ type: "ui_request", req });
  }
}

/** When each custom() dialog opened; ui-mirror records it. */
export const customOpenedAt = new Map<string, number>();

export function rpivAnswer(answer: RpivAnswer): Promise<{ ok: boolean; code?: string; reason?: string }> {
  const b = need();
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resultWaiters.delete(requestId); resolve({ ok: false, code: "timeout", reason: "no answer-result within 3s" }); }, 3000);
    resultWaiters.set(requestId, (v) => {
      clearTimeout(timer);
      resultWaiters.delete(requestId);
      resolve({ ok: !!v.ok, ...(v.code ? { code: v.code } : {}), ...(v.reason ? { reason: v.reason } : {}) });
    });
    b.pi.events.emit(ANSWER, { ...answer, requestId });
  });
}
