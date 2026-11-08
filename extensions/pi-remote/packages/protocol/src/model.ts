export type ProcessStatus = "idle" | "running" | "waiting_ui";

export interface ModelSummary {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];          // 例如 ["text","image"]
  contextWindow?: number;
}

export interface ContextUsageWire {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** 进程角色，由 bridge 从环境变量判断（7.6.1） */
export type ProcessRole =
  | { kind: "main" }
  | { kind: "subagent"; subagentId: string; name: string; agent?: string; autoExit: boolean; parentSessionId?: string }
  | { kind: "team_member"; memberId: string; name: string; agent?: string; write: boolean;
      branch?: string; worktree?: string; leadPid: number; runDir?: string };

export interface ProcessInfo {
  processId: string;
  pid: number;
  role: ProcessRole;
  /** 由 hostd 填写（7.6.2）；父进程不在线或无法推导时为空。bridge 上报时不带此字段 */
  parentProcessId?: string;
  /** bridge 上报：本进程启动过的子 agent 会话文件（最多 50 个，新的在前），供 hostd 推导父子关系 */
  childSessionFiles: string[];
  tmuxPane?: string;        // $TMUX_PANE，例如 "%12"
  spawnedByHostd: boolean;
  piVersion: string;
  compat: "ok" | "untested";
  cwd: string;
  sessionId: string;
  sessionFile?: string;     // --no-session 时为空
  sessionName?: string;
  model?: ModelSummary;
  thinkingLevel: string;
  status: ProcessStatus;
  pendingUiCount: number;   // 未关闭的对话框 + 问卷数
  /** 最近一次活动（运行开始/结束、新消息）的时间，毫秒；用于按活动排序 */
  lastActiveAt?: number;
  lastText?: string;        // 最近一次 agent_settled 时最后一条 assistant 文本的前 120 字符
  contextUsage?: ContextUsageWire;
  lastSeq: number;
}

export interface SessionListItem {
  sessionFile: string;
  sessionId: string;
  cwd: string;
  name?: string;
  created: string;          // ISO
  modified: string;         // ISO
  messageCount: number;
  firstMessage: string;     // 截断到 200 字符
  liveProcessId?: string;
}

export interface ProjectItem { cwd: string; lastModified: string; sessionCount: number }

/** 消息的线上形态：pi AgentMessage 经过 sanitize（见 7.1.7） */
export interface WireMessage {
  role: string;             // user | assistant | toolResult | bashExecution | custom | branchSummary | compactionSummary
  entryId?: string;         // 来自会话树的条目才有
  [key: string]: unknown;
}

export interface TreeNodeWire {
  id: string;
  parentId: string | null;
  kind: "user" | "assistant" | "toolResult" | "custom" | "compaction" | "branch_summary" | "bash" | "other";
  preview: string;          // 前 120 字符
  label?: string;
  timestamp: string;
  onActivePath: boolean;
  isLeaf: boolean;          // 是否为当前活动叶子
  childCount: number;
}

export interface ForkPoint { entryId: string; text: string; timestamp: string }

export interface CommandInfo { name: string; description?: string; source: string }
