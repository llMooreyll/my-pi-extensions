export const MAX_LIVE_MEMBERS = 4;
export const MEMBER_POLL_MS = 1000;
export const LEAD_POLL_MS = 1000;
export const LEAD_MONITOR_MS = 2000;
export const SPAWN_TIMEOUT_MS = 60_000;
export const STOP_TIMEOUT_MS = 60_000;
export const TEARDOWN_CLOSE_MS = 15_000;
/** How long a quitting lead waits for members to exit before its own process ends. */
export const QUIT_TEARDOWN_WAIT_MS = 5000;
export const BODY_INLINE_LIMIT = 2000;
export const LEAD_SUMMARY_LIMIT = 600;
export const CC_PREVIEW_LIMIT = 200;
export const PEER_HOP_LIMIT = 6;
export const MEMBER_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const TEAM_MESSAGE_TYPE = "team_message";
export const TEAM_NOTICE_TYPE = "team_notice";
export const MEMBER_TOOL_NAMES = ["team_report", "team_ask", "team_send"] as const;
export const DENIED_FOR_MEMBERS = "subagent,subagent_interrupt,subagents_list,subagent_resume";
