import type { ProcessRole } from "../../protocol/src/index.ts";

/** Role from environment variables set by pi-interactive-subagents (plan 7.6.1). */
export function detectRole(): ProcessRole {
  const e = process.env;
  if (e.PI_TEAM_MEMBER_ID && e.PI_TEAM_LEAD_PID) {
    return {
      kind: "team_member", memberId: e.PI_TEAM_MEMBER_ID, name: e.PI_TEAM_MEMBER_NAME || e.PI_TEAM_MEMBER_ID,
      agent: e.PI_TEAM_AGENT || undefined, write: e.PI_TEAM_WRITE === "1",
      branch: e.PI_TEAM_BRANCH || undefined, worktree: e.PI_TEAM_WORKTREE || undefined,
      leadPid: Number(e.PI_TEAM_LEAD_PID), runDir: e.PI_TEAM_RUN_DIR || undefined,
    };
  }
  if (e.PI_SUBAGENT_ID) {
    return {
      kind: "subagent", subagentId: e.PI_SUBAGENT_ID, name: e.PI_SUBAGENT_NAME || e.PI_SUBAGENT_ID,
      agent: e.PI_SUBAGENT_AGENT || undefined, autoExit: e.PI_SUBAGENT_AUTO_EXIT === "1",
    };
  }
  return { kind: "main" };
}
