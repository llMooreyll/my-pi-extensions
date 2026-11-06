export type MessageKind = "task" | "message" | "report" | "question" | "cc";
export type ReportStatus = "done" | "progress" | "blocked" | "failed";
export type MemberState = "idle" | "working" | "awaiting_lead" | "failed" | "stopped" | "left";
export type MemberEnd = "stopped" | "left" | "lost";
export type ControlAction = "stop" | "teardown" | "interrupt";

export interface TeamMessage {
  id: string;
  ts: number;
  /** "lead" or a member name. */
  from: string;
  /** "lead" or a member name. */
  to: string;
  kind: MessageKind;
  body: string;
  urgent?: boolean;
  reportStatus?: ReportStatus;
  /** Peer exchange counter; only set on member-to-member messages. */
  hop?: number;
  /** Absolute path of the full text when `body` was truncated. */
  spillPath?: string;
}

export interface MemberStatus {
  instanceId: string;
  name: string;
  pid: number;
  state: MemberState;
  model?: string;
  updatedAt: number;
  lastError?: string;
}

export interface MemberRecord {
  instanceId: string;
  name: string;
  agent: string;
  write: boolean;
  spawnedAt: number;
  sessionFile: string;
  surface?: string;
  ended?: MemberEnd;
  /** Set only for write members. */
  repoTop?: string;
  subdir?: string;
  worktree?: string;
  branch?: string;
  base?: string;
  lastIntegrated?: string;
  links?: string[];
  sidecar?: string;
}

export interface RunInfo {
  runId: string;
  leadPid: number;
  leadSessionId: string;
  createdAt: number;
  closed: boolean;
}

export interface Roster {
  runId: string;
  members: MemberRecord[];
}

export interface ControlCommand {
  id: string;
  ts: number;
  action: ControlAction;
}

export interface WorktreeSidecar {
  runDir: string;
  instanceId: string;
}

/** One message of a batch as shown in the transcript (stored in `details.items`). */
export interface TeamItem {
  from: string;
  kind: MessageKind;
  status?: ReportStatus;
  body: string;
  spillPath?: string;
}
