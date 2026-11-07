import type { ProcessInfo, RpivPrompt, UiRequest, WireMessage } from "@pi-remote/protocol";

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; argsText?: string }
  | { type: string; [k: string]: unknown };

export interface AssistantDraft { role: "assistant"; content: Block[] }

export interface Toast { id: string; text: string; level: string; at: number }

export interface ProcessView {
  seq: number;
  info: ProcessInfo;
  messages: WireMessage[];
  hasMoreBefore: boolean;
  inflight?: AssistantDraft;
  runningTools: Record<string, { toolName: string; args: unknown; partialText: string }>;
  pendingUi: UiRequest[];
  pendingRpiv: RpivPrompt[];
  extStatus: Record<string, string>;
  extWidgets: Record<string, { lines: string[]; placement: string }>;
  toasts: Toast[];
  /** Local-only: a subscribe is in flight; incoming events are dropped until it resolves. */
  resyncing?: boolean;
  lastViewedAt: number;
  /** Set when the process went down while a view existed. */
  gone?: boolean;
}
