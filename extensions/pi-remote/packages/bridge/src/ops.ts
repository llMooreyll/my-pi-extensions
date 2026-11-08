import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { HIDDEN_COMMAND, type ImageInput, type RpivAnswer, type UiResponse } from "../../protocol/src/index.ts";
import { emitSafe } from "./host-conn.ts";
import { reloadWhenIdle, runWithCommandCtx } from "./remote-op-cmd.ts";
import { rpivAnswer } from "./rpiv.ts";
import { getForkPoints, getHistory, getSnapshot, getTree, need, summarizeModel } from "./snapshot.ts";
import { g } from "./state.ts";
import { err } from "./types.ts";

type Args = Record<string, any>;

function needIdle(): void {
  if (!need().ctx.isIdle()) throw err("busy", "agent is running");
}

function supportedLevels(): string[] {
  const m = need().ctx.model;
  return m ? getSupportedThinkingLevels(m).map(String) : ["off"];
}

async function opPrompt(a: Args): Promise<{ accepted: true }> {
  const b = need();
  const text = String(a.text ?? "");
  const images = (a.images ?? []) as ImageInput[];
  const isCommand = text.startsWith("/");
  const idle = b.ctx.isIdle();
  if (!idle && !a.deliverAs && !isCommand) throw err("busy_need_deliver_as", "agent is running; choose steer or followUp");
  if (!b.ctx.model && !isCommand) throw err("no_model", "no model selected");
  if (images.length) {
    const input: string[] = (b.ctx.model as { input?: string[] } | undefined)?.input ?? [];
    if (!input.includes("image")) throw err("model_no_image", "current model does not accept images");
  }
  const content = images.length
    ? [{ type: "text" as const, text }, ...images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }))]
    : text;
  // Extension commands run immediately even while streaming; templates/skills need a delivery mode then.
  const deliverAs = idle ? undefined : (a.deliverAs ?? "followUp");
  b.pi.sendUserMessage(content, { ...(deliverAs ? { deliverAs } : {}), expandPromptTemplates: true });
  return { accepted: true };
}

function textOfContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join("");
}

const HANDLERS: Record<string, (a: Args) => unknown | Promise<unknown>> = {
  get_snapshot: (a) => getSnapshot(Number(a.maxMessages ?? 200)),
  get_history: (a) => getHistory(String(a.beforeEntryId), a.limit ?? 100),
  prompt: opPrompt,
  abort: () => { need().ctx.abort(); return {}; },
  ui_respond: (a) => {
    need();
    const p = g().pendingUi.get(String(a.uiId));
    if (!p) throw err("not_found", "dialog already closed");
    p.respond(a.response as UiResponse);
    return {};
  },
  rpiv_answer: (a) => rpivAnswer(a.answer as RpivAnswer),
  get_commands: () => ({
    commands: need().pi.getCommands()
      .filter((c) => c.name !== HIDDEN_COMMAND)
      .map((c) => ({ name: c.name, ...(c.description ? { description: c.description } : {}), source: String(c.source) })),
  }),
  get_models: () => {
    const ctx = need().ctx;
    return { ...(ctx.model ? { current: summarizeModel(ctx.model) } : {}), models: ctx.modelRegistry.getAvailable().map(summarizeModel) };
  },
  set_model: async (a) => {
    const b = need();
    const m = b.ctx.modelRegistry.find(String(a.provider), String(a.id));
    if (!m) throw err("not_found", `model ${a.provider}/${a.id} not found`);
    if (!(await b.pi.setModel(m))) throw err("no_auth", `no credentials for ${a.provider}`);
    return { model: summarizeModel(m) };
  },
  get_thinking_levels: () => ({ current: String(need().pi.getThinkingLevel()), levels: supportedLevels() }),
  set_thinking: (a) => {
    const level = String(a.level);
    if (!supportedLevels().includes(level)) throw err("bad_request", `unsupported thinking level ${level}`);
    need().pi.setThinkingLevel(level as never);
    return {};
  },
  compact: (a) => {
    needIdle();
    const ctx = need().ctx;
    return new Promise((resolve, reject) => {
      ctx.compact({
        ...(a.customInstructions ? { customInstructions: String(a.customInstructions) } : {}),
        onComplete: () => resolve({}),
        onError: (e) => reject(err("internal", e.message)),
      });
    });
  },
  get_tree: () => getTree(),
  navigate_tree: async (a) => {
    needIdle();
    // pi puts the text of a chosen user message back in the editor (interactive-mode navigateTree);
    // the command context does not return it, so read it here and hand it to the phone's composer too.
    const target = need().ctx.sessionManager.getEntry(String(a.entryId)) as { type?: string; message?: { role?: string; content?: unknown }; content?: unknown } | undefined;
    const editorText = target?.type === "message" && target.message?.role === "user" ? textOfContent(target.message.content)
      : target?.type === "custom_message" ? textOfContent(target.content) : undefined;
    const r = await runWithCommandCtx((c) => c.navigateTree(String(a.entryId), { summarize: !!a.summarize, ...(a.customInstructions ? { customInstructions: String(a.customInstructions) } : {}) }));
    return { cancelled: r.cancelled, ...(!r.cancelled && editorText ? { editorText } : {}) };
  },
  get_fork_points: () => ({ points: getForkPoints() }),
  fork: async (a) => {
    needIdle();
    const entryId = String(a.entryId);
    const position = a.position === "at" ? "at" : "before";
    const prefillText = position === "before" ? getForkPoints().find((p) => p.entryId === entryId)?.text : undefined;
    const r = await runWithCommandCtx((c) => c.fork(entryId, { position }));
    return { cancelled: r.cancelled, ...(prefillText !== undefined && !r.cancelled ? { prefillText } : {}) };
  },
  new_session: async () => { needIdle(); const r = await runWithCommandCtx((c) => c.newSession()); return { cancelled: r.cancelled }; },
  switch_session: async (a) => { needIdle(); const r = await runWithCommandCtx((c) => c.switchSession(String(a.sessionFile))); return { cancelled: r.cancelled }; },
  set_name: (a) => { need().pi.setSessionName(String(a.name)); return {}; },
  reload: () => { need(); reloadWhenIdle(); return {}; },
  reload_when_idle: () => { reloadWhenIdle(); return {}; },
  shutdown: () => { need().ctx.shutdown(); return {}; },
};

export async function handleRequest(op: string, args: Args): Promise<unknown> {
  const h = HANDLERS[op];
  if (!h) throw err("unsupported", `op ${op} not supported by this bridge`);
  return h(args);
}

export { emitSafe };
