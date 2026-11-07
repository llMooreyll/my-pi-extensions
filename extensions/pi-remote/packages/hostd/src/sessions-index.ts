import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { ProjectItem, SessionListItem } from "../../protocol/src/index.ts";
import { registry } from "./registry.ts";

let cache: { at: number; items: SessionInfo[] } | undefined;
let inflight: Promise<SessionInfo[]> | undefined;

export async function allSessions(refresh = false): Promise<SessionInfo[]> {
  if (!refresh && cache && Date.now() - cache.at < 10_000) return cache.items;
  inflight ??= SessionManager.listAll().then((items) => { cache = { at: Date.now(), items }; return items; }).finally(() => { inflight = undefined; });
  return inflight;
}

export async function findSessionInfo(file: string): Promise<SessionInfo | undefined> {
  const hit = (await allSessions()).find((s) => s.path === file);
  return hit ?? (await allSessions(true)).find((s) => s.path === file);
}

export async function listSessions(cwd?: string, refresh = false): Promise<SessionListItem[]> {
  const items = (await allSessions(refresh)).filter((s) => !cwd || s.cwd === cwd);
  return items
    .map((s): SessionListItem => {
      const live = registry.findBySessionFile(s.path);
      return {
        sessionFile: s.path, sessionId: s.id, cwd: s.cwd, ...(s.name ? { name: s.name } : {}),
        created: s.created.toISOString(), modified: s.modified.toISOString(), messageCount: s.messageCount,
        firstMessage: (s.firstMessage ?? "").slice(0, 200), ...(live ? { liveProcessId: live.info.processId } : {}),
      };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

export async function listProjects(): Promise<ProjectItem[]> {
  const map = new Map<string, ProjectItem>();
  for (const s of await allSessions()) {
    if (!s.cwd) continue;
    const m = s.modified.toISOString();
    const p = map.get(s.cwd);
    if (!p) map.set(s.cwd, { cwd: s.cwd, lastModified: m, sessionCount: 1 });
    else { p.sessionCount++; if (m > p.lastModified) p.lastModified = m; }
  }
  const now = new Date().toISOString();
  for (const info of registry.list()) {
    const p = map.get(info.cwd);
    if (!p) map.set(info.cwd, { cwd: info.cwd, lastModified: now, sessionCount: 0 });
    else p.lastModified = now;
  }
  return [...map.values()].sort((a, b) => b.lastModified.localeCompare(a.lastModified));
}
