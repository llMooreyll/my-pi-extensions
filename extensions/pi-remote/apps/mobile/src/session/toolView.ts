// How each tool call reads on the phone: a family (colour and word in the header), what it acts on, and one line
// of outcome. Covers pi's built-in tools and the tools the extensions in use register (see NOTES 71).
import { formatBytes } from "@pi-remote/protocol";

export type ToolFamily = "file" | "shell" | "search" | "web" | "agent" | "team" | "user" | "media" | "code" | "other";

export interface ToolView {
  family: ToolFamily;
  /** Small-caps word in the header: READ, BASH, SEARCH… */
  verb: string;
  /** What the call acts on, set in mono: a path, a command, a query. */
  target: string;
  /** A longer text worth reading before opening (a task, a message, a question). */
  body?: string;
  /** Outcome or parameters, one line: "+12 −3", "exit 1", "15 results". */
  meta?: string;
  /** Why pi made the call, when the tool takes such a note (pi-board's message on write/edit). */
  why?: string;
  /** Lines added and removed, for edits. */
  diff?: { add: number; del: number };
}

type A = Record<string, unknown>;
type R = { isError?: boolean; details?: A; content?: unknown; nestedCalls?: { calls?: unknown[] } } | undefined;

const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;

export function textOfResult(r: R): string {
  const c = r?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((b) => (b as A)?.type === "text").map((b) => s((b as A).text)).join("");
}

function lineCount(t: string): number { const x = t.replace(/\n$/, ""); return x ? x.split("\n").length : 0; }

/** "/home/me/p/src/a.ts" -> "src/a.ts" inside the session folder, "~/x" inside home. */
export function shortPath(path: string, cwd?: string): string {
  if (!path) return path;
  if (cwd && path.startsWith(cwd + "/")) return path.slice(cwd.length + 1);
  if (cwd && path === cwd) return ".";
  const home = /^\/home\/[^/]+/.exec(cwd ?? "")?.[0];
  if (home && path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}

/** Counts of added and removed lines in a unified diff. */
export function diffStat(patch: string): { add: number; del: number } {
  let add = 0; let del = 0;
  for (const l of patch.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) add++;
    else if (l.startsWith("-") && !l.startsWith("---")) del++;
  }
  return { add, del };
}

function host(url: string): string {
  const m = /^[a-z]+:\/\/([^/?#]+)([^?#]*)/i.exec(url);
  return m ? `${m[1]}${m[2] && m[2] !== "/" ? m[2] : ""}` : url;
}

function truncNote(d: A | undefined): string {
  const t = d?.truncation as A | undefined;
  return t?.truncated ? ` · cut to ${n(t.outputLines) ?? "?"} of ${n(t.totalLines) ?? "?"} lines` : "";
}

function argsLine(args: A): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === "") continue;
    const val = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}: ${val && val.length > 80 ? val.slice(0, 80) + "…" : val}`);
    if (parts.length >= 4) break;
  }
  return parts.join("  ·  ");
}

export function describeTool(rawName: string | undefined, rawArgs: unknown, result: R, cwd?: string): ToolView {
  // A streaming call has no name until its arguments start; the name may also be missing from old bridges.
  const name = typeof rawName === "string" && rawName ? rawName : "tool";
  const a = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as A;
  const d = result?.details;
  const out = result ? textOfResult(result) : "";
  const err = !!result?.isError;
  const firstLine = out.split("\n").find((l) => l.trim()) ?? "";
  const path = shortPath(s(a.path), cwd);
  const why = typeof a.message === "string" && a.message ? a.message : undefined;
  switch (name) {
    // ---- pi built-ins (write/edit may carry pi-board's `message`) ----
    case "read": {
      // Models often pass offset 1 or null limits; only a real window is worth a mention.
      const off = n(a.offset); const lim = n(a.limit);
      const range = (off !== undefined && off > 1) || lim !== undefined ? `from line ${off ?? 1}${lim !== undefined ? `, ${lim} lines` : ""}` : "";
      const got = result && !err ? `${plural(lineCount(out), "line")}${truncNote(d)}` : "";
      return { family: "file", verb: "read", target: path || "?", meta: [range, got].filter(Boolean).join(" · ") || undefined };
    }
    case "write": {
      const lines = lineCount(s(a.content));
      return { family: "file", verb: "write", target: path || "?", meta: `${plural(lines, "line")} · ${formatBytes(new TextEncoder().encode(s(a.content)).length)}`, why };
    }
    case "edit": {
      const patch = typeof d?.patch === "string" ? d.patch : "";
      const k = Array.isArray(a.edits) ? a.edits.length : 1;
      const st = patch ? diffStat(patch) : undefined;
      return { family: "file", verb: "edit", target: path || "?", meta: plural(k, "change"), why, ...(st ? { diff: st } : {}) };
    }
    case "bash": {
      const exit = /exited with code (\d+)/.exec(out)?.[1];
      const meta = err ? (exit ? `exit ${exit}` : firstLine.slice(0, 100)) : result ? `${plural(lineCount(out), "line")} of output${truncNote(d)}` : a.timeout ? `timeout ${s(a.timeout)}s` : undefined;
      return { family: "shell", verb: "bash", target: s(a.command), meta };
    }
    case "grep": {
      const where = [a.path ? shortPath(s(a.path), cwd) : "", a.glob ? s(a.glob) : ""].filter(Boolean).join(" ");
      const hits = result && !err ? (out.trim() && !/^No matches/i.test(out) ? plural(lineCount(out), "line") : "no match") : "";
      return { family: "search", verb: "grep", target: `/${s(a.pattern)}/${a.ignoreCase ? "i" : ""}${where ? `  in ${where}` : ""}`, meta: [hits, d?.matchLimitReached ? "limit reached" : ""].filter(Boolean).join(" · ") || undefined };
    }
    case "find":
      return { family: "search", verb: "find", target: `${s(a.pattern)}${a.path ? `  in ${shortPath(s(a.path), cwd)}` : ""}`, meta: result && !err ? (out.trim() && !/^No files/i.test(out) ? plural(lineCount(out), "file") : "nothing found") : undefined };
    case "ls":
      return { family: "search", verb: "ls", target: shortPath(s(a.path || "."), cwd), meta: result && !err ? plural(lineCount(out), "entry") : undefined };

    // ---- pi-web-access ----
    case "web_search": {
      const qs = Array.isArray(a.queries) ? (a.queries as unknown[]).map(s) : a.query ? [s(a.query)] : [];
      const total = n(d?.totalResults);
      const meta = [total !== undefined ? plural(total, "result") : "", qs.length > 1 ? plural(qs.length, "query") : "", s(a.provider), a.recencyFilter ? `past ${s(a.recencyFilter)}` : ""].filter(Boolean).join(" · ");
      return { family: "web", verb: "search", target: qs.join("  ·  ") || "?", meta: meta || undefined };
    }
    case "source_check":
      return { family: "web", verb: "check", target: s(a.claim), meta: d?.sourceCount !== undefined ? `${plural(n(d.sourceCount) ?? 0, "source")} · ${plural(n(d.passageCount) ?? 0, "passage")}` : undefined };
    case "fetch_content": {
      const urls = Array.isArray(a.urls) ? (a.urls as unknown[]).map(s) : a.url ? [s(a.url)] : [];
      const ok = n(d?.successful); const cnt = n(d?.urlCount);
      return { family: "web", verb: "fetch", target: urls.map(host).join("  ·  ") || "?", body: a.prompt ? s(a.prompt) : undefined,
        meta: [cnt !== undefined ? `${ok ?? 0} of ${cnt} fetched` : "", a.mode && a.mode !== "readable" ? s(a.mode) : "", n(d?.totalChars) ? `${Math.round(n(d!.totalChars)! / 1000)}k chars` : ""].filter(Boolean).join(" · ") || undefined };
    }
    case "get_search_content": {
      const what = s(a.findText ?? a.query ?? a.url ?? "") || (a.queryIndex !== undefined ? `query #${s(a.queryIndex)}` : a.urlIndex !== undefined ? `url #${s(a.urlIndex)}` : "");
      return { family: "web", verb: "stored", target: what || s(a.responseId).slice(0, 12), meta: n(d?.returnedChars) !== undefined ? `${Math.round(n(d!.returnedChars)! / 1000)}k chars${d?.truncated ? " · more left" : ""}` : undefined };
    }
    case "web_enable": return { family: "web", verb: "web", target: "enable the web tools" };

    // ---- talking to the user and the phone ----
    case "ask_user_question": {
      const qs = Array.isArray(a.questions) ? (a.questions as A[]) : [];
      const answered = d && Array.isArray(d.answers) ? (d.cancelled ? "declined" : plural((d.answers as unknown[]).length, "answer")) : undefined;
      return { family: "user", verb: "ask", target: qs.map((q) => s(q.header) || s(q.question)).join("  ·  ") || "question", body: qs.map((q) => s(q.question)).join("\n"), meta: answered };
    }
    case "send_to_phone": {
      const ps = Array.isArray(a.paths) ? (a.paths as unknown[]).map((x) => shortPath(s(x), cwd)) : [s(a.paths)];
      return { family: "user", verb: "to phone", target: ps.join("  ·  "), body: a.note ? s(a.note) : undefined };
    }

    // ---- pi-interactive-subagents ----
    case "subagent":
      return { family: "agent", verb: "subagent", target: `${s(a.name)}${a.agent ? `  (${s(a.agent)})` : ""}`, body: s(a.task),
        meta: [a.fork ? "forked context" : "", a.interactive ? "interactive" : "", a.model ? s(a.model).split(",")[0] : "", d?.error ? s(d.error) : ""].filter(Boolean).join(" · ") || undefined };
    case "subagent_resume": return { family: "agent", verb: "resume", target: s(a.name) || shortPath(s(a.sessionPath), cwd), body: a.message ? s(a.message) : undefined };
    case "subagent_interrupt": return { family: "agent", verb: "interrupt", target: s(a.name ?? a.id) };
    case "subagents_list": return { family: "agent", verb: "agents", target: "list subagent definitions", meta: Array.isArray(d?.agents) ? plural((d!.agents as unknown[]).length, "agent") : undefined };
    case "caller_ping": return { family: "agent", verb: "ping", target: "ask the parent agent for help", body: s(a.message) };
    case "subagent_done": return { family: "agent", verb: "done", target: "subagent finished" };
    case "team_spawn": return { family: "team", verb: "add member", target: `${s(a.name)}  (${s(a.agent)})`, body: s(a.task), meta: [a.write ? "writes in its own worktree" : "read-only", a.model ? s(a.model).split(",")[0] : ""].filter(Boolean).join(" · ") };
    case "team_send": return { family: "team", verb: "message", target: `→ ${s(a.to)}${a.urgent ? "  (urgent)" : ""}`, body: s(a.message) };
    case "team_list": return { family: "team", verb: "team", target: "list members" };
    case "team_interrupt": return { family: "team", verb: "interrupt", target: s(a.name) };
    case "team_stop": return { family: "team", verb: "stop", target: s(a.name) };
    case "team_integrate": return { family: "team", verb: "integrate", target: `changes of ${s(a.name)}` };
    case "team_sync": return { family: "team", verb: "sync", target: s(a.name) };
    case "team_report": return { family: "team", verb: "report", target: s(a.status), body: s(a.summary) };
    case "team_ask": return { family: "team", verb: "ask lead", target: "question for the lead", body: s(a.question) };

    // ---- media and viewing ----
    case "read_video": return { family: "media", verb: "video", target: path || "?", meta: "given to the model as video" };
    case "transcribe_file": {
      const secs = n(d?.seconds);
      return { family: "media", verb: "transcribe", target: path || "?", meta: [secs !== undefined ? `${Math.round(secs)}s of audio` : "", s(d?.modelId), d?.warning ? s(d.warning) : ""].filter(Boolean).join(" · ") || undefined };
    }
    case "video_state": {
      const m = d?.meta as A | undefined;
      return { family: "media", verb: "lesson", target: m ? `${s(m.course)} · ${s(m.episodeTitle || m.episode)}` : "where the lesson video is", meta: n(d?.time) !== undefined ? `at ${Math.floor(n(d!.time)! / 60)}:${String(Math.floor(n(d!.time)! % 60)).padStart(2, "0")}` : undefined };
    }
    case "video_seek": return { family: "media", verb: "seek", target: `lesson video to ${s(a.time)}`, meta: a.play === true ? "and play" : a.play === false ? "and pause" : undefined };
    case "video_frame": return { family: "media", verb: "frame", target: "capture the lesson video" };
    case "view_open": return { family: "media", verb: "show", target: path || "?", meta: a.line ? `line ${s(a.line)}` : a.page ? `page ${s(a.page)}` : undefined };

    // ---- codemode scripts ----
    case "codemode": {
      const code = s(a.code ?? a.script);
      const lines = code.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//"));
      const calls = result?.nestedCalls?.calls?.length;
      return { family: "code", verb: "script", target: lines[0]?.trim() ?? "script", meta: [plural(lineCount(code), "line"), calls ? `${plural(calls, "tool call")}` : ""].filter(Boolean).join(" · ") };
    }
    default:
      return { family: "other", verb: name.replace(/^mcp__[^_]+__/, "").replace(/_/g, " "), target: argsLine(a) || "—" };
  }
}

/** "40ms", "12s", "2m 05s" */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${String(sec % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
