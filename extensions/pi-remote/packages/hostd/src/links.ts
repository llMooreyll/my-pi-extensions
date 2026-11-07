import { realpathSync } from "node:fs";
import type { ProcessInfo } from "../../protocol/src/index.ts";
import { registry } from "./registry.ts";

const realCache = new Map<string, string>();
const norm = (f?: string) => {
  if (!f) return undefined;
  let r = realCache.get(f);
  if (r === undefined) {
    // A session file that does not exist yet (the child has just been launched) must not be cached
    // as itself: once it exists and resolves through a symlink the two sides would never match.
    try { r = realpathSync(f); realCache.set(f, r); } catch { return f; }
  }
  return r;
};

/** Derive parentProcessId for subagents and team members. Returns processes whose parent changed. */
export function recompute(): ProcessInfo[] {
  const all = registry.entries();
  const changed: ProcessInfo[] = [];
  for (const e of all) {
    const role = e.info.role;
    let parent: string | undefined;
    if (role.kind === "team_member") {
      parent = all.find((x) => x !== e && x.info.pid === role.leadPid)?.info.processId;
    } else if (role.kind === "subagent") {
      const mine = norm(e.info.sessionFile);
      parent = mine ? all.find((x) => x !== e && (x.info.childSessionFiles ?? []).some((c) => norm(c) === mine))?.info.processId : undefined;
      // Fallback: the parent's session id, taken from the launch environment (see bridge/src/role.ts).
      if (!parent && role.parentSessionId) parent = all.find((x) => x !== e && x.info.sessionId === role.parentSessionId)?.info.processId;
    }
    if (parent !== e.info.parentProcessId) {
      if (parent === undefined) delete e.info.parentProcessId; else e.info.parentProcessId = parent;
      changed.push(e.info);
    }
  }
  return changed;
}
