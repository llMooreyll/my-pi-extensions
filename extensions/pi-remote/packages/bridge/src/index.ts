import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ExtensionRunner, VERSION } from "@earendil-works/pi-coding-agent";
import { SUPPORTED_PI_VERSIONS } from "../../protocol/src/index.ts";
import { rebuildChildren, registerEventForwarders } from "./events.ts";
import { emit, ensureConnected } from "./host-conn.ts";
import { logError, logInfo } from "./log.ts";
import { registerRemoteOpCommand } from "./remote-op-cmd.ts";
import { registerRpiv } from "./rpiv.ts";
import { registerSendTool } from "./send-tool.ts";
import { buildInfo } from "./snapshot.ts";
import { g } from "./state.ts";
import { clearSessionUiState, patchUi } from "./ui-mirror.ts";

const RUNNER_HOOKED = Symbol.for("pi-remote.runnerHooked");
const toolRegistered = new WeakSet<object>();

/**
 * Patch ctx.ui as soon as the runner receives its UI context, i.e. before any extension's session_start runs.
 * Otherwise widgets/status set by extensions loaded before the bridge would be missed. Same pi-internal
 * dependency as D11, so only for supported pi versions.
 */
function hookRunnerUiContext(): void {
  if (process.env.PI_REMOTE_DISABLE === "1" || !SUPPORTED_PI_VERSIONS.includes(VERSION)) return;
  const proto = (ExtensionRunner as unknown as { prototype: Record<string | symbol, unknown> }).prototype;
  if (!proto || proto[RUNNER_HOOKED] || typeof proto.setUIContext !== "function") return;
  const orig = proto.setUIContext as (this: { uiContext: unknown }, ui: unknown, mode?: string) => void;
  proto.setUIContext = function (this: { uiContext: unknown }, ui: unknown, mode?: string) {
    orig.call(this, ui, mode);
    try { if (mode === "tui" && ui) patchUi(this.uiContext as never); } catch (e) { logError("hook setUIContext", e); }
  };
  proto[RUNNER_HOOKED] = true;
}

export default function piRemoteBridge(pi: ExtensionAPI): void {
  try { hookRunnerUiContext(); } catch (e) { logError("hookRunnerUiContext", e); }
  // Only register here; the socket starts on session_start (docs/extensions.md "Long-lived resources and shutdown").
  registerRemoteOpCommand(pi);
  registerEventForwarders(pi);
  registerRpiv(pi);

  pi.on("session_start", async (event, ctx) => {
    try {
      if (process.env.PI_REMOTE_DISABLE === "1" || ctx.mode !== "tui") return;
      const s = g();
      const first = !s.enabled;
      s.enabled = true;
      s.compat = SUPPORTED_PI_VERSIONS.includes(VERSION) ? "ok" : "untested";
      s.binding = { pi, ctx, sessionId: ctx.sessionManager.getSessionId() };
      s.inflight = undefined;
      s.runningTools.clear();
      s.lastStatus = undefined;
      if (s.compat === "ok") patchUi(ctx.ui);
      // Once per extension instance: /reload and session replacement load the extension again with a new `pi`.
      if (!toolRegistered.has(pi)) { toolRegistered.add(pi); registerSendTool(pi); }
      rebuildChildren();
      ensureConnected();
      if (first) logInfo(`bridge enabled, pi ${VERSION}, compat ${s.compat}`);
      emit({ type: "session_changed", reason: event.reason, info: buildInfo() });
    } catch (e) { logError("session_start", e); }
  });

  pi.on("session_shutdown", async (event) => {
    try {
      const s = g();
      if (!s.enabled) return;
      s.binding = undefined;
      clearSessionUiState();
      if (event.reason === "quit") s.conn?.close();
    } catch (e) { logError("session_shutdown", e); }
  });
}
