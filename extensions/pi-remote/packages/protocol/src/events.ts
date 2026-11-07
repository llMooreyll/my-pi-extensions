import type { ContextUsageWire, ModelSummary, ProcessInfo, WireMessage } from "./model.ts";
import type { RpivPrompt, UiRequest } from "./ui.ts";

/** assistant 流式增量。来自 pi 的 assistantMessageEvent，去掉了 partial / message 字段 */
export type AssistantDelta =
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } };

export type BridgeEvent =
  | { type: "session_changed"; reason: string; info: ProcessInfo }
  | { type: "info"; info: ProcessInfo }                 // ProcessInfo 任一字段变化时发送完整新值
  | { type: "agent_start" }
  | { type: "agent_settled"; aborted: boolean; lastText?: string }
  | { type: "message_start"; message: WireMessage }
  | { type: "message_update"; delta: AssistantDelta }
  | { type: "message_end"; message: WireMessage }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; partialText: string }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean; durationMs?: number }
  | { type: "model_changed"; model: ModelSummary }
  | { type: "thinking_changed"; level: string }
  | { type: "compaction"; phase: "end" | "failed"; error?: string }
  | { type: "context_usage"; usage: ContextUsageWire }
  | { type: "ui_request"; req: UiRequest }
  | { type: "ui_closed"; uiId: string; by: "local" | "remote" }
  | { type: "rpiv_prompt"; prompt: RpivPrompt }
  | { type: "rpiv_closed"; toolCallId: string }
  | { type: "notify"; message: string; level: "info" | "warning" | "error" }
  | { type: "ext_status"; key: string; text?: string }
  | { type: "ext_widget"; key: string; lines?: string[]; placement: "aboveEditor" | "belowEditor" }
  | { type: "error"; message: string };                 // 例如异步 prompt 失败
