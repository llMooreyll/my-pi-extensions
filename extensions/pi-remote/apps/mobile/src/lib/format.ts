import type { ProcessInfo } from "@pi-remote/protocol";

export const baseName = (p: string) => p.split("/").filter(Boolean).pop() || p;

export function processTitle(i: ProcessInfo): string {
  return i.sessionName || baseName(i.cwd);
}

export function relTime(iso: string | number): string {
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function statusLabel(i: ProcessInfo): string {
  if (i.status === "waiting_ui") return `Needs input${i.pendingUiCount > 1 ? ` (${i.pendingUiCount})` : ""}`;
  return i.status === "running" ? "Running" : "Idle";
}

export function roleBadge(i: ProcessInfo): string | undefined {
  const r = i.role;
  if (r.kind === "subagent") return `Subagent · ${r.name}${r.agent ? ` (${r.agent})` : ""}`;
  if (r.kind === "team_member") return `Member · ${r.name}${r.write ? ` · writes ${r.branch ?? ""}` : ""}`;
  return undefined;
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c && c.type === "text").map((c) => String(c.text ?? "")).join("");
}

export function shortJson(v: unknown, n = 300): string {
  let s: string;
  try { s = JSON.stringify(v); } catch { s = String(v); }
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

/** One-line preview of a model answer: markdown markers and whitespace collapsed. */
export function plainPreview(s: string): string {
  return stripAnsi(s).replace(/```[\s\S]*?```/g, " ").replace(/^[#>*\-\s]+/gm, "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
}
