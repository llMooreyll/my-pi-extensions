/**
 * Transcript rendering for the team: message renderers for team messages and
 * notices, plus compact renderCall/renderResult pairs for the team tools.
 * Colours come from the active Pi theme only.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { TEAM_MESSAGE_TYPE, TEAM_NOTICE_TYPE } from "./constants.ts";
import type { UiTheme } from "./ui.ts";
import type { ReportStatus, TeamItem } from "./types.ts";

// ── tool results ──

/** Tool result; `ok` only steers the colour of the transcript row. */
function toolResult(text: string, ok: boolean) {
  return { content: [{ type: "text" as const, text }], details: { ok } };
}

export function okResult(text: string) {
  return toolResult(text, true);
}

export function failResult(text: string) {
  return toolResult(text, false);
}

// ── message renderers ──

const COLLAPSED_BODY_LINES = 6;

const REPORT_STYLE: Record<ReportStatus, { icon: string; color: string; word: string }> = {
  done: { icon: "✓", color: "success", word: "reports done" },
  progress: { icon: "…", color: "accent", word: "reports progress" },
  blocked: { icon: "!", color: "warning", word: "is blocked" },
  failed: { icon: "✗", color: "error", word: "failed" },
};

function itemHeader(item: TeamItem, theme: UiTheme): string {
  const name = theme.bold(item.from);
  switch (item.kind) {
    case "report": {
      const style = REPORT_STYLE[item.status ?? "done"] ?? REPORT_STYLE.done;
      return `${theme.fg(style.color, style.icon)} ${name} ${theme.fg(style.color, style.word)}`;
    }
    case "question":
      return `${theme.fg("warning", "?")} ${name} ${theme.fg("warning", "asks")}`;
    case "task":
      return `${theme.fg("accent", "◆")} ${name} ${theme.fg("accent", "assigns a task")}`;
    default:
      return `${theme.fg("accent", "→")} ${name} ${theme.fg("muted", "writes")}`;
  }
}

function itemText(item: TeamItem, theme: UiTheme, expanded: boolean): string {
  // A cc is context for the lead, not an event: one dim line.
  if (item.kind === "cc") return theme.fg("dim", `↳ ${item.body.replace(/\s+/g, " ")}`);

  const lines = [itemHeader(item, theme)];
  const body = item.body.split("\n");
  const shown = expanded ? body : body.slice(0, COLLAPSED_BODY_LINES);
  lines.push(...shown);
  if (!expanded && body.length > shown.length) {
    lines.push(theme.fg("muted", `… ${body.length - shown.length} more lines`));
  }
  if (item.spillPath && expanded) lines.push(theme.fg("dim", `full text: ${item.spillPath}`));
  return lines.join("\n");
}

function boxed(theme: UiTheme, pad: number, text: string) {
  const box = new Box(Math.max(1, pad), 1, (t: string) => theme.bg("customMessageBg", t));
  box.addChild(new Text(text, 0, 0));
  return {
    invalidate() {
      box.invalidate();
    },
    render(width: number): string[] {
      return ["", ...box.render(width)];
    },
  };
}

export function registerTeamRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(TEAM_MESSAGE_TYPE, (message: any, options: any, theme: any) => {
    const items: TeamItem[] | undefined = message.details?.items;
    if (!Array.isArray(items) || items.length === 0) return undefined;
    const expanded = !!options?.expanded;
    const blocks = items.map((item) => itemText(item, theme, expanded));
    const hasLong = items.some((i) => i.kind !== "cc" && i.body.split("\n").length > COLLAPSED_BODY_LINES);
    if (!expanded && hasLong && typeof options?.keyHint === "function") {
      blocks.push(theme.fg("muted", options.keyHint("app.tools.expand", "to expand")));
    }
    return boxed(theme, options?.outputPad ?? 1, blocks.join("\n\n"));
  });

  pi.registerMessageRenderer(TEAM_NOTICE_TYPE, (message: any, options: any, theme: any) => {
    const text = typeof message.content === "string" ? message.content.replace(/^\[team\]\s*/, "") : "";
    if (!text) return undefined;
    const warn = message.details?.level === "warn";
    const icon = warn ? theme.fg("warning", "▲") : theme.fg("dim", "◇");
    const body = warn ? theme.fg("warning", text) : theme.fg("muted", text);
    return boxed(theme, options?.outputPad ?? 1, `${icon} ${theme.bold("team")}  ${body}`);
  });
}

// ── tool renderers ──

interface ToolRenderSpec {
  /** Compact description of the call arguments (already themed). */
  describe(args: any, theme: UiTheme): string;
  /** Optional long text of which only the first line is previewed. */
  preview?(args: any): string | undefined;
}

function firstLinePreview(text: string | undefined, theme: UiTheme): string {
  if (!text) return "";
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  const clipped = first.length > 100 ? `${first.slice(0, 100)}…` : first;
  const total = text.split("\n").length;
  return `\n${theme.fg("toolOutput", clipped)}${total > 1 ? theme.fg("muted", ` (${total} lines)`) : ""}`;
}

/** renderCall/renderResult for one team tool. Spread the result into the tool definition. */
export function teamToolRenderers(toolName: string, spec: ToolRenderSpec) {
  return {
    renderCall(args: any, theme: any) {
      const head = `${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(toolName))}`;
      const detail = spec.describe(args ?? {}, theme);
      return new Text(
        `${head}${detail ? ` ${detail}` : ""}${firstLinePreview(spec.preview?.(args ?? {}), theme)}`,
        0,
        0,
      );
    },
    renderResult(result: any, options: any, theme: any) {
      if (options?.isPartial) return new Text(theme.fg("dim", "…"), 0, 0);
      const text = typeof result.content?.[0]?.text === "string" ? result.content[0].text : "";
      const ok = result.details?.ok !== false;
      const lines: string[] = text.split("\n");
      const limit = options?.expanded ? lines.length : 4;
      const shown = lines.slice(0, limit).map((line: string, i: number) => {
        const styled = ok ? theme.fg("toolOutput", line) : theme.fg("error", line);
        return i === 0 ? `${ok ? theme.fg("success", "✓") : theme.fg("error", "✗")} ${styled}` : `  ${styled}`;
      });
      if (lines.length > limit) shown.push(theme.fg("muted", `  … ${lines.length - limit} more lines`));
      return new Text(shown.join("\n"), 0, 0);
    },
  };
}

// Descriptions shared by lead and member tools.

export const describeName = (args: any, theme: UiTheme): string =>
  typeof args.name === "string" && args.name ? theme.bold(args.name) : "";

export const describeSend = (args: any, theme: UiTheme): string => {
  const to = typeof args.to === "string" && args.to ? theme.bold(args.to) : "";
  return `${theme.fg("muted", "→")} ${to}${args.urgent ? ` ${theme.fg("warning", "urgent")}` : ""}`;
};

export const describeSpawn = (args: any, theme: UiTheme): string => {
  const parts = [typeof args.name === "string" && args.name ? theme.bold(args.name) : theme.fg("dim", "(unnamed)")];
  if (typeof args.agent === "string" && args.agent) parts.push(theme.fg("muted", `(${args.agent})`));
  parts.push(args.write ? theme.fg("warning", "worktree") : theme.fg("dim", "read-only"));
  if (Array.isArray(args.link) && args.link.length > 0) parts.push(theme.fg("dim", `link ${args.link.join(",")}`));
  return parts.join(" ");
};
