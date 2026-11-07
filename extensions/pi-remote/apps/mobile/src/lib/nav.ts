import { router } from "expo-router";
import { useStore } from "../state/store";

/** Open a session file: jump to its live process when there is one, otherwise show the read-only history. */
export function openSessionFile(sessionFile: string): void {
  const live = Object.values(useStore.getState().procs).find((p) => p.sessionFile === sessionFile);
  if (live) router.push({ pathname: "/session/[processId]", params: { processId: live.processId } });
  else router.push({ pathname: "/history", params: { sessionFile } });
}

export function openProcess(processId: string): void {
  router.push({ pathname: "/session/[processId]", params: { processId } });
}
