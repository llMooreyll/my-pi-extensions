import { homedir } from "node:os";
import { join } from "node:path";

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}
export function teamRoot(artifactDir: string): string {
  return join(artifactDir, "team");
}
export function runsDir(root: string): string {
  return join(root, "runs");
}
export function runDirOf(root: string, runId: string): string {
  return join(runsDir(root), runId);
}
export function runFile(runDir: string): string {
  return join(runDir, "run.json");
}
export function rosterFile(runDir: string): string {
  return join(runDir, "members.json");
}
export function leadInbox(runDir: string): string {
  return join(runDir, "lead", "inbox");
}
export function spillDir(runDir: string): string {
  return join(runDir, "spill");
}
export function memberDir(runDir: string, instanceId: string): string {
  return join(runDir, "members", instanceId);
}
export function memberInbox(runDir: string, instanceId: string): string {
  return join(memberDir(runDir, instanceId), "inbox");
}
export function memberControl(runDir: string, instanceId: string): string {
  return join(memberDir(runDir, instanceId), "control");
}
export function memberStatusFile(runDir: string, instanceId: string): string {
  return join(memberDir(runDir, instanceId), "status.json");
}
export function worktreesRoot(): string {
  return join(agentDir(), "team", "worktrees");
}
