import { WIDGET_RENDER_COLUMNS } from "../../protocol/src/index.ts";
import { logError } from "./log.ts";

const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export const stripAnsi = (s: string) => s.replace(ANSI, "");

/** A fake TUI for component factories: every method is a no-op, size is fixed. */
function stubTui(): unknown {
  const target: Record<string, unknown> = { terminal: { columns: WIDGET_RENDER_COLUMNS, rows: 30 }, requestRender() {} };
  return new Proxy(target, { get: (t, k) => (k in t ? t[k as string] : () => undefined) });
}

export function renderFactoryText(factory: Function, theme: unknown): string[] | undefined {
  let comp: any;
  try {
    comp = factory(stubTui(), theme);
    if (!comp || typeof comp.render !== "function" || typeof comp.then === "function") return undefined;
    const lines: unknown[] = comp.render(WIDGET_RENDER_COLUMNS);
    return lines.map((l) => String(l).replace(ANSI, "").replace(/\s+$/, ""));
  } catch (e) {
    logError("widget render", e);
    return undefined;
  } finally {
    try { comp?.dispose?.(); } catch { /* ignore */ }
  }
}
