import type { Trust } from "../../protocol/src/index.ts";
import { registry } from "./registry.ts";
import { readSession } from "./session-reader.ts";
import { listProjects, listSessions } from "./sessions-index.ts";
import { listDirs } from "./dirs.ts";
import { getSettings, setSetting } from "./settings-service.ts";
import { openSession, restartProcess, spawnPi } from "./spawner.ts";
import { cancelTransfer, forgetTransfer, inboxDir, listTransfers, uploadBegin } from "./transfers.ts";

type Args = Record<string, unknown>;
type Result = { handled: true; result: unknown } | { handled: false };

/** Ops that hostd answers itself (subscribe/unsubscribe live in client-hub). */
export async function runLocalOp(op: string, a: Args, deviceId?: string): Promise<Result> {
  const done = (result: unknown): Result => ({ handled: true, result });
  switch (op) {
    case "list_processes": return done({ processes: registry.list() });
    case "list_sessions": return done({ sessions: await listSessions(a.cwd as string | undefined, a.refresh === true) });
    case "list_projects": return done({ projects: await listProjects() });
    case "open_session": return done(await openSession(a.sessionFile as string, a.trust as Trust));
    case "new_process": return done({ processId: await spawnPi({ cwd: a.cwd as string, trust: a.trust as Trust }) });
    case "get_settings": return done(getSettings());
    case "set_setting": return done(await setSetting(a.key as string, a.value));
    case "list_dirs": return done(await listDirs(String(a.path)));
    case "read_session": return done(readSession(a.sessionFile as string, a.beforeEntryId as string | undefined, (a.limit as number | undefined) ?? 200));
    case "restart_process": return done(await restartProcess(a.processId as string, a.trust as Trust));
    case "list_transfers": return done({ transfers: listTransfers(), inboxDir: inboxDir() });
    case "upload_begin": return done({ transfer: uploadBegin(a as { name: string; size: number; mime?: string; processId?: string }, deviceId) });
    case "transfer_cancel": cancelTransfer(a.id as string, deviceId); return done({});
    case "transfer_forget": forgetTransfer(a.id as string); return done({});
    default: return { handled: false };
  }
}
