import type { OpName } from "../../protocol/src/index.ts";
import { err } from "./errors.ts";
import { anyStr, bool, obj, oneOf, optBool, optInt, optOneOf, optStr, str } from "./validate.ts";

type Args = Record<string, unknown>;

const pid = (a: Args) => { str(a, "processId"); };

/** Argument validators for every op in OpMap. Throw bad_request on invalid input. */
export const VALIDATORS: Record<OpName, (a: Args) => void> = {
  list_processes: () => {},
  list_sessions: (a) => { optStr(a, "cwd"); optBool(a, "refresh"); },
  list_projects: () => {},
  open_session: (a) => { str(a, "sessionFile"); oneOf(a, "trust", ["approve", "deny"]); },
  new_process: (a) => { str(a, "cwd"); oneOf(a, "trust", ["approve", "deny"]); },
  subscribe: (a) => { pid(a); optInt(a, "sinceSeq", 0, Number.MAX_SAFE_INTEGER); },
  unsubscribe: pid,
  get_settings: () => {},
  set_setting: (a) => { str(a, "key"); if (!("value" in a)) throw err("bad_request", "value is required"); },
  list_dirs: (a) => { anyStr(a, "path"); },
  read_session: (a) => { str(a, "sessionFile"); optStr(a, "beforeEntryId"); optInt(a, "limit", 1, 1000); },
  prompt: (a) => {
    pid(a); anyStr(a, "text"); optOneOf(a, "deliverAs", ["steer", "followUp"]);
    const imgs = a.images;
    if (imgs !== undefined) {
      if (!Array.isArray(imgs) || imgs.length > 8) throw err("bad_request", "images must be an array of at most 8 items");
      for (const i of imgs) {
        const o = i as Args;
        if (!o || typeof o.data !== "string" || typeof o.mimeType !== "string" || !o.mimeType.startsWith("image/")) throw err("bad_request", "invalid image");
      }
    }
    if (!(a.text as string).trim() && !(Array.isArray(imgs) && imgs.length)) throw err("bad_request", "text is empty");
  },
  abort: pid,
  ui_respond: (a) => {
    pid(a); str(a, "uiId");
    const r = obj(a, "response");
    const ok = typeof r.value === "string" || typeof r.confirmed === "boolean" || r.cancelled === true;
    if (!ok) throw err("bad_request", "response must be {value}, {confirmed} or {cancelled:true}");
  },
  rpiv_answer: (a) => { pid(a); const ans = obj(a, "answer"); if (typeof ans.toolCallId !== "string") throw err("bad_request", "answer.toolCallId required"); },
  get_history: (a) => { pid(a); str(a, "beforeEntryId"); optInt(a, "limit", 1, 1000); },
  get_commands: pid,
  get_models: pid,
  set_model: (a) => { pid(a); str(a, "provider"); str(a, "id"); },
  get_thinking_levels: pid,
  set_thinking: (a) => { pid(a); str(a, "level"); },
  compact: (a) => { pid(a); optStr(a, "customInstructions"); },
  get_tree: pid,
  navigate_tree: (a) => { pid(a); str(a, "entryId"); bool(a, "summarize"); optStr(a, "customInstructions"); },
  get_fork_points: pid,
  fork: (a) => { pid(a); str(a, "entryId"); oneOf(a, "position", ["before", "at"]); },
  new_session: pid,
  switch_session: (a) => { pid(a); str(a, "sessionFile"); },
  set_name: (a) => { pid(a); anyStr(a, "name"); },
  reload: pid,
  shutdown: pid,
};

export const SIDE_EFFECT_OPS: ReadonlySet<string> = new Set([
  "prompt", "abort", "ui_respond", "rpiv_answer", "set_model", "set_thinking", "compact", "navigate_tree", "fork",
  "new_session", "switch_session", "set_name", "reload", "shutdown", "open_session", "new_process", "set_setting",
]);

export function isOpName(op: string): op is OpName {
  return Object.prototype.hasOwnProperty.call(VALIDATORS, op);
}

export function auditSummary(op: string, a: Args): string | undefined {
  switch (op) {
    case "prompt": return String(a.text ?? "").slice(0, 200) + (Array.isArray(a.images) && a.images.length ? ` [+${a.images.length} images]` : "");
    case "set_model": return `${a.provider}/${a.id}`;
    case "set_thinking": return String(a.level);
    case "set_setting": return `${a.key}=${JSON.stringify(a.value)}`;
    case "open_session": case "switch_session": return String(a.sessionFile);
    case "new_process": return String(a.cwd);
    case "ui_respond": return JSON.stringify(a.response).slice(0, 200);
    case "set_name": return String(a.name).slice(0, 200);
    case "navigate_tree": case "fork": return String(a.entryId);
    default: return undefined;
  }
}
