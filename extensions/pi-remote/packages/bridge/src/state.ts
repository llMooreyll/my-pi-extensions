import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RpivPrompt, UiRequest, UiResponse } from "../../protocol/src/index.ts";
import type { HostConn } from "./host-conn.ts";

export interface PendingUi {
  req: UiRequest;
  respond: (r: UiResponse) => void;
}

/** The current session instance; set on session_start, cleared on session_shutdown. */
export interface Binding {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  sessionId: string;
}

export type Placement = "aboveEditor" | "belowEditor";

export interface BridgeGlobal {
  processId: string;
  seq: number;
  enabled: boolean;
  compat: "ok" | "untested";
  conn?: HostConn;
  binding?: Binding;
  pendingUi: Map<string, PendingUi>;
  rpivOpen: Map<string, RpivPrompt>;
  remoteOps: Map<string, (cmdCtx: unknown) => Promise<unknown>>;
  inflight?: unknown;
  runningTools: Map<string, { toolName: string; args: unknown; partialText: string; lastSentAt: number }>;
  extStatus: Map<string, string>;
  extWidgets: Map<string, { lines: string[]; placement: Placement }>;
  lastText?: string;
  lastActiveAt?: number;
  lastStatus?: string;
  reloadPending: boolean;
  childSessionFiles: string[];
  widgetFactories: Map<string, { factory: Function; placement: Placement; lastText?: string }>;
  widgetTimer?: ReturnType<typeof setInterval>;
}

const KEY = "__piRemoteBridge";

/** Process-wide singleton: extension instances are recreated on reload and session replacement. */
export function g(): BridgeGlobal {
  const any = globalThis as Record<string, unknown>;
  if (!any[KEY]) {
    const init: BridgeGlobal = {
      processId: randomUUID(), seq: 0, enabled: false, compat: "ok",
      pendingUi: new Map(), rpivOpen: new Map(), remoteOps: new Map(),
      runningTools: new Map(), extStatus: new Map(), extWidgets: new Map(),
      reloadPending: false, childSessionFiles: [], widgetFactories: new Map(),
    };
    any[KEY] = init;
  }
  return any[KEY] as BridgeGlobal;
}
