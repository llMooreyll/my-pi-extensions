// pi-board extension body: write/edit override and plan validation, change log, prompt rules, widget, pane, socket.
// Spec: ../DESIGN.md §2-§7, §8.1, §8.4, §9.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type ChangeLog,
	createTurnCounter,
	mergedEvent,
	openChangeLog,
	readLeadState,
} from "./changes.ts";
import { type DiffResult, normalizePatch, truncateDiff, unifiedDiff } from "./diff.ts";
import {
	BASH_BOARD_REASON,
	MEMBER_BOARD_REASON,
	type PendingPlanWrites,
	bashWritesBoard,
	checkMessage,
	checkPlanWrite,
	checkTask,
	currentPlanFiles,
	projectContent,
} from "./guard.ts";
import { createPaneController, inTmux, type PaneController } from "./pane-launcher.ts";
import {
	type ActorInfo,
	boardRootFor,
	currentActor,
	isEnabled,
	isPlanPath,
	type ProjectInfo,
	readText,
	resolveProject,
	resolveTarget,
	toRepoPath,
} from "./project.ts";
import { MEMBER_RULES_TEXT, REMINDER_TEXT, RULES_SECTION, RULES_TEXT } from "./prompt.ts";
import { BOARD_DIR, BUILTIN_SECTIONS } from "./shared/parse.ts";
import type { ChangeEvent } from "./shared/types.ts";
import { type QuoteServer, socketPathFor, startQuoteServer } from "./socket.ts";
import { registerBoardTools } from "./tools.ts";
import { agentLabel, backgroundService, boardStats, installWidget, type WidgetController } from "./widget.ts";

/** write targets larger than this are logged without a diff. */
const MAX_DIFF_SOURCE_BYTES = 4 * 1024 * 1024;

interface Services {
	log: ChangeLog;
	countTurn: (leadSession: string, turn: number) => number;
	widget?: WidgetController;
	socket?: QuoteServer;
	pane?: PaneController;
}

export default function piBoard(pi: ExtensionAPI) {
	const actor: ActorInfo = currentActor();
	let project: ProjectInfo = resolveProject(process.cwd());
	let enabled = false;
	let toolsRegistered = false;
	let services: Services | undefined;
	let latestCtx: ExtensionContext | undefined;

	/** Plan writes validated in tool_call whose execution has not finished (see guard.currentPlanFiles). */
	const pending: PendingPlanWrites = new Map();
	/** write targets as they were before execution, for the change log diff. */
	const snapshots = new Map<string, { existed: boolean; before: string | undefined; skipDiff: boolean }>();
	const turnState = { planTouched: false, reminded: false };

	// ---- enabling (DESIGN §2) ----

	const syncProject = (cwd: string): void => {
		project = resolveProject(cwd);
		enabled = isEnabled(project);
		if (enabled && !toolsRegistered) {
			registerBoardTools(pi, cwd);
			toolsRegistered = true;
		}
	};
	syncProject(process.cwd());

	// ---- services (change log, widget, socket, pane) ----

	const stopServices = (): void => {
		if (!services) return;
		services.widget?.dispose();
		services.socket?.close();
		services.pane?.close();
		services = undefined;
	};

	const openPane = (): boolean => {
		if (!services?.pane) return false;
		return services.pane.open({
			root: project.mainRoot,
			session: services.log.session,
			socket: socketPathFor(services.log.session),
		});
	};

	const startServices = (ctx: ExtensionContext): void => {
		stopServices();
		if (!enabled) return;
		const session = ctx.sessionManager.getSessionId();
		const log = openChangeLog(project.mainRoot, session, project.isGit ? project.mainRoot : undefined);
		const countTurn = createTurnCounter(project.mainRoot);
		services = { log, countTurn };
		if (!actor.isLead || !ctx.hasUI) return;

		const boardRoot = boardRootFor(project, actor);
		services.widget = installWidget(ctx, () => boardStats(boardRoot, countTurn(log.session, log.turn())));

		if (ctx.mode !== "tui") return;
		const mine = services;
		void startQuoteServer(socketPathFor(session), (text) => {
			try {
				latestCtx?.ui.pasteToEditor(text);
			} catch (error) {
				warn(latestCtx, `could not paste the quote into the editor: ${(error as Error).message}`);
			}
		}).then((server) => {
			if (services !== mine) {
				server?.close();
				return;
			}
			if (!server) warn(ctx, "could not create the quote socket, so quoting from the pane will not work");
			else mine.socket = server;
		});
		services.pane = createPaneController();
		if (inTmux()) openPane();
	};

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		syncProject(ctx.cwd);
		startServices(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopServices();
	});

	// ---- prompt rules, turns (DESIGN §6, §7) ----

	pi.on("before_agent_start", async (event, ctx) => {
		latestCtx = ctx;
		if (!enabled) {
			// docs/board/ may have been created after startup (by the user or a migration).
			syncProject(ctx.cwd);
			if (!enabled) return;
			startServices(ctx);
		}
		const sections = (event.systemPromptOptions.sections ??= {});
		sections[RULES_SECTION] = actor.isLead ? RULES_TEXT : MEMBER_RULES_TEXT;

		if (event.messageType !== "user") return;
		turnState.planTouched = false;
		turnState.reminded = false;
		if (!actor.isLead || !services) return;
		try {
			services.log.nextTurn(event.prompt);
			services.log.writeLeadState();
			services.widget?.refresh();
		} catch (error) {
			warn(ctx, `could not record the turn: ${(error as Error).message}`);
		}
	});

	pi.on("agent_end", async () => {
		// Nothing of this run is in flight any more; drop whatever tool_execution_end did not clean up.
		pending.clear();
		snapshots.clear();
		services?.widget?.refresh();
	});

	// ---- tool_call: arguments, plan validation, bash (DESIGN §4, §5) ----

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return;
		const input = event.input as Record<string, unknown>;

		if (event.toolName === "bash") {
			try {
				return typeof input.command === "string" && bashWritesBoard(input.command)
					? { block: true, reason: BASH_BOARD_REASON }
					: undefined;
			} catch (error) {
				warn(ctx, `bash check skipped: ${(error as Error).message}`);
				return undefined;
			}
		}
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		try {
			return checkWriteOrEdit(event.toolCallId, event.toolName as "write" | "edit", input, ctx);
		} catch (error) {
			pending.delete(event.toolCallId);
			// Fail closed for the plan documents; a bug must not make every other write fail.
			if (targetsPlan(input, ctx)) {
				return {
					block: true,
					reason: `pi-board: the ${BOARD_DIR}/ check failed internally (${(error as Error).message}), so this change to a plan document was not applied. Retry; if it keeps failing, tell the user.`,
				};
			}
			warn(ctx, `pi-board check skipped: ${(error as Error).message}`);
			return undefined;
		}
	});

	const targetsPlan = (input: Record<string, unknown>, ctx: ExtensionContext): boolean => {
		try {
			const path = typeof input.path === "string" ? input.path : "";
			if (path === "") return false;
			const abs = resolveTarget(path, ctx.cwd);
			return isPlanPath(toRepoPath(abs, project.root)) || abs.startsWith(`${join(project.mainRoot, BOARD_DIR)}/`);
		} catch {
			return false;
		}
	};

	const checkWriteOrEdit = (
		toolCallId: string,
		toolName: "write" | "edit",
		input: Record<string, unknown>,
		ctx: ExtensionContext,
	): { block: true; reason: string } | undefined => {
		const path = typeof input.path === "string" ? input.path : "";
		if (path === "") return undefined;
		const abs = resolveTarget(path, ctx.cwd);
		const repoPath = toRepoPath(abs, project.root);
		const inPlan = targetsPlan(input, ctx);

		if (inPlan && !actor.isLead) return { block: true, reason: MEMBER_BOARD_REASON };

		const badMessage = checkMessage(input);
		if (badMessage) return { block: true, reason: badMessage };

		const boardRoot = boardRootFor(project, actor);
		let planFiles = currentPlanFiles(boardRoot, pending);

		if (inPlan) {
			turnState.planTouched = true;
			const base = latestPendingContent(abs) ?? readText(abs);
			const content = projectContent(toolName, input, base);
			if (typeof content === "object") return { block: true, reason: content.error };
			if (content !== undefined) {
				const result = checkPlanWrite({ root: project.root, repoPath, content, pending });
				if (result.reason) return { block: true, reason: result.reason };
				planFiles = result.projected;
				pending.set(toolCallId, { abs, repoPath, content });
			}
		}

		const badTask = checkTask(input, planFiles);
		if (badTask) {
			pending.delete(toolCallId);
			return { block: true, reason: badTask };
		}

		if (toolName === "write") snapshots.set(toolCallId, snapshotOf(abs));
		return undefined;
	};

	const latestPendingContent = (abs: string): string | undefined => {
		let found: string | undefined;
		for (const p of pending.values()) if (p.abs === abs) found = p.content;
		return found;
	};

	const snapshotOf = (abs: string) => {
		try {
			const stat = statSync(abs);
			if (!stat.isFile()) return { existed: true, before: undefined, skipDiff: true };
			if (stat.size > MAX_DIFF_SOURCE_BYTES) return { existed: true, before: undefined, skipDiff: true };
			return { existed: true, before: readFileSync(abs, "utf8"), skipDiff: false };
		} catch {
			return { existed: false, before: undefined, skipDiff: false };
		}
	};

	pi.on("tool_execution_end", async (event) => {
		pending.delete(event.toolCallId);
		snapshots.delete(event.toolCallId);
	});

	// ---- tool_result: change log, reminder, merged events (DESIGN §6, §7) ----

	pi.on("tool_result", async (event, ctx) => {
		// The tool finished: the disk now has its effect, so it no longer needs an in-memory overlay.
		pending.delete(event.toolCallId);
		if (!enabled || !services) return;
		if (event.toolName === "team_integrate") {
			recordMerge(event, ctx);
			return;
		}
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		if (event.isError) return;

		const input = event.input;
		const path = typeof input.path === "string" ? input.path : "";
		if (path === "") return;
		const repoPath = toRepoPath(resolveTarget(path, ctx.cwd), project.root);
		const category = isPlanPath(repoPath) ? "plan" : "code";

		try {
			recordChange(event.toolName as "write" | "edit", event.toolCallId, input, event.details, repoPath, category);
		} catch (error) {
			warn(ctx, `could not record the change: ${(error as Error).message}`);
		}
		services.widget?.refresh();

		if (actor.isLead && category === "code" && !turnState.planTouched && !turnState.reminded) {
			turnState.reminded = true;
			return { content: [...event.content, { type: "text" as const, text: REMINDER_TEXT }] };
		}
		return undefined;
	});

	const recordChange = (
		tool: "write" | "edit",
		toolCallId: string,
		input: Record<string, unknown>,
		details: unknown,
		repoPath: string,
		category: "plan" | "code",
	): void => {
		if (!services) return;
		const { log } = services;

		let diff: DiffResult = { diff: "", added: 0, removed: 0 };
		let created: boolean | undefined;
		let diffMissing = false;
		if (tool === "write") {
			const snapshot = snapshots.get(toolCallId);
			created = snapshot ? !snapshot.existed : undefined;
			if (snapshot && !snapshot.skipDiff && typeof input.content === "string") {
				diff = unifiedDiff(repoPath, snapshot.before, input.content);
			} else {
				diffMissing = true;
			}
		} else {
			const patch = (details as { patch?: unknown } | undefined)?.patch;
			if (typeof patch === "string") diff = normalizePatch(patch, repoPath);
			else diffMissing = true;
		}
		const cut = truncateDiff(diff.diff);

		const lead = actor.isLead ? undefined : readLeadState(project.mainRoot);
		const task = typeof input.task === "string" && input.task.trim() !== "" ? input.task.trim() : undefined;
		const event: ChangeEvent = {
			type: "change",
			id: log.nextChangeId(),
			time: new Date().toISOString(),
			session: log.session,
			actor: actor.actor,
			memberId: actor.memberId,
			branch: actor.branch,
			turn: actor.isLead ? log.turn() : (lead?.turn ?? 0),
			leadSession: actor.isLead ? log.session : (lead?.session ?? ""),
			tool,
			path: repoPath,
			message: typeof input.message === "string" ? input.message.trim() : "",
			task,
			category,
			created,
			added: diff.added,
			removed: diff.removed,
			diff: cut.diff,
			truncated: cut.truncated || diffMissing ? true : undefined,
			status: actor.memberId ? "unmerged" : undefined,
		};
		log.append(event);
	};

	const recordMerge = (
		event: { input: Record<string, unknown>; content: Array<{ type: string; text?: string }>; details?: unknown; isError: boolean },
		ctx: ExtensionContext,
	): void => {
		if (!actor.isLead || !services || event.isError) return;
		const details = event.details as { ok?: boolean; memberId?: string; instanceId?: string } | undefined;
		if (details?.ok === false) return;
		const text = event.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
		if (!/^Applied \d+ file/.test(text)) return;

		const name = typeof event.input.name === "string" ? event.input.name.trim() : "";
		const memberId = details?.memberId ?? details?.instanceId ?? lookupMemberId(ctx, name);
		if (!memberId) {
			warn(ctx, `could not tell which team member "${name}" is; its changes stay marked unmerged`);
			return;
		}
		services.log.append(mergedEvent(services.log.session, memberId));
		services.widget?.refresh();
	};

	// ---- /board and Alt+J (DESIGN §2, §8.1, §9) ----

	pi.registerCommand("board", {
		description: "Toggle the board pane; `/board init` creates docs/board/ in this project",
		getArgumentCompletions: (prefix) => ("init".startsWith(prefix) ? [{ value: "init", label: "init" }] : null),
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const sub = args.trim();
			if (sub === "init") return initBoard(ctx);
			if (sub !== "") {
				ctx.ui.notify("Usage: /board (toggle the pane) or /board init", "warning");
				return;
			}
			togglePane(ctx);
		},
	});

	const initBoard = async (ctx: ExtensionCommandContext): Promise<void> => {
		const root = resolveProject(ctx.cwd).root;
		const dir = join(root, BOARD_DIR);
		const existed = existsSync(dir);
		if (!existed) {
			mkdirSync(dir, { recursive: true });
			for (const section of BUILTIN_SECTIONS) writeFileSync(join(root, section.file), "", { flag: "wx" });
		}
		const wasEnabled = enabled;
		syncProject(ctx.cwd);
		if (!wasEnabled) startServices(ctx);
		ctx.ui.notify(
			existed ? `${BOARD_DIR}/ already exists in ${root}` : `Created ${BOARD_DIR}/ (tasks.md, decisions.md, conflicts.md) in ${root}`,
			"info",
		);
	};

	const togglePane = (ctx: ExtensionCommandContext): void => {
		if (!enabled) {
			ctx.ui.notify(`No ${BOARD_DIR}/ in this project; run /board init first`, "warning");
			return;
		}
		if (!actor.isLead) {
			ctx.ui.notify("The board pane belongs to the main agent", "warning");
			return;
		}
		if (!inTmux() || ctx.mode !== "tui" || !services?.pane) {
			ctx.ui.notify("The board pane needs the interactive UI inside tmux", "warning");
			return;
		}
		if (services.pane.isOpen()) {
			services.pane.close();
			return;
		}
		if (!openPane()) ctx.ui.notify("tmux could not open the board pane", "error");
	};

	if (actor.isLead) {
		pi.registerShortcut("alt+j", {
			description: "Jump to a background subagent or team member",
			handler: async (ctx) => {
				const service = backgroundService();
				const agents = service?.list() ?? [];
				if (!service || agents.length === 0) {
					ctx.ui.notify("No background agents", "info");
					return;
				}
				const labels = agents.map((a, i) => {
					const label = agentLabel(a);
					return agents.some((o, j) => j !== i && agentLabel(o) === label) ? `${label} (${a.id})` : label;
				});
				const choice = await ctx.ui.select("Jump to background agent", labels);
				const picked = choice === undefined ? undefined : agents[labels.indexOf(choice)];
				if (!picked) return;
				if (!(await service.focus(picked.id))) ctx.ui.notify(`Could not focus ${agentLabel(picked)}`, "warning");
			},
		});
	}

	function warn(ctx: ExtensionContext | undefined, message: string): void {
		try {
			if (ctx?.hasUI) ctx.ui.notify(`pi-board: ${message}`, "warning");
		} catch {
			// context of a replaced session
		}
	}
}

/**
 * team_integrate reports only the member's name; the roster in the lead's artifact directory maps it to the instance
 * id that member processes put into their PI_TEAM_MEMBER_ID.
 */
function lookupMemberId(ctx: ExtensionContext, name: string): string | undefined {
	if (name === "") return undefined;
	const sm = ctx.sessionManager;
	const runs = join(sm.getSessionDir(), "artifacts", sm.getSessionId(), "team", "runs");
	if (!existsSync(runs)) return undefined;
	let best: { id: string; spawnedAt: number } | undefined;
	for (const run of readdirSync(runs)) {
		const info = readJson<{ leadPid?: number }>(join(runs, run, "run.json"));
		if (info?.leadPid !== process.pid) continue;
		const roster = readJson<{ members?: Array<{ instanceId: string; name: string; spawnedAt: number }> }>(
			join(runs, run, "members.json"),
		);
		for (const m of roster?.members ?? []) {
			if (m.name === name && (!best || m.spawnedAt > best.spawnedAt)) best = { id: m.instanceId, spawnedAt: m.spawnedAt };
		}
	}
	return best?.id;
}

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}
