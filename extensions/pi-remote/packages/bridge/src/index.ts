import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { SUPPORTED_PI_VERSIONS } from "../../protocol/src/index.ts";
import { rebuildChildren, registerEventForwarders } from "./events.ts";
import { emit, ensureConnected } from "./host-conn.ts";
import { logError, logInfo } from "./log.ts";
import { registerRemoteOpCommand } from "./remote-op-cmd.ts";
import { registerRpiv } from "./rpiv.ts";
import { buildInfo } from "./snapshot.ts";
import { g } from "./state.ts";
import { clearSessionUiState, patchUi } from "./ui-mirror.ts";

export default function piRemoteBridge(pi: ExtensionAPI): void {
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
