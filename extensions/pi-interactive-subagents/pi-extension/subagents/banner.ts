/**
 * Bordered banner primitives shared by the subagent and team widgets.
 *
 * Every function returns lines that fit exactly (or at most, for degenerate
 * widths) into `width` columns. `paint` colours the border glyphs only; the
 * callers pass `(text) => theme.fg("accent", text)` so banners follow the
 * global theme.
 */
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export type Paint = (text: string) => string;

export const identityPaint: Paint = (text) => text;

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 * `left` and `right` may contain ANSI colour codes.
 */
export function borderLine(left: string, right: string, width: number, paint: Paint = identityPaint): string {
  if (width <= 0) return "";
  if (width === 1) return paint("│");

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);
  const bar = paint("│");

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${bar}${truncRight}${" ".repeat(rightPad)}${bar}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${bar}${truncLeft}${" ".repeat(pad)}${right}${bar}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * `title` and `info` must be plain text (no ANSI, no double-width glyphs).
 */
export function borderTop(title: string, info: string, width: number, paint: Paint = identityPaint): string {
  if (width <= 0) return "";
  if (width === 1) return paint("╭");

  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return paint(`╭${content}╮`);
}

/** Build the bordered bottom line: ╰──────────────────╯ */
export function borderBottom(width: number, paint: Paint = identityPaint): string {
  if (width <= 0) return "";
  if (width === 1) return paint("╰");

  const inner = Math.max(0, width - 2);
  return paint(`╰${"─".repeat(inner)}╯`);
}
