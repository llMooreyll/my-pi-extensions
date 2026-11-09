import type { ProcessInfo } from "@pi-remote/protocol";
import { call } from "../net/connection";

/** Quit a pi on the computer. A running pi is stopped first, otherwise it would only quit once its run ends. */
export async function closeProcess(info: ProcessInfo): Promise<void> {
  if (info.status !== "idle") await call("abort", { processId: info.processId }).catch(() => {});
  await call("shutdown", { processId: info.processId });
}

export const canRestart = (info: ProcessInfo) => info.role.kind === "main" && !!info.sessionFile;

const busyNote = (info: ProcessInfo) => (info.status !== "idle" ? " Its current work is stopped first." : "");
const terminalNote = (info: ProcessInfo) =>
  !info.spawnedByHostd && info.role.kind === "main" ? " It was started in a terminal on the computer; that terminal goes back to its shell." : "";

export function closeText(info: ProcessInfo): { title: string; body: string } {
  return {
    title: "Close this pi?",
    body: `pi quits on the computer.${busyNote(info)} The conversation stays on disk; open it again any time from Recent sessions.${terminalNote(info)}`,
  };
}

export function restartText(info: ProcessInfo): { title: string; body: string } {
  const where = !info.spawnedByHostd ? " The new pi runs in the tmux session \"pi-remote\" on the computer, not in the old terminal." : "";
  return {
    title: "Restart this pi?",
    body: `pi quits and the same conversation opens again in a fresh pi, with the extensions, tools and settings as they are now.${busyNote(info)}${where}`,
  };
}
