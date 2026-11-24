import type { Trust } from "../../../protocol/src/index.ts";

/** What a source emits; every field except title may be omitted. */
export interface TriggerEvent {
  /** Source-scoped id used for dedupe; a random id (no dedupe) when missing. */
  id: string;
  /** Label for route matching, e.g. "mail", "webhook", "cli". Defaults to the configured source name. */
  source: string;
  /** e.g. "mail.new", "link.share". Defaults to "event". */
  kind: string;
  title: string;
  text?: string;
  data?: unknown;
  /** "@alias" or a session file; bypasses the routes. */
  target?: string;
  occurredAt: number;
}

export interface Route {
  id: string;
  /** Glob patterns ("*" wildcard) on event.source; any source when empty. */
  source: string[];
  kind: string[];
  /** Regular expression tested on title + text. */
  match?: RegExp;
  /** "@alias" or an absolute session file path. */
  target: string;
  /** Trusted instruction from this config, shown before the event. */
  instruction?: string;
  /** Reopen the target session when it is closed. */
  wake: boolean;
  /** Collect events of this route for this long before delivering them together. */
  batchWindowSec: number;
  /** 0 = no limit. */
  maxPerHour: number;
  /** Tools the run may use; undefined = all. */
  allowedTools?: string[];
  /** Show the event as plain text instead of wrapping it as untrusted external data. */
  trusted: boolean;
}

export type SourceConf =
  | { name: string; type: "dir"; path: string }
  | { name: string; type: "exec"; command: string[]; cwd?: string; intervalSec?: number; restartSec: number; timeoutSec: number }
  | { name: string; type: "module"; path: string; options: Record<string, unknown> };

export interface WebhookConf { enabled: boolean; host: string; port: number; token: string }

export interface HubConfig {
  enabled: boolean;
  /** Project trust for sessions the hub reopens (pi --approve / --no-approve). */
  trust: Trust;
  webhook: WebhookConf;
  sources: SourceConf[];
  routes: Route[];
}

/**
 * Read-only view of pi-trigger's per-session state file, written by the pi-trigger extension
 * (extensions/pi-trigger/src/state.ts). Only these fields are used here.
 */
export interface SessionStateView {
  sessionId: string;
  sessionFile?: string;
  alias?: string;
  aliasSetAt?: number;
  paused?: boolean;
  nextWakeAt?: number;
}

/** Matches ExternalItem in extensions/pi-trigger/src/runtime.ts (bridge op trigger_deliver). */
export interface DeliveryItem {
  key: string;
  source: string;
  kind: string;
  route: string;
  title: string;
  body: string;
  receivedAt: number;
  allowedTools?: string[];
}

export interface PendingDelivery {
  item: DeliveryItem;
  target: string;
  wake: boolean;
  maxPerHour: number;
  notBefore: number;
  attempts: number;
  nextAttemptAt: number;
  queuedAt: number;
}
