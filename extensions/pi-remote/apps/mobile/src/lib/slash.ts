export type SheetName = "model" | "thinking" | "outline" | "tree" | "fork" | "resume" | "compact" | "session";

export type SlashAction =
  | { kind: "sheet"; sheet: SheetName }
  | { kind: "clone" }
  | { kind: "new" }
  | { kind: "compact"; instructions: string }
  | { kind: "settings" }
  | { kind: "name"; name?: string }
  | { kind: "reload" }
  | { kind: "copy" }
  | { kind: "desktop_only"; command: string }
  | { kind: "prompt" };

export interface BuiltinCommand { name: string; description: string }

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: "model", description: "Switch model" },
  { name: "thinking", description: "Set thinking level" },
  { name: "tree", description: "Navigate the session tree" },
  { name: "fork", description: "Fork from an earlier message" },
  { name: "clone", description: "Clone the session at the current point" },
  { name: "new", description: "Start a new session" },
  { name: "resume", description: "Switch to another session" },
  { name: "compact", description: "Compact the context" },
  { name: "settings", description: "pi settings" },
  { name: "name", description: "Rename the session" },
  { name: "reload", description: "Reload extensions and resources" },
  { name: "session", description: "Session info" },
  { name: "copy", description: "Copy the last answer" },
];

const DESKTOP_ONLY = new Set(["login", "logout", "hotkeys", "share", "export", "import", "bug", "changelog", "scoped-models", "trust", "quit"]);

/** Routes built-in slash commands to native UI; everything else is sent to pi as a prompt. */
export function routeSlash(input: string): SlashAction {
  const t = input.trim();
  if (!t.startsWith("/")) return { kind: "prompt" };
  const sp = t.indexOf(" ");
  const cmd = (sp < 0 ? t.slice(1) : t.slice(1, sp)).toLowerCase();
  const arg = sp < 0 ? "" : t.slice(sp + 1).trim();
  switch (cmd) {
    case "model": return { kind: "sheet", sheet: "model" };
    case "thinking": return { kind: "sheet", sheet: "thinking" };
    case "tree": return { kind: "sheet", sheet: "tree" };
    case "fork": return { kind: "sheet", sheet: "fork" };
    case "resume": return { kind: "sheet", sheet: "resume" };
    case "session": return { kind: "sheet", sheet: "session" };
    case "clone": return { kind: "clone" };
    case "new": return { kind: "new" };
    case "compact": return arg ? { kind: "compact", instructions: arg } : { kind: "sheet", sheet: "compact" };
    case "settings": return { kind: "settings" };
    case "name": return { kind: "name", ...(arg ? { name: arg } : {}) };
    case "reload": return { kind: "reload" };
    case "copy": return { kind: "copy" };
    default:
      if (DESKTOP_ONLY.has(cmd)) return { kind: "desktop_only", command: cmd };
      return { kind: "prompt" };
  }
}
