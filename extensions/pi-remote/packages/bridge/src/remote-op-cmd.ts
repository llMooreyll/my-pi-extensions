import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { HIDDEN_COMMAND } from "../../protocol/src/index.ts";
import { logError } from "./log.ts";
import { g } from "./state.ts";
import { err } from "./types.ts";

const START_TIMEOUT_MS = 30_000;

/**
 * newSession/fork/navigateTree/switchSession/reload exist only on ExtensionCommandContext.
 * Sending "/<hidden> <id>" through sendUserMessage runs our command handler with that context (plan 7.1.6, A-3).
 */
export function registerRemoteOpCommand(pi: ExtensionAPI): void {
  pi.registerCommand(HIDDEN_COMMAND, {
    description: "internal: used by pi-remote (do not run manually)",
    handler: async (args, ctx) => {
      const id = args.trim();
      const op = g().remoteOps.get(id);
      if (!op) { ctx.ui.notify("pi-remote-op: unknown or expired op", "warning"); return; }
      g().remoteOps.delete(id);
      await op(ctx);
    },
  });
}

export function runWithCommandCtx<T>(fn: (cmdCtx: ExtensionCommandContext) => Promise<T>): Promise<T> {
  const s = g();
  const b = s.binding;
  if (!b) return Promise.reject(err("replacing", "session is being replaced"));
  const id = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (s.remoteOps.delete(id)) reject(err("timeout", "pi did not run the internal command"));
    }, START_TIMEOUT_MS);
    s.remoteOps.set(id, async (c) => {
      clearTimeout(timer);
      try { resolve(await fn(c as ExtensionCommandContext)); } catch (e) { reject(e); }
    });
    try {
      // Returns void; failures surface as pi extension errors, and the timer above cleans up.
      b.pi.sendUserMessage(`/${HIDDEN_COMMAND} ${id}`, { expandPromptTemplates: true });
    } catch (e) { clearTimeout(timer); s.remoteOps.delete(id); reject(e); }
  });
}

export function runReloadNow(): void {
  runWithCommandCtx((c) => c.reload()).catch((e) => logError("reload", e));
}

/** Reload now when idle, otherwise after the current run settles. */
export function reloadWhenIdle(): void {
  const b = g().binding;
  if (b && b.ctx.isIdle()) runReloadNow();
  else g().reloadPending = true;
}
