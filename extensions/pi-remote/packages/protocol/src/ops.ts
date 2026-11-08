import type { CommandInfo, ForkPoint, ModelSummary, ProcessInfo, ProjectItem, SessionListItem, TreeNodeWire, WireMessage } from "./model.ts";
import type { RpivAnswer, RpivPrompt, UiRequest, UiResponse } from "./ui.ts";

export type Trust = "approve" | "deny";
export type DeliverAs = "steer" | "followUp";

export interface ImageInput { data: string; mimeType: string }   // base64

export interface Snapshot {
  info: ProcessInfo;
  seq: number;                       // 快照对应的最后事件序号
  messages: WireMessage[];           // 活动分支上最近 N 条（含 entryId）
  hasMoreBefore: boolean;
  inflight?: WireMessage;            // 正在流式生成的 assistant 消息
  runningTools: { toolCallId: string; toolName: string; args: unknown; partialText: string }[];
  pendingUi: UiRequest[];
  pendingRpiv: RpivPrompt[];
  extStatus: Record<string, string>;
  extWidgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
}

/** 键为 op 名，值为 [参数, 返回] */
export interface OpMap {
  // ---- hostd 本地处理 ----
  list_processes: [{}, { processes: ProcessInfo[] }];
  list_sessions: [{ cwd?: string; refresh?: boolean }, { sessions: SessionListItem[] }];
  list_projects: [{}, { projects: ProjectItem[] }];
  open_session: [{ sessionFile: string; trust: Trust }, { processId: string; spawned: boolean }];
  new_process: [{ cwd: string; trust: Trust }, { processId: string }];
  subscribe: [{ processId: string; sinceSeq?: number }, { mode: "replay" } | { mode: "snapshot"; snapshot: Snapshot }];
  unsubscribe: [{ processId: string }, {}];
  get_settings: [{}, { values: Record<string, unknown> }];
  set_setting: [{ key: string; value: unknown }, { values: Record<string, unknown> }];
  /** 只读查看任意会话文件（例如已结束的子 agent），不启动 pi；7.2.16 */
  /** 列出电脑上某个目录下的子目录，供新建会话时补全路径；path 可用 ~ */
  list_dirs: [{ path: string }, { path: string; home: string; dirs: string[] }];
  read_session: [{ sessionFile: string; beforeEntryId?: string; limit?: number }, { cwd: string; name?: string; messages: WireMessage[]; hasMoreBefore: boolean }];
  // ---- 转发给 bridge ----
  prompt: [{ processId: string; text: string; images?: ImageInput[]; deliverAs?: DeliverAs }, { accepted: true }];
  abort: [{ processId: string }, {}];
  ui_respond: [{ processId: string; uiId: string; response: UiResponse }, {}];
  rpiv_answer: [{ processId: string; answer: RpivAnswer }, { ok: boolean; code?: string; reason?: string }];
  get_history: [{ processId: string; beforeEntryId: string; limit?: number }, { messages: WireMessage[]; hasMoreBefore: boolean }];
  get_commands: [{ processId: string }, { commands: CommandInfo[] }];
  get_models: [{ processId: string }, { current?: ModelSummary; models: ModelSummary[] }];
  set_model: [{ processId: string; provider: string; id: string }, { model: ModelSummary }];
  get_thinking_levels: [{ processId: string }, { current: string; levels: string[] }];
  set_thinking: [{ processId: string; level: string }, {}];
  compact: [{ processId: string; customInstructions?: string }, {}];
  get_tree: [{ processId: string }, { nodes: TreeNodeWire[]; leafId: string | null }];
  navigate_tree: [{ processId: string; entryId: string; summarize: boolean; customInstructions?: string }, { cancelled: boolean; editorText?: string }];
  get_fork_points: [{ processId: string }, { points: ForkPoint[] }];
  fork: [{ processId: string; entryId: string; position: "before" | "at" }, { cancelled: boolean; prefillText?: string }];
  new_session: [{ processId: string }, { cancelled: boolean }];
  switch_session: [{ processId: string; sessionFile: string }, { cancelled: boolean }];
  set_name: [{ processId: string; name: string }, {}];
  reload: [{ processId: string }, {}];
  shutdown: [{ processId: string }, {}];
}

export type OpName = keyof OpMap;
export type OpArgs<K extends OpName> = OpMap[K][0];
export type OpResult<K extends OpName> = OpMap[K][1];

export const HOSTD_LOCAL_OPS: readonly OpName[] = [
  "list_processes", "list_sessions", "list_projects", "open_session", "new_process",
  "subscribe", "unsubscribe", "get_settings", "set_setting", "read_session", "list_dirs",
];

/** hostd → bridge 请求超时（毫秒）。未列出的用 DEFAULT */
export const OP_TIMEOUT_MS: Partial<Record<OpName, number>> & { DEFAULT: number } = {
  DEFAULT: 15_000,
  compact: 600_000,
  navigate_tree: 300_000,
  fork: 60_000,
  new_session: 60_000,
  switch_session: 60_000,
  reload: 120_000,
};
