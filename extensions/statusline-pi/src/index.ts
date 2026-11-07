import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile, execFileSync } from "node:child_process";
import {
	addAssistantMessageCost,
	aggregateSessionCostFromContext,
	createEmptySessionCostState,
	formatCostSection,
	type SessionCostState,
} from "./cost.js";
import { StatusBorderEditor, type BorderSegments } from "./editor.js";
import { ResponseSpeedTracker, type SpeedSnapshot } from "./speed.js";
import {
	createCpuSampler,
	formatSystemSection,
	refreshSystemUsage,
	type CpuSampler,
	type SystemUsageSnapshot,
} from "./system.js";

interface GitInfo {
	branch?: string;
	changedFiles: number;
	prNumber?: number;
}

const GIT_REFRESH_MS = 5_000;
const PR_REFRESH_MS = 60_000;
const SPEED_RENDER_THROTTLE_MS = 250;
const NARROW_BRANCH_WIDTH_RATIO = 0.55;
const MIN_NARROW_BRANCH_WIDTH = 8;

interface ModelIdentity {
	provider?: string;
	id?: string;
}

export const GPT_CONTEXT_PRICE_BREAKPOINT_TOKENS = 272_000;

export function isGptModel(model: ModelIdentity | undefined): boolean {
	const provider = model?.provider?.toLowerCase();
	const modelId = model?.id?.replace(/^models\//, "").toLowerCase();

	return (provider === "openai" || provider === "openai-codex") && modelId?.startsWith("gpt-") === true;
}

export function shouldNotifyGptContextBreakpoint(
	model: ModelIdentity | undefined,
	usedTokens: number,
	notified: boolean,
): boolean {
	return !notified && isGptModel(model) && Number.isFinite(usedTokens) && usedTokens >= GPT_CONTEXT_PRICE_BREAKPOINT_TOKENS;
}

export function formatGptContextBreakpointNotice(): string {
	return "GPT context reached 272,000 tokens — OpenAI pricing breakpoint: the same token costs double.";
}

export default function statuslinePiExtension(pi: ExtensionAPI) {
	let enabled = true;
	let gitInfo: GitInfo = { changedFiles: 0 };
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let lastGitRefresh = 0;
	let lastPrRefresh = 0;
	let lastPrBranch: string | undefined;
	let githubRemoteCwd: string | undefined;
	let githubRemote = false;
	let prLookupInFlight = false;
	let renderRequested: (() => void) | undefined;
	const speed = new ResponseSpeedTracker();
	let lastSpeedRender = 0;
	let sessionCost = createEmptySessionCostState();
	let cpuSampler: CpuSampler = createCpuSampler();
	let systemUsage: SystemUsageSnapshot = refreshSystemUsage(cpuSampler);
	let notifiedGptContextBreakpoint = false;

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		mount(ctx);
		maybeNotifyGptContextBreakpoint(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		renderRequested = undefined;
		speed.reset();
		lastSpeedRender = 0;
		sessionCost = createEmptySessionCostState();
		cpuSampler = createCpuSampler();
		systemUsage = refreshSystemUsage(cpuSampler);
		notifiedGptContextBreakpoint = false;
	});

	pi.on("model_select", async (_event, ctx) => {
		// Samples are kept per model, so switching back restores that model's rate.
		speed.setModel(getModelKey(ctx));
		sessionCost = aggregateSessionCostFromContext(ctx);
		notifiedGptContextBreakpoint = false;
		maybeNotifyGptContextBreakpoint(ctx);
		requestRender();
	});
	pi.on("thinking_level_select", async (_event, _ctx) => {
		requestRender();
	});
	pi.on("before_provider_request", async () => {
		speed.markRequest(Date.now());
	});
	pi.on("message_start", async (event, ctx) => {
		if (event.message.role !== "assistant") return;

		maybeNotifyGptContextBreakpoint(ctx);
		speed.setModel(getModelKey(ctx));
		speed.start(Date.now());
		requestRender();
	});
	pi.on("message_update", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		maybeNotifyGptContextBreakpoint(ctx);

		const streamEvent = event.assistantMessageEvent;
		if (streamEvent.type === "text_delta") speed.delta("text", streamEvent.delta, Date.now());
		else if (streamEvent.type === "thinking_delta") speed.delta("thinking", streamEvent.delta, Date.now());
		else if (streamEvent.type === "toolcall_delta") speed.delta("toolcall", streamEvent.delta, Date.now());
		else return;

		requestSpeedRender();
	});
	pi.on("message_end", async (event, ctx) => {
		maybeNotifyGptContextBreakpoint(ctx);
		if (event.message.role !== "assistant") {
			requestRender();
			return;
		}

		const stopReason = event.message.stopReason;
		if (stopReason === "error" || stopReason === "aborted") speed.cancel();
		else speed.finish(event.message.usage);
		sessionCost = addAssistantMessageCost(sessionCost, event.message.usage, ctx.model);
		requestRender();
	});
	pi.on("tool_result", async (_event, ctx) => {
		maybeNotifyGptContextBreakpoint(ctx);
		refreshGit(ctx.cwd, { forceGit: true });
		requestRender();
	});

	pi.registerCommand("statusline-pi", {
		description: "Toggle the statusline footer and the status border editor",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			enabled = !enabled;

			if (enabled) {
				mount(ctx);
				ctx.ui.notify("statusline-pi enabled", "info");
			} else {
				unmount(ctx);
				ctx.ui.notify("statusline-pi disabled", "info");
			}
		},
	});

	pi.registerCommand("statusline-refresh", {
		description: "Refresh statusline-pi git and PR data",
		handler: async (_args, ctx) => {
			refreshGit(ctx.cwd, { forceGit: true, forcePr: true });
			requestRender();
			ctx.ui.notify("statusline-pi refreshed", "info");
		},
	});

	function mount(ctx: ExtensionContext): void {
		if (!enabled || !ctx.hasUI) return;

		sessionCost = aggregateSessionCostFromContext(ctx);
		cpuSampler = createCpuSampler();
		systemUsage = refreshSystemUsage(cpuSampler);
		refreshGit(ctx.cwd, { forceGit: true, forcePr: true });
		speed.setModel(getModelKey(ctx));

		// Model, context and speed live on the editor border; the footer keeps the rest.
		const borderSource = {
			top: (width: number): BorderSegments => formatTopBorder(ctx, pi, width),
			bottom: (width: number): BorderSegments => formatBottomBorder(ctx, speed.snapshot(), width),
		};
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) => new StatusBorderEditor(tui, theme, keybindings, borderSource),
		);

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribeBranch = footerData.onBranchChange(() => {
				refreshGit(ctx.cwd, { forceGit: true, forcePr: true });
				tui.requestRender();
			});

			renderRequested = () => tui.requestRender();

			return {
				dispose() {
					unsubscribeBranch();
				},
				invalidate() {
					tui.requestRender();
				},
				render(width: number): string[] {
					const cost = formatCostSection(theme, sessionCost, ctx);
					const dir = ctx.cwd;
					const branch = gitInfo.branch ?? footerData.getGitBranch?.() ?? "no-git";
					const changed = gitInfo.changedFiles;
					const separator = theme.fg("borderMuted", " │ ");

					const extensionStatuses = Array.from(footerData.getExtensionStatuses?.().values() ?? []).map((status) =>
						truncateToWidth(status, width),
					);

					return formatResponsiveStatusline(
						{
							dir: theme.fg("mdLink", dir),
							git: formatGitSection(theme, branch, changed, gitInfo.prNumber),
							compactGit: formatGitSection(
								theme,
								branch,
								changed,
								gitInfo.prNumber,
								getNarrowBranchWidth(width),
							),
							context: "",
							speed: "",
							cost,
							sys: formatSystemSection(theme, systemUsage),
							model: "",
						},
						separator,
						width,
						extensionStatuses,
					);

				},
			};
		});

		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(() => {
			refreshGit(ctx.cwd);
			systemUsage = refreshSystemUsage(cpuSampler);
			requestRender();
		}, GIT_REFRESH_MS);
	}

	function unmount(ctx: ExtensionContext): void {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		renderRequested = undefined;
		notifiedGptContextBreakpoint = false;
		ctx.ui.setFooter(undefined);
		ctx.ui.setEditorComponent(undefined);
	}

	function maybeNotifyGptContextBreakpoint(ctx: ExtensionContext): void {
		if (!enabled || !ctx.hasUI) return;

		const { usedTokens } = getUsage(ctx);
		if (!isGptModel(ctx.model) || usedTokens < GPT_CONTEXT_PRICE_BREAKPOINT_TOKENS) {
			notifiedGptContextBreakpoint = false;
			return;
		}

		if (!shouldNotifyGptContextBreakpoint(ctx.model, usedTokens, notifiedGptContextBreakpoint)) return;

		notifiedGptContextBreakpoint = true;
		ctx.ui.notify(formatGptContextBreakpointNotice(), "warning");
	}

	function requestRender(): void {
		renderRequested?.();
	}

	function requestSpeedRender(): void {
		const now = Date.now();
		if (now - lastSpeedRender < SPEED_RENDER_THROTTLE_MS) return;
		lastSpeedRender = now;
		requestRender();
	}

	function refreshGit(cwd: string, options: { forceGit?: boolean; forcePr?: boolean } = {}): void {
		const now = Date.now();
		if (!options.forceGit && now - lastGitRefresh < GIT_REFRESH_MS) return;
		lastGitRefresh = now;

		const previousBranch = gitInfo.branch;
		const branch = runGit(cwd, ["branch", "--show-current"]) || runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
		const porcelain = runGit(cwd, ["status", "--porcelain"]);
		const changedFiles = porcelain ? porcelain.split("\n").filter((line) => line.trim()).length : 0;

		gitInfo = {
			...gitInfo,
			branch: branch || undefined,
			changedFiles,
		};

		if (previousBranch !== gitInfo.branch) {
			lastPrBranch = undefined;
			lastPrRefresh = 0;
			gitInfo.prNumber = undefined;
		}

		refreshPr(cwd, options.forcePr);
	}

	function refreshPr(cwd: string, force = false): void {
		if (!gitInfo.branch) return;

		const now = Date.now();
		// Back off once this branch has been checked, even when the result was "no PR".
		// Keying the interval on prNumber alone retried the network call every 5s forever.
		const refreshInterval = lastPrBranch === gitInfo.branch ? PR_REFRESH_MS : GIT_REFRESH_MS;
		if (!force && lastPrBranch === gitInfo.branch && now - lastPrRefresh < refreshInterval) return;

		lastPrBranch = gitInfo.branch;
		lastPrRefresh = now;

		// gh reaches the GitHub API; without a GitHub remote the call cannot succeed,
		// so skip the round trip instead of paying for it on every refresh.
		if (!hasGitHubRemote(cwd)) {
			gitInfo.prNumber = undefined;
			return;
		}

		if (prLookupInFlight) return;
		prLookupInFlight = true;
		const branch = gitInfo.branch;

		// execFile, not execFileSync: this lookup talks to the GitHub API and would
		// otherwise block the event loop for about a second on every refresh.
		execFile("gh", ["pr", "view", "--json", "number", "--jq", ".number"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3_000,
		}, (error, stdout) => {
			prLookupInFlight = false;
			// Drop a result for a branch that is no longer checked out.
			if (gitInfo.branch !== branch) return;
			const number = Number(String(stdout).trim());
			gitInfo.prNumber = !error && Number.isFinite(number) && number > 0 ? number : undefined;
			requestRender();
		});
	}

	function hasGitHubRemote(cwd: string): boolean {
		if (githubRemoteCwd !== cwd) {
			githubRemoteCwd = cwd;
			githubRemote = /github\.com[:/]/.test(runGit(cwd, ["remote", "-v"]));
		}
		return githubRemote;
	}
}

function runGit(cwd: string, args: string[]): string {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
		}).trim();
	} catch {
		return "";
	}
}

function getUsage(ctx: ExtensionContext): {
	contextWindow: number;
	usedTokens: number;
	/** False when Pi has no token count yet (e.g. right after compaction). */
	known: boolean;
	usedRatio: number;
	remainingTokens: number;
	remainingPercent: number;
} {
	const contextWindow = ctx.model?.contextWindow ?? 0;
	const reportedTokens = ctx.getContextUsage?.()?.tokens;
	const usedTokens = reportedTokens ?? 0;
	const usedRatio = contextWindow > 0 ? Math.min(1, usedTokens / contextWindow) : 0;
	const remainingTokens = Math.max(0, contextWindow - usedTokens);
	const remainingPercent = contextWindow > 0 ? (remainingTokens / contextWindow) * 100 : 0;

	return {
		contextWindow,
		usedTokens,
		known: reportedTokens !== null && reportedTokens !== undefined,
		usedRatio,
		remainingTokens,
		remainingPercent,
	};
}

function getZone(contextUsageRatio: number, contextWindow: number): string {
	if (contextWindow >= 500_000) {
		// 1M-class model zones
		const used = contextWindow * contextUsageRatio;
		if (used < 150_000) return "Plan";
		if (used < 250_000) return "Code";
		if (used < 400_000) return "Dump";
		if (used < 450_000) return "ExDump";
		return "Dead";
	} else {
		// Standard model zones
		if (contextUsageRatio < 0.4) return "Plan";
		if (contextUsageRatio < 0.7) return "Code";
		if (contextUsageRatio < 0.75) return "Dump";
		if (contextUsageRatio < 0.8) return "ExDump";
		return "Dead";
	}
}

export interface StatuslineSegments {
	dir: string;
	git: string;
	compactGit: string;
	context: string;
	speed: string;
	cost: string;
	sys: string;
	model: string;
}

export function formatResponsiveStatusline(
	segments: StatuslineSegments,
	separator: string,
	width: number,
	extensionStatuses: string[] = [],
): string[] {
	const safeWidth = Math.max(1, width);
	const wideSegments = [segments.dir, segments.git, segments.cost, segments.sys, segments.context, segments.speed, segments.model]
		.filter(Boolean);
	const wideLine = wideSegments.join(separator);
	if (visibleWidth(wideLine) <= safeWidth && extensionStatuses.length === 0) return [wideLine];

	const narrowSegments = [
		segments.dir,
		segments.compactGit,
		segments.cost,
		segments.sys,
		segments.context,
		segments.speed,
		segments.model,
		...extensionStatuses,
	].filter(Boolean);
	return wrapStatuslineSegments(narrowSegments, separator, safeWidth);
}

function wrapStatuslineSegments(segments: string[], separator: string, width: number): string[] {
	const lines: string[] = [];
	let currentLine = "";

	for (const segment of segments) {
		const candidate = currentLine ? `${currentLine}${separator}${segment}` : segment;
		if (visibleWidth(candidate) <= width) {
			currentLine = candidate;
			continue;
		}

		if (currentLine) lines.push(currentLine);
		currentLine = truncateToWidth(segment, width);
	}

	if (currentLine) lines.push(currentLine);
	return lines;
}


export function getNarrowBranchWidth(width: number): number {
	return Math.max(MIN_NARROW_BRANCH_WIDTH, Math.floor(width * NARROW_BRANCH_WIDTH_RATIO));
}

export function truncatePlainTextToWidth(text: string, maxWidth: number, ellipsis = "…"): string {
	if (visibleWidth(text) <= maxWidth) return text;

	const targetWidth = Math.max(0, maxWidth - visibleWidth(ellipsis));
	let output = "";
	for (const character of text) {
		if (visibleWidth(output + character) > targetWidth) break;
		output += character;
	}
	return `${output}${ellipsis}`;
}

export function formatGitSection(
	theme: ExtensionContext["ui"]["theme"],
	branch: string,
	changedFiles: number,
	prNumber?: number,
	maxBranchWidth?: number,
): string {
	const branchDisplay = maxBranchWidth === undefined ? branch : truncatePlainTextToWidth(branch, maxBranchWidth);
	const branchText = theme.fg("mdLink", branchDisplay);
	const changesColor = changedFiles > 0 ? "warning" : "dim";
	const changesText = theme.fg(changesColor, `[${changedFiles}]`);
	const prText = prNumber ? ` ${theme.fg("mdHeading", `PR #${prNumber}`)}` : "";
	return `${branchText} ${changesText}${prText}`;
}

const CONTEXT_BAR_CELLS = 10;
const NARROW_CONTEXT_BAR_CELLS = 5;
const NARROW_BORDER_WIDTH = 72;

function getModelKey(ctx: ExtensionContext): string {
	return `${ctx.model?.provider ?? ""}/${ctx.model?.id ?? ""}`;
}

function formatTopBorder(ctx: ExtensionContext, pi: ExtensionAPI, width: number): BorderSegments {
	const theme = ctx.ui.theme;
	const narrow = width < NARROW_BORDER_WIDTH;
	// Context sits top-right; the model label gives way first when space runs out.
	const context = ` ${formatContextBar(theme, getUsage(ctx), narrow)} `;
	const provider = ctx.model?.provider;
	const modelId = ctx.model?.id ? ctx.model.id.replace(/^models\//, "") : "no-model";
	const thinking = pi.getThinkingLevel?.() ?? "off";
	const thinkingText = thinking === "off" ? (ctx.model?.reasoning ? "think off" : "") : `think ${thinking}`;
	const thinkingWidth = thinkingText ? visibleWidth(thinkingText) + 3 : 0;
	const labelWidth = Math.max(8, width - visibleWidth(context) - thinkingWidth - 6);
	const label = truncateModelLabel(provider ? `${provider}/${modelId}` : modelId, labelWidth);
	const thinkingPart = thinkingText ? `${theme.fg("dim", " · ")}${theme.fg("muted", thinkingText)}` : "";
	return {
		left: ` ${theme.fg("accent", label)}${thinkingPart} `,
		right: context,
	};
}

function formatBottomBorder(ctx: ExtensionContext, speed: SpeedSnapshot, width: number): BorderSegments {
	const theme = ctx.ui.theme;
	return {
		left: "",
		right: ` ${formatSpeed(theme, speed, width < NARROW_BORDER_WIDTH)} `,
	};
}

/** Keeps the model id readable by dropping the provider prefix first. */
function truncateModelLabel(label: string, maxWidth: number): string {
	if (visibleWidth(label) <= maxWidth) return label;
	const slash = label.indexOf("/");
	const withoutProvider = slash >= 0 ? label.slice(slash + 1) : label;
	return truncatePlainTextToWidth(withoutProvider, maxWidth);
}

function formatContextBar(
	theme: ExtensionContext["ui"]["theme"],
	usage: ReturnType<typeof getUsage>,
	narrow = false,
): string {
	const cells = narrow ? NARROW_CONTEXT_BAR_CELLS : CONTEXT_BAR_CELLS;
	if (usage.contextWindow <= 0) return theme.fg("dim", `${"▱".repeat(cells)} ctx ?`);
	// Right after compaction Pi reports no token count until the next response.
	if (!usage.known) {
		return theme.fg("dim", `${"▱".repeat(cells)} ?${narrow ? "" : `/${formatTokenCount(usage.contextWindow)}`}`);
	}

	const zone = getZone(usage.usedRatio, usage.contextWindow);
	const color = getZoneColor(zone);
	const filled = Math.min(cells, Math.round(usage.usedRatio * cells));
	const bar = theme.fg(color, "▰".repeat(filled)) + theme.fg("dim", "▱".repeat(cells - filled));
	const percent = theme.fg(color, `${Math.round(usage.usedRatio * 100)}%`);
	if (narrow) return `${bar} ${percent}`;

	const amounts = theme.fg("muted", `${formatTokenCount(usage.usedTokens)}/${formatTokenCount(usage.contextWindow)}`);
	return `${bar} ${percent} ${amounts} ${theme.fg(color, `${getZoneIcon(zone)} ${zone}`)}`;
}

function formatSpeed(theme: ExtensionContext["ui"]["theme"], speed: SpeedSnapshot, narrow = false): string {
	const rate = speed.tokensPerSecond;
	const rateText =
		rate === undefined
			? theme.fg("dim", "-- tok/s")
			: theme.fg(getSpeedColor(rate), `${formatTokensPerSecond(rate)}${speed.live ? "~" : ""} tok/s`);
	if (narrow || speed.ttftMs === undefined) return rateText;
	return `${rateText} ${theme.fg("muted", `TTFT ${formatDuration(speed.ttftMs)}`)}`;
}

function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return `${tokens}`;
}

function formatDuration(ms: number): string {
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1_000)}s`;
}

const ZONE_ICONS = {
	Plan: "(^_^)",
	Code: "(>_>)",
	Dump: "(~_~)",
	ExDump: "(!_!)",
	Dead: "(x_x)",
} as const;

export function getZoneIcon(zone: string): string {
	return ZONE_ICONS[zone as keyof typeof ZONE_ICONS] ?? "•";
}

function getZoneColor(zone: string): "success" | "warning" | "error" | "dim" {
	switch (zone) {
		case "Plan":
			return "success";
		case "Code":
			return "success";
		case "Dump":
			return "warning";
		case "ExDump":
			return "error";
		case "Dead":
			return "error";
		default:
			return "dim";
	}
}

function getSpeedColor(tokensPerSecond: number): "success" | "warning" | "error" | "dim" {
	if (tokensPerSecond <= 0) return "dim";
	if (tokensPerSecond >= 20) return "success";
	if (tokensPerSecond >= 5) return "warning";
	return "error";
}

function formatTokensPerSecond(tokensPerSecond: number): string {
	if (tokensPerSecond < 100) return tokensPerSecond.toFixed(1);
	return Math.round(tokensPerSecond).toString();
}
