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
const covered = new Set<string>();
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
      refreshStatus();
    } catch (e) { logError("rpiv prompt", e); }
  });
  pi.events.on(BLOCKED, (raw: unknown) => {
    try {
      const p = raw as { active?: boolean; toolCallId?: string };
      if (p?.active === false && typeof p.toolCallId === "string" && g().rpivOpen.delete(p.toolCallId)) {
        openedAt.delete(p.toolCallId);
        covered.delete(p.toolCallId);
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

/** The questionnaire opened in the last 2s that no custom() dialog has claimed yet. */
export function latestUncoveredRpiv(): string | undefined {
  const now = Date.now();
  let best: string | undefined;
  let bestAt = 0;
  for (const [id, at] of openedAt) if (now - at <= 2000 && !covered.has(id) && at >= bestAt) { best = id; bestAt = at; }
  if (best) covered.add(best);
  return best;
}

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
