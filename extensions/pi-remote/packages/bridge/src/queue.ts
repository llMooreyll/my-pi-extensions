// Withdrawing a message the phone queued while pi was working.
//
// pi keeps queued messages inside AgentSession and gives extensions no way to edit that queue. Its TUI has one
// way out: the "restore queued messages" key (app.message.dequeue, alt+up by default) empties the queue into the
// editor. pi runs in a tmux pane, so the bridge presses that key in its own pane, takes the withdrawn message out,
// queues the phone's other messages again and leaves the editor as the person at the computer had it.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { DeliverAs } from "../../protocol/src/index.ts";
import { need } from "./snapshot.ts";
import { g } from "./state.ts";
import { err } from "./types.ts";

const execFileP = promisify(execFile);

/** A message the phone queued, with everything needed to queue it again (images included). */
export interface PhoneQueued { text: string; content: unknown; mode: DeliverAs }

const KEY = "__piRemoteQueue";
/** Kept across /reload like the rest of the bridge state: the queue lives in pi, not in this extension instance. */
function queue(): PhoneQueued[] {
  const any = globalThis as Record<string, unknown>;
  return (any[KEY] ??= []) as PhoneQueued[];
}

export function rememberQueued(q: PhoneQueued): void { queue().push(q); }

/** A user message reached the conversation: the first queued entry with its text is delivered. */
export function deliveredQueued(text: string): void {
  const q = queue();
  const i = q.findIndex((x) => x.text === text);
  if (i >= 0) q.splice(i, 1);
}

/** pi settled: everything queued was delivered or dropped. */
export function clearQueued(): void { queue().length = 0; }

let withdrawable: boolean | undefined;
/** Read once per extension instance: keybindings change only with a restart or /reload. */
export function canWithdraw(): boolean { return (withdrawable ??= !!process.env.TMUX_PANE && !!dequeueKey()); }

/** pi key notation ("alt+up") to tmux send-keys notation ("M-Up"); undefined when not translatable. */
function toTmuxKey(k: string): string | undefined {
  const parts = k.toLowerCase().split("+").map((x) => x.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key) return undefined;
  const mods: Record<string, string> = { ctrl: "C-", alt: "M-", shift: "S-" };
  let prefix = "";
  for (const m of parts) { const t = mods[m]; if (!t) return undefined; prefix += t; }
  const named: Record<string, string> = { up: "Up", down: "Down", left: "Left", right: "Right", enter: "Enter", escape: "Escape", tab: "Tab", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown" };
  const name = named[key] ?? (key.length === 1 ? key : undefined);
  return name ? prefix + name : undefined;
}

function dequeueKey(): string | undefined {
  let configured: unknown;
  try {
    const kb = JSON.parse(readFileSync(join(getAgentDir(), "keybindings.json"), "utf8")) as Record<string, unknown>;
    configured = kb["app.message.dequeue"];
  } catch { /* no custom keybindings */ }
  const list = configured === undefined ? [process.platform === "win32" ? "alt+q" : "alt+up"] : Array.isArray(configured) ? configured : [configured];
  for (const k of list) if (typeof k === "string") { const t = toTmuxKey(k); if (t) return t; }
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Returns the withdrawn text so the phone can put it back into its input. */
export async function withdrawQueued(text: string): Promise<{ text: string }> {
  const b = need();
  const pane = process.env.TMUX_PANE;
  const key = dequeueKey();
  if (!pane || !key) throw err("unsupported", "Withdrawing needs pi to run in tmux with a key bound to \"Restore queued messages\"");
  const q = queue();
  const at = q.findIndex((x) => x.text === text);
  if (at < 0 || !b.ctx.hasPendingMessages()) throw err("not_found", "pi has already read this message");
  // The key goes to whatever has focus in the TUI; with a dialog open it would answer the dialog instead.
  if (g().pendingUi.size || g().rpivOpen.size) throw err("busy", "Answer the open question first, then withdraw");

  const editorBefore = b.ctx.ui.getEditorText();
  await execFileP("tmux", ["send-keys", "-t", pane, key]);
  for (let i = 0; i < 40 && b.ctx.hasPendingMessages(); i++) await sleep(50);
  if (b.ctx.hasPendingMessages()) throw err("timeout", "pi did not release its queue; is a menu open on the computer?");
  const editorAfter = b.ctx.ui.getEditorText();

  // The editor now holds every queued text joined by blank lines, then what was typed before. Take the phone's
  // messages out of it; whatever is left was queued at the computer and stays in the editor, as the key does there.
  let restored = editorBefore.trim() && editorAfter.endsWith(editorBefore) ? editorAfter.slice(0, editorAfter.length - editorBefore.length) : editorAfter;
  const keep: PhoneQueued[] = [];
  let withdrawn: PhoneQueued | undefined;
  for (const item of q) {
    const i = restored.indexOf(item.text);
    if (i < 0) continue; // delivered in the meantime
    restored = restored.slice(0, i) + restored.slice(i + item.text.length);
    if (!withdrawn && item === q[at]) withdrawn = item; else keep.push(item);
  }
  const leftover = restored.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean).join("\n\n");
  b.ctx.ui.setEditorText([leftover, editorBefore].filter((s) => s.trim()).join("\n\n"));

  q.length = 0;
  for (const item of keep) {
    // If the run ended while the queue was out, the first message starts a new run and the rest follow it.
    const idle = b.ctx.isIdle();
    b.pi.sendUserMessage(item.content as Parameters<typeof b.pi.sendUserMessage>[0], { ...(idle ? {} : { deliverAs: item.mode }), expandPromptTemplates: true });
    q.push(item);
    if (idle) for (let i = 0; i < 20 && b.ctx.isIdle(); i++) await sleep(50);
  }
  if (!withdrawn) throw err("not_found", "pi has already read this message");
  return { text: withdrawn.text };
}
