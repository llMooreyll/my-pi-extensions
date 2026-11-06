/**
 * Lead side of agent teams: spawns long-lived members, routes messages, and
 * integrates the work of write members back into the main working tree.
 *
 * All mutable state lives inside registerTeamLead(): Pi reuses loaded modules
 * across /new, /resume and /fork, so module-level timers or caches would leak.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeSurface, createSurface, isMuxAvailable, muxSetupHint, sendLongCommand, shellEscape } from "../subagents/cmux.ts";
import {
  DENIED_FOR_MEMBERS,
  LEAD_MONITOR_MS,
  LEAD_POLL_MS,
  LEAD_SUMMARY_LIMIT,
  MAX_LIVE_MEMBERS,
  MEMBER_NAME_RE,
  MEMBER_TOOL_NAMES,
  QUIT_TEARDOWN_WAIT_MS,
  SPAWN_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  TEAM_MESSAGE_TYPE,
  TEAM_NOTICE_TYPE,
  TEARDOWN_CLOSE_MS,
} from "./constants.ts";
import { pidAlive, randomHex, readJson, truncate, writeJsonAtomic } from "./fsutil.ts";
import {
  addWorktree,
  branchExists,
  createSnapshot,
  deleteBranch,
  getRepoInfo,
  GitError,
  initSubmodules,
  integrateBranch,
  isWorktreeClean,
  linkIgnoredPaths,
  pruneWorktrees,
  removeWorktreeAndBranch,
  repoBusyReason,
  repoKey,
  resetWorktree,
  revParse,
} from "./git.ts";
import {
  deliveredIdsFromEntries,
  ensureMaildir,
  listPending,
  markDelivered,
  newMessageId,
  prepareBody,
  writeControl,
  writeMessage,
} from "./mailbox.ts";
import {
  leadInbox,
  memberControl,
  memberDir,
  memberInbox,
  memberStatusFile,
  rosterFile,
  runDirOf,
  runFile,
  runsDir,
  spillDir,
  teamRoot,
  worktreesRoot,
} from "./paths.ts";
import { LEAD_TOOL_GUIDELINES, memberSystemAppendix } from "./prompts.ts";
import type {
  MemberEnd,
  MemberRecord,
  MemberStatus,
  Roster,
  RunInfo,
  TeamMessage,
  WorktreeSidecar,
} from "./types.ts";

export interface TeamLeadDeps {
  loadAgentDefaults(agentName: string): any;
  resolveModelChain(
    spec: string | undefined,
    registry: any,
  ): { primary?: string; fallbacks: string[]; unavailable: string[] };
  getArtifactDir(sessionDir: string, sessionId: string): string;
  getShellReadyDelayMs(): number;
}

const MEMBER_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "member.ts");

type CleanupResult = "none" | "removed" | "kept-dirty" | "kept-unintegrated";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delete a write member's worktree and branch, but only when nothing would be
 * lost: no uncommitted changes and no commits beyond the last integration.
 */
function cleanupMemberWorktree(m: MemberRecord): CleanupResult {
  if (!m.write || !m.repoTop || !m.branch) return "none";
  try {
    const mark = m.lastIntegrated ?? m.base!;
    if (!m.worktree || !existsSync(m.worktree)) {
      pruneWorktrees(m.repoTop);
      if (!branchExists(m.repoTop, m.branch) || revParse(m.branch, m.repoTop) === mark) {
        deleteBranch(m.repoTop, m.branch);
        if (m.sidecar) rmSync(m.sidecar, { force: true });
        return "removed";
      }
      return "kept-unintegrated";
    }
    if (!isWorktreeClean(m.worktree, m.links)) return "kept-dirty";
    if (revParse(m.branch, m.repoTop) !== mark) return "kept-unintegrated";
    // rmSync without `recursive` removes the symlink itself, never its target.
    for (const rel of m.links ?? []) rmSync(join(m.worktree, rel), { force: true });
    removeWorktreeAndBranch(m.repoTop, m.worktree, m.branch);
    if (m.sidecar) rmSync(m.sidecar, { force: true });
    return "removed";
  } catch {
    return "kept-dirty";
  }
}

function keptWorktreeNote(m: MemberRecord, result: CleanupResult): string {
  if (result === "kept-dirty") return `Worktree kept at ${m.worktree} (uncommitted changes).`;
  if (result === "kept-unintegrated") {
    return `Worktree kept at ${m.worktree} (branch ${m.branch} has commits not yet integrated; run team_integrate).`;
  }
  return "";
}

/**
 * Wait for members to exit, then close their panes and clean their worktrees.
 * Uses no Pi API: it can run after the session that started it is gone.
 */
async function finishTeardown(members: MemberRecord[], runDir: string, maxWaitMs: number): Promise<void> {
  const memberPid = (m: MemberRecord) =>
    readJson<MemberStatus>(memberStatusFile(runDir, m.instanceId))?.pid;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline && members.some((m) => pidAlive(memberPid(m)))) {
    await sleep(200);
  }
  for (const m of members) {
    if (m.surface) {
      try {
        closeSurface(m.surface);
      } catch {}
    }
  }
  for (const m of members) {
    if (m.write && !pidAlive(memberPid(m))) cleanupMemberWorktree(m);
  }
}

export function registerTeamLead(pi: ExtensionAPI, deps: TeamLeadDeps): void {
  let ctxRef: ExtensionContext | null = null;
  let root: string | null = null;
  let run: RunInfo | null = null;
  let runDir: string | null = null;
  let roster: Roster | null = null;
  const delivered = new Set<string>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let monitorTimer: ReturnType<typeof setInterval> | null = null;
  const stopDeadlines = new Map<string, number>();

  // ── helpers ──

  function saveRoster(): void {
    if (runDir && roster) writeJsonAtomic(rosterFile(runDir), roster);
  }

  function liveMembers(): MemberRecord[] {
    return roster?.members.filter((m) => !m.ended) ?? [];
  }

  function findMember(name: string, includeEnded: boolean): MemberRecord | undefined {
    return (roster?.members ?? [])
      .filter((m) => m.name === name && (includeEnded || !m.ended))
      .sort((a, b) => b.spawnedAt - a.spawnedAt)[0];
  }

  function readStatus(m: MemberRecord): MemberStatus | null {
    return runDir ? readJson<MemberStatus>(memberStatusFile(runDir, m.instanceId)) : null;
  }

  function notify(text: string, wake: boolean): void {
    pi.sendMessage(
      { customType: TEAM_NOTICE_TYPE, content: `[team] ${text}`, display: true },
      { triggerTurn: wake, deliverAs: "steer" },
    );
  }

  function updateWidget(): void {
    if (!ctxRef?.hasUI) return;
    try {
      const live = liveMembers();
      if (live.length === 0) {
        ctxRef.ui.setWidget("team-status", undefined);
        return;
      }
      const lines = live.map(
        (m) =>
          `${m.name}  ${readStatus(m)?.state ?? "starting"}  ${m.agent}${m.branch ? `  ${m.branch}` : ""}`,
      );
      ctxRef.ui.setWidget("team-status", ["Team", ...lines], { placement: "belowEditor" });
    } catch {
      // The widget is cosmetic.
    }
  }

  function startTimers(): void {
    if (!pollTimer) pollTimer = setInterval(pollLeadInbox, LEAD_POLL_MS);
    if (!monitorTimer) monitorTimer = setInterval(monitorMembers, LEAD_MONITOR_MS);
  }

  function stopTimers(): void {
    if (pollTimer) clearInterval(pollTimer);
    if (monitorTimer) clearInterval(monitorTimer);
    pollTimer = null;
    monitorTimer = null;
  }

  function ensureRun(ctx: ExtensionContext): void {
    if (run && runDir && roster) return;
    const sm = ctx.sessionManager;
    root = teamRoot(deps.getArtifactDir(sm.getSessionDir(), sm.getSessionId()));
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
    const runId = `${stamp}-${randomHex(2)}`;
    runDir = runDirOf(root, runId);
    run = { runId, leadPid: process.pid, leadSessionId: sm.getSessionId(), createdAt: Date.now(), closed: false };
    writeJsonAtomic(runFile(runDir), run);
    roster = { runId, members: [] };
    saveRoster();
    ensureMaildir(leadInbox(runDir));
    startTimers();
  }

  function formatForLead(m: TeamMessage): string {
    let text: string;
    let spillPath = m.spillPath;
    if (m.kind === "report") {
      // Reports reach the lead as a short summary; the full text stays on disk.
      if (m.body.length > LEAD_SUMMARY_LIMIT && !spillPath && runDir) {
        mkdirSync(spillDir(runDir), { recursive: true });
        spillPath = join(spillDir(runDir), `${m.id}.md`);
        writeFileSync(spillPath, m.body, "utf8");
      }
      text = `[team] ${m.from} reports ${m.reportStatus ?? "done"}:\n${truncate(m.body, LEAD_SUMMARY_LIMIT)}`;
      if (spillPath) text += `\n(full text: ${spillPath})`;
      return text;
    }
    if (m.kind === "question") {
      text = `[team] ${m.from} asks:\n${m.body}\nAnswer with team_send({ to: "${m.from}", message: ... }).`;
    } else if (m.kind === "cc") {
      text = `[team cc] ${m.body}`;
    } else {
      text = `[team] message from ${m.from}:\n${m.body}`;
    }
    if (spillPath) text += `\n(full text: ${spillPath})`;
    return text;
  }

  function pollLeadInbox(): void {
    try {
      if (!runDir || !ctxRef) return;
      const inbox = leadInbox(runDir);
      const pending = listPending(inbox).filter((m) => !delivered.has(m.id));
      if (pending.length === 0) return;
      const wake = pending.some((m) => m.kind !== "cc");
      const content = pending.map(formatForLead).join("\n\n---\n\n");
      pi.sendMessage(
        { customType: TEAM_MESSAGE_TYPE, content, display: true, details: { ids: pending.map((m) => m.id) } },
        { triggerTurn: wake, deliverAs: "steer" },
      );
      for (const m of pending) delivered.add(m.id);
    } catch {
      // One failed poll must not stop the loop.
    }
  }

  function endMember(m: MemberRecord, end: MemberEnd, detail?: string): void {
    m.ended = end;
    saveRoster();
    stopDeadlines.delete(m.instanceId);
    // After "left" the user is working in that pane; leave it open.
    if (m.surface && end !== "left") {
      try {
        closeSurface(m.surface);
      } catch {}
    }
    const cleanup = m.write ? cleanupMemberWorktree(m) : "none";
    const parts = [`${m.name} ${end}${detail ? ` (${detail})` : ""}.`];
    const kept = keptWorktreeNote(m, cleanup);
    if (kept) parts.push(kept);
    notify(parts.join(" "), end !== "stopped");
  }

  function monitorMembers(): void {
    try {
      if (!runDir) return;
      for (const m of liveMembers()) {
        const status = readStatus(m);
        if (!status) {
          if (Date.now() - m.spawnedAt > SPAWN_TIMEOUT_MS) endMember(m, "lost", "did not start within 60s");
          continue;
        }
        if (status.state === "stopped" || status.state === "left") {
          endMember(m, status.state);
          continue;
        }
        if (!pidAlive(status.pid)) {
          endMember(m, "lost", "process exited unexpectedly");
          continue;
        }
        const deadline = stopDeadlines.get(m.instanceId);
        if (deadline !== undefined && Date.now() > deadline) {
          endMember(m, "stopped", "forced after stop timeout");
        }
      }
      updateWidget();
    } catch {
      // One failed pass must not stop the loop.
    }
  }

  /** Remove worktrees left behind by runs whose lead is gone. */
  function cleanupStaleWorktrees(ctx: ExtensionContext): void {
    try {
      const repo = getRepoInfo(ctx.cwd);
      if (!repo) return;
      const dir = join(worktreesRoot(), repoKey(repo.commonDir));
      if (!existsSync(dir)) return;
      const kept: string[] = [];
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
        const side = readJson<WorktreeSidecar>(join(dir, file));
        if (!side) continue;
        const info = readJson<RunInfo>(runFile(side.runDir));
        const stale = !info || info.closed || !pidAlive(info.leadPid);
        if (!stale) continue; // another live lead owns it
        const rosterData = readJson<Roster>(rosterFile(side.runDir));
        const record = rosterData?.members.find((m) => m.instanceId === side.instanceId);
        if (!record) continue;
        const memberStatus = readJson<MemberStatus>(memberStatusFile(side.runDir, side.instanceId));
        if (memberStatus && pidAlive(memberStatus.pid)) continue; // still exiting; retry next start
        const result = cleanupMemberWorktree(record);
        if (result === "kept-dirty" || result === "kept-unintegrated") kept.push(`${record.worktree} (${result})`);
      }
      pruneWorktrees(repo.top);
      if (kept.length > 0 && ctx.hasUI) {
        ctx.ui.notify(`pi-team kept ${kept.length} worktree(s) with unfinished work:\n${kept.join("\n")}`, "warning");
      }
    } catch {
      // Cleanup is best effort; leftovers are retried at the next start.
    }
  }

  // ── lifecycle ──

  pi.on("session_start", (event, ctx) => {
    ctxRef = ctx;
    try {
      const sm = ctx.sessionManager;
      root = teamRoot(deps.getArtifactDir(sm.getSessionDir(), sm.getSessionId()));
      const reason = (event as any).reason;
      const dir = runsDir(root);
      if (existsSync(dir)) {
        for (const entry of readdirSync(dir)) {
          const file = runFile(join(dir, entry));
          const info = readJson<RunInfo>(file);
          if (!info || info.closed) continue;
          if (reason === "reload" && !run && info.leadPid === process.pid) {
            run = info;
            runDir = join(dir, entry);
            roster = readJson<Roster>(rosterFile(runDir)) ?? { runId: info.runId, members: [] };
            for (const id of deliveredIdsFromEntries(sm.getEntries() as any[], TEAM_MESSAGE_TYPE)) {
              delivered.add(id);
              markDelivered(leadInbox(runDir), id);
            }
            continue;
          }
          if (info.leadPid !== process.pid && pidAlive(info.leadPid)) continue; // used by another process
          info.closed = true;
          writeJsonAtomic(file, info);
        }
      }
      if (run) {
        startTimers();
        updateWidget();
      }
      if (reason !== "reload") cleanupStaleWorktrees(ctx);
    } catch {
      // A broken team directory must not prevent the session from starting.
    }
  });

  pi.on("message_end", (event) => {
    const m = (event as any).message;
    if (!runDir || m?.role !== "custom" || m.customType !== TEAM_MESSAGE_TYPE) return;
    for (const id of m.details?.ids ?? []) markDelivered(leadInbox(runDir), String(id));
  });

  pi.on("session_shutdown", async (event) => {
    stopTimers();
    // On reload members keep running and the new instance re-attaches.
    if ((event as any).reason === "reload") return;
    const currentRunDir = runDir;
    const members = liveMembers().map((m) => ({ ...m }));
    try {
      if (run && currentRunDir) {
        for (const m of members) writeControl(memberControl(currentRunDir, m.instanceId), "teardown");
        run.closed = true;
        writeJsonAtomic(runFile(currentRunDir), run);
      }
    } catch {}
    run = null;
    runDir = null;
    roster = null;
    ctxRef = null;
    delivered.clear();
    stopDeadlines.clear();
    if (!currentRunDir || members.length === 0) return;
    // finishTeardown uses no Pi API, so it may outlive this session.
    const finished = finishTeardown(members, currentRunDir, TEARDOWN_CLOSE_MS).catch(() => {});
    if ((event as any).reason === "quit") {
      // The process is about to exit: give members a short window to leave first.
      await Promise.race([finished, sleep(QUIT_TEARDOWN_WAIT_MS)]);
    }
  });

  // ── tools ──

  pi.registerTool({
    name: "team_spawn",
    label: "Team Spawn",
    description:
      "Spawn a long-lived team member in its own terminal pane. Returns immediately; the member's reports and questions arrive automatically as team messages, so do not poll or sleep. " +
      "Use write: true for a member that edits code: it gets its own git worktree and branch, and its committed work reaches the main tree through team_integrate.",
    promptSnippet: "Spawn a long-lived team member in its own terminal pane.",
    promptGuidelines: LEAD_TOOL_GUIDELINES,
    parameters: Type.Object({
      name: Type.String({
        description: "Member name: lowercase letters, digits and dashes; unique among live members",
      }),
      agent: Type.String({ description: "Agent definition to use (e.g. scout, reviewer, worker)" }),
      task: Type.String({ description: "First task for the member" }),
      write: Type.Optional(
        Type.Boolean({
          description:
            "true: the member gets its own git worktree and may edit and commit there. Default false (read-only).",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Model override; comma-separated list = ordered fallback chain. Only with the user's consent.",
        }),
      ),
      link: Type.Optional(
        Type.Array(Type.String(), {
          description: "Git-ignored paths (e.g. node_modules) to symlink into the worktree. write members only.",
        }),
      ),
      approveProject: Type.Optional(
        Type.Boolean({
          description: "Load project-local .pi resources in the member (passes --approve). Default false (--no-approve).",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      ctxRef = ctx;
      const name = params.name.trim();
      const write = params.write === true;

      if (!isMuxAvailable()) return textResult(muxSetupHint());
      if (!ctx.sessionManager.getSessionFile()) return textResult("Team mode needs a persistent session.");
      if (!MEMBER_NAME_RE.test(name) || name === "lead") {
        return textResult(`Invalid member name "${name}": use lowercase letters, digits and dashes, starting with a letter.`);
      }
      if (findMember(name, false)) return textResult(`A live member named "${name}" already exists.`);
      if (liveMembers().length >= MAX_LIVE_MEMBERS) {
        return textResult(`Team already has ${MAX_LIVE_MEMBERS} live members; stop one first.`);
      }
      if (!write && params.link && params.link.length > 0) {
        return textResult("link is only supported together with write: true.");
      }

      const defs = deps.loadAgentDefaults(params.agent);
      if (!defs) return textResult(`Unknown agent "${params.agent}".`);
      if (defs.cli === "claude") return textResult("Claude Code agents cannot be team members.");

      const denied = new Set<string>(
        String(defs.denyTools ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      const requested = String(defs.tools ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && !denied.has(s));
      if (!write && requested.some((t) => t === "edit" || t === "write")) {
        return textResult(`Agent "${params.agent}" has write tools; spawn it with write: true.`);
      }
      const allowlist = requested.length > 0 ? [...new Set([...requested, ...MEMBER_TOOL_NAMES])].join(",") : null;

      const chain = deps.resolveModelChain(params.model ?? defs.model, ctx.modelRegistry);
      if (!chain.primary && chain.unavailable.length > 0) {
        return textResult(
          `None of the configured models is usable: ${chain.unavailable.join(", ")}. ` +
            `Ask the user which model to use; do not pick a model yourself.`,
        );
      }

      let repo = null as ReturnType<typeof getRepoInfo>;
      if (write) {
        repo = getRepoInfo(ctx.cwd);
        if (!repo) return textResult("The working directory is not inside a git repository; write members need git.");
        const busy = repoBusyReason(repo.top);
        if (busy) return textResult(`Cannot spawn a write member: ${busy}.`);
      }

      try {
        ensureRun(ctx);
      } catch (err) {
        return textResult(`Could not create the team run: ${(err as Error).message}`);
      }
      const currentRun = run!;
      const currentRunDir = runDir!;
      const instanceId = `${name}-${randomHex(3)}`;
      const memberRoot = memberDir(currentRunDir, instanceId);

      let base: string | undefined;
      if (write) {
        try {
          base = createSnapshot(repo!.top, `pi-team snapshot ${currentRun.runId} ${name}`);
        } catch (err) {
          return textResult(`Could not snapshot the working tree: ${(err as Error).message}`);
        }
      }

      const sessionFile = join(
        ctx.sessionManager.getSessionDir(),
        `${new Date().toISOString().replace(/[:.]/g, "-")}_team-${instanceId}.jsonl`,
      );
      const record: MemberRecord = {
        instanceId,
        name,
        agent: params.agent,
        write,
        spawnedAt: Date.now(),
        sessionFile,
      };
      let worktree: string | undefined;
      let branch: string | undefined;
      if (write && repo) {
        const key = repoKey(repo.commonDir);
        branch = `pi-team/${currentRun.runId}/${instanceId}`;
        worktree = join(worktreesRoot(), key, `${currentRun.runId}-${instanceId}`);
        record.repoTop = repo.top;
        record.subdir = repo.subdir;
        record.worktree = worktree;
        record.branch = branch;
        record.base = base;
        record.sidecar = join(worktreesRoot(), key, `${currentRun.runId}-${instanceId}.json`);
      }
      roster!.members.push(record);
      saveRoster();

      const warnings: string[] = [];
      let surface: string | undefined;
      try {
        ensureMaildir(memberInbox(currentRunDir, instanceId));
        ensureMaildir(memberControl(currentRunDir, instanceId));

        let cwd = ctx.cwd;
        if (write && repo && worktree && branch) {
          addWorktree(repo.top, branch, worktree, base!);
          const sub = initSubmodules(repo.top, worktree);
          if (sub) warnings.push(sub);
          const linkResult = linkIgnoredPaths(repo.top, worktree, params.link ?? []);
          record.links = linkResult.linked;
          warnings.push(...linkResult.warnings);
          const sidecarData: WorktreeSidecar = { runDir: currentRunDir, instanceId };
          writeJsonAtomic(record.sidecar!, sidecarData);
          saveRoster();
          cwd = repo.subdir ? join(worktree, repo.subdir) : worktree;
        }

        const appendix = memberSystemAppendix({
          name,
          write,
          worktree,
          branch,
          subdir: repo?.subdir,
          links: record.links,
        });
        const systemPath = join(memberRoot, "system.md");
        writeFileSync(systemPath, [defs.body ?? "", appendix].filter(Boolean).join("\n\n"), "utf8");

        const id = newMessageId();
        const prepared = prepareBody(spillDir(currentRunDir), id, params.task);
        writeMessage(memberInbox(currentRunDir, instanceId), {
          id,
          ts: Date.now(),
          from: "lead",
          to: name,
          kind: "task",
          body: prepared.body,
          spillPath: prepared.spillPath,
        });

        surface = createSurface(`team:${name}`);
        record.surface = surface;
        saveRoster();
        await sleep(deps.getShellReadyDelayMs());

        const env: string[] = [
          `PI_TEAM_RUN_DIR=${shellEscape(currentRunDir)}`,
          `PI_TEAM_MEMBER_ID=${shellEscape(instanceId)}`,
          `PI_TEAM_MEMBER_NAME=${shellEscape(name)}`,
          `PI_TEAM_LEAD_PID=${process.pid}`,
          `PI_TEAM_SESSION_FILE=${shellEscape(sessionFile)}`,
          `PI_TEAM_WRITE=${write ? 1 : 0}`,
          `PI_TEAM_WORKTREE=${shellEscape(worktree ?? "")}`,
          `PI_DENY_TOOLS=${shellEscape([DENIED_FOR_MEMBERS, ...denied].join(","))}`,
        ];
        if (chain.fallbacks.length > 0) {
          env.push(`PI_SUBAGENT_MODEL_FALLBACKS=${shellEscape(chain.fallbacks.join(","))}`);
        }
        if (process.env.PI_CODING_AGENT_DIR) {
          env.push(`PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`);
        }
        const args = [
          "pi",
          "--session", shellEscape(sessionFile),
          "--name", shellEscape(`<team:${name}>`),
          "-e", shellEscape(MEMBER_ENTRY),
        ];
        if (chain.primary) {
          args.push("--model", shellEscape(defs.thinking ? `${chain.primary}:${defs.thinking}` : chain.primary));
        }
        args.push("--append-system-prompt", shellEscape(systemPath));
        if (allowlist) args.push("--tools", shellEscape(allowlist));
        args.push(params.approveProject ? "--approve" : "--no-approve");
        const command = `cd ${shellEscape(cwd)} && ${env.join(" ")} ${args.join(" ")}; echo '__TEAM_MEMBER_EXIT_'$?'__'`;
        sendLongCommand(surface, command, {
          scriptPath: join(memberRoot, "launch.sh"),
          scriptPreamble: `# Team member launch script for ${name} (${instanceId})`,
        });
        updateWidget();
      } catch (err) {
        record.ended = "lost";
        saveRoster();
        if (surface) {
          try {
            closeSurface(surface);
          } catch {}
        }
        cleanupMemberWorktree(record);
        updateWidget();
        return textResult(`Spawn failed: ${(err as Error).message}`);
      }

      const lines = [
        `Team member "${name}" (${params.agent}) started; it is working on its first task. ` +
          `Its reports arrive automatically as team messages — do not poll.`,
      ];
      if (write) lines.push(`Worktree: ${worktree}`, `Branch: ${branch}`);
      for (const w of warnings) lines.push(`Warning: ${w}`);
      return textResult(lines.join("\n"));
    },
  });

  pi.registerTool({
    name: "team_send",
    label: "Team Send",
    description: "Send a message to a live team member. Its reply arrives automatically as a team message.",
    promptSnippet: "Send a message to a live team member.",
    parameters: Type.Object({
      to: Type.String({ description: "Member name" }),
      message: Type.String(),
      urgent: Type.Optional(Type.Boolean({ description: "Deliver at the member's next step instead of after its current run" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      ctxRef = ctx;
      const to = params.to.trim();
      const m = findMember(to, false);
      if (!m || !runDir) return textResult(`No live team member named "${to}".`);
      const state = readStatus(m)?.state;
      if (state === "stopped" || state === "left") return textResult(`Member "${to}" is no longer running.`);
      try {
        const id = newMessageId();
        const prepared = prepareBody(spillDir(runDir), id, params.message);
        writeMessage(memberInbox(runDir, m.instanceId), {
          id,
          ts: Date.now(),
          from: "lead",
          to,
          kind: "message",
          body: prepared.body,
          spillPath: prepared.spillPath,
          urgent: params.urgent,
        });
      } catch (err) {
        return textResult(`Could not send the message: ${(err as Error).message}`);
      }
      return textResult(`Sent to ${to}. Its reply arrives automatically.`);
    },
  });

  pi.registerTool({
    name: "team_list",
    label: "Team List",
    description: "List team members with their state, agent, branch and last update.",
    promptSnippet: "List team members and their state.",
    parameters: Type.Object({}),
    async execute() {
      if (!roster || roster.members.length === 0) return textResult("No team members.");
      const lines = roster.members.map((m) => {
        const status = readStatus(m);
        const state = m.ended ?? status?.state ?? "starting";
        const age = status ? `${Math.max(0, Math.round((Date.now() - status.updatedAt) / 1000))}s ago` : "n/a";
        let line = `${m.name} | ${state} | ${m.agent} | write: ${m.write ? "yes" : "no"} | ${m.branch ?? "-"} | updated ${age}`;
        if (status?.lastError) line += ` | error: ${status.lastError}`;
        return line;
      });
      return textResult(lines.join("\n"));
    },
  });

  pi.registerTool({
    name: "team_interrupt",
    label: "Team Interrupt",
    description: "Abort a member's current turn (like pressing Escape in its pane). The member stays alive.",
    promptSnippet: "Abort a team member's current turn.",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params) {
      const m = findMember(params.name.trim(), false);
      if (!m || !runDir) return textResult(`No live team member named "${params.name}".`);
      try {
        writeControl(memberControl(runDir, m.instanceId), "interrupt");
      } catch (err) {
        return textResult(`Could not interrupt: ${(err as Error).message}`);
      }
      return textResult(`Interrupt requested for ${m.name}.`);
    },
  });

  pi.registerTool({
    name: "team_stop",
    label: "Team Stop",
    description: "Stop a team member after its current step. Its pane closes; a write member's worktree is removed only when nothing would be lost.",
    promptSnippet: "Stop a team member.",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params) {
      const m = findMember(params.name.trim(), false);
      if (!m || !runDir) return textResult(`No live team member named "${params.name}".`);
      try {
        writeControl(memberControl(runDir, m.instanceId), "stop");
      } catch (err) {
        return textResult(`Could not stop: ${(err as Error).message}`);
      }
      stopDeadlines.set(m.instanceId, Date.now() + STOP_TIMEOUT_MS);
      return textResult(`Stop requested for ${m.name}; it exits after its current step.`);
    },
  });

  pi.registerTool({
    name: "team_integrate",
    label: "Team Integrate",
    description:
      "Apply a write member's committed changes to the main working tree (unstaged). Conflicts leave the tree untouched.",
    promptSnippet: "Apply a write member's committed changes to the main working tree.",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params) {
      const name = params.name.trim();
      const m = findMember(name, true);
      if (!m || !m.write || !m.repoTop || !m.branch) return textResult(`${name} is not a write member.`);
      try {
        const dirty = !!m.worktree && existsSync(m.worktree) && !isWorktreeClean(m.worktree, m.links);
        const result = integrateBranch(m.repoTop, m.lastIntegrated ?? m.base!, m.branch);
        let text: string;
        if (result.status === "empty") {
          text = `Nothing new to integrate from ${name}.`;
        } else if (result.status === "applied") {
          m.lastIntegrated = result.head;
          saveRoster();
          text =
            `Applied ${result.files.length} file(s) from ${name} to the working tree (not staged):\n` +
            result.files.join("\n");
        } else {
          text =
            `Integration of ${name} failed; nothing was changed. Conflicting patch:\n${result.reason}\n` +
            `Files in the patch:\n${result.files.join("\n")}\n` +
            `Resolve by asking ${name} to adjust, or apply the changes manually.`;
        }
        if (dirty) text += `\nNote: ${name} has uncommitted changes that were not included.`;
        if (m.ended && (result.status === "applied" || result.status === "empty")) {
          const cleanup = cleanupMemberWorktree(m);
          const kept = keptWorktreeNote(m, cleanup);
          text += cleanup === "removed" ? `\nWorktree of ${name} removed.` : kept ? `\n${kept}` : "";
        }
        return textResult(text);
      } catch (err) {
        if (err instanceof GitError) return textResult(`git error: ${err.message}`);
        return textResult(`Integration failed: ${(err as Error).message}`);
      }
    },
  });

  pi.registerTool({
    name: "team_sync",
    label: "Team Sync",
    description:
      "Reset an idle, fully integrated write member's worktree to the current main working tree, so it sees changes integrated from other members.",
    promptSnippet: "Reset an idle write member's worktree to the current main working tree.",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params) {
      const name = params.name.trim();
      const m = findMember(name, false);
      if (!m || !m.write || !m.worktree || !m.repoTop || !m.branch || !run || !runDir) {
        return textResult(`${name} must be an idle write member.`);
      }
      if (readStatus(m)?.state !== "idle") return textResult(`${name} must be an idle write member.`);
      try {
        if (!isWorktreeClean(m.worktree, m.links)) {
          return textResult(`${name} has uncommitted changes; ask it to commit first.`);
        }
        if (revParse(m.branch, m.repoTop) !== (m.lastIntegrated ?? m.base)) {
          return textResult(`${name} has commits not yet integrated; run team_integrate first.`);
        }
        const snapshot = createSnapshot(m.repoTop, `pi-team sync ${run.runId} ${m.name}`);
        resetWorktree(m.worktree, snapshot);
        m.base = snapshot;
        m.lastIntegrated = undefined;
        saveRoster();
        const id = newMessageId();
        writeMessage(memberInbox(runDir, m.instanceId), {
          id,
          ts: Date.now(),
          from: "lead",
          to: name,
          kind: "message",
          body: `Your worktree was reset to the lead's current working tree (commit ${snapshot.slice(0, 12)}). Continue from there.`,
        });
        return textResult(`Synced ${name} to the current working tree.`);
      } catch (err) {
        if (err instanceof GitError) return textResult(`git error: ${err.message}`);
        return textResult(`Sync failed: ${(err as Error).message}`);
      }
    },
  });
}
