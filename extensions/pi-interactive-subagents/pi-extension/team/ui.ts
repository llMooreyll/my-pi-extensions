/**
 * Banners for the team: one above the lead's editor listing all members, and a
 * small identity banner above each member's editor. Colours come from the
 * active Pi theme only (accent, success, warning, error, muted, dim), so the
 * banners follow whatever theme the user selected.
 */
import { truncateToWidth } from "@mariozechner/pi-tui";
import { borderBottom, borderLine, borderTop, type Paint } from "../subagents/banner.ts";
import type { MemberState } from "./types.ts";

/** The part of Pi's Theme the banners use. */
export interface UiTheme {
  fg(color: any, text: string): string;
  bg(color: any, text: string): string;
  bold(text: string): string;
}

export type RowState = MemberState | "starting" | "lost";

const STATE_STYLE: Record<RowState, { label: string; color: string }> = {
  starting: { label: "starting…", color: "dim" },
  idle: { label: "idle", color: "success" },
  working: { label: "working", color: "accent" },
  awaiting_lead: { label: "asks lead", color: "warning" },
  failed: { label: "failed", color: "error" },
  stopped: { label: "stopped", color: "dim" },
  left: { label: "left", color: "dim" },
  lost: { label: "lost", color: "error" },
};

export function stateStyle(state: RowState): { label: string; color: string } {
  return STATE_STYLE[state] ?? STATE_STYLE.starting;
}

export interface TeamRow {
  name: string;
  agent: string;
  write: boolean;
  state: RowState;
  spawnedAt: number;
  model?: string;
  /** Messages waiting in the member's inbox. */
  pending: number;
  /** Commits on a write member's branch that are not integrated yet. */
  ahead: number;
  error?: string;
}

export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "provider/model-id" -> "model-id". */
export function shortModel(model: string | undefined): string {
  if (!model) return "";
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

function accentPaint(theme: UiTheme): Paint {
  return (text) => theme.fg("accent", text);
}

function summarize(rows: TeamRow[]): string {
  const count = (state: RowState) => rows.filter((r) => r.state === state).length;
  const parts = [`${rows.length} member${rows.length === 1 ? "" : "s"}`];
  const working = count("working");
  const asking = count("awaiting_lead");
  const problems = count("failed") + count("lost");
  if (working > 0) parts.push(`${working} working`);
  if (asking > 0) parts.push(`${asking} waiting for you`);
  if (problems > 0) parts.push(`${problems} need attention`);
  return parts.join(" · ");
}

/** Lines for the banner above the lead's editor. Every line is at most `width` columns. */
export function renderTeamBanner(rows: TeamRow[], width: number, theme: UiTheme, now = Date.now()): string[] {
  const paint = accentPaint(theme);
  const lines = [borderTop("Team", summarize(rows), width, paint)];
  const showModel = width >= 90;

  for (const row of rows) {
    const style = stateStyle(row.state);
    const dot = theme.fg(style.color, "●");

    let left = ` ${dot} ${theme.bold(row.name)}  ${theme.fg("muted", row.agent)}`;
    left += `  ${row.write ? theme.fg("warning", "worktree") : theme.fg("dim", "read-only")}`;
    if (row.write && row.ahead > 0) left += `  ${theme.fg("warning", `+${row.ahead} to integrate`)}`;
    if (showModel && row.model) left += `  ${theme.fg("dim", shortModel(row.model))}`;
    left += " ";

    let right = ` ${theme.fg(style.color, style.label)}`;
    if (row.pending > 0) right += `  ${theme.fg("warning", `inbox ${row.pending}`)}`;
    right += `  ${theme.fg("dim", formatClock(now - row.spawnedAt))} `;

    lines.push(borderLine(left, right, width, paint));

    if (row.error && (row.state === "failed" || row.state === "lost")) {
      const detail = truncateToWidth(row.error.replace(/\s+/g, " "), Math.max(0, width - 8));
      lines.push(borderLine(`   ${theme.fg("error", "└")} ${theme.fg("error", detail)}`, "", width, paint));
    }
  }

  lines.push(borderBottom(width, paint));
  return lines;
}

export interface MemberBannerInfo {
  name: string;
  agent: string;
  write: boolean;
  branch?: string;
  state: RowState;
  model?: string;
  pending: number;
  leadAlive: boolean;
  error?: string;
}

/** Lines for the identity banner above a member's own editor. */
export function renderMemberBanner(info: MemberBannerInfo, width: number, theme: UiTheme): string[] {
  const paint = accentPaint(theme);
  const style = stateStyle(info.state);
  const mode = info.write ? "worktree" : "read-only";
  const lines = [borderTop(`Team member · ${info.name}`, `${info.agent} · ${mode}`, width, paint)];

  const left =
    ` ${theme.fg(style.color, "●")} ${theme.fg(style.color, style.label)}` +
    `  ${theme.fg("dim", "lead")} ${info.leadAlive ? theme.fg("success", "online") : theme.fg("error", "offline")} `;
  let right = "";
  if (info.pending > 0) right += ` ${theme.fg("warning", `inbox ${info.pending}`)} `;
  if (info.model) right += ` ${theme.fg("dim", shortModel(info.model))} `;
  lines.push(borderLine(left, right, width, paint));

  if (info.write && info.branch) {
    lines.push(borderLine(` ${theme.fg("muted", "branch")} ${info.branch} `, "", width, paint));
  }
  if (info.error && info.state === "failed") {
    const detail = truncateToWidth(info.error.replace(/\s+/g, " "), Math.max(0, width - 8));
    lines.push(borderLine(` ${theme.fg("error", detail)} `, "", width, paint));
  }

  lines.push(borderBottom(width, paint));
  return lines;
}
