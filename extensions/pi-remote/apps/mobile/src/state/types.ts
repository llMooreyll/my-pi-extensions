import type { ProcessInfo, RpivPrompt, UiRequest, WireMessage } from "@pi-remote/protocol";

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; argsText?: string }
  | { type: string; [k: string]: unknown };

export interface RunningTool { toolName: string; args: unknown; partialText: string; startedAt: number }

export interface AssistantDraft { role: "assistant"; content: Block[] }

/** A message sent while pi was busy: pi has it queued, but it is not part of the conversation yet. */
export interface Queued { id: string; text: string; mode: "steer" | "followUp"; images: number; at: number }

export interface Toast { id: string; text: string; level: string; at: number }

export interface ProcessView {
  seq: number;
  info: ProcessInfo;
  messages: WireMessage[];
  hasMoreBefore: boolean;
  inflight?: AssistantDraft;
  /** startedAt is phone clock time. */
  runningTools: Record<string, RunningTool>;
  pendingUi: UiRequest[];
  pendingRpiv: RpivPrompt[];
  extStatus: Record<string, string>;
  extWidgets: Record<string, { lines: string[]; placement: string }>;
  toasts: Toast[];
  queued: Queued[];
  /** Local-only: a subscribe is in flight; incoming events are dropped until it resolves. */
  resyncing?: boolean;
  lastViewedAt: number;
  /** Phone clock time compaction started (from info.compacting); undefined when not compacting. */
  compactingSince?: number;
  /** Set when the process went down while a view existed. */
  gone?: boolean;
}
