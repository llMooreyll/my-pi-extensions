import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { SEND_POLICIES, type SendPolicy } from "./cache-timer.js";
import { errorText, INTERNAL_COMMAND, type TriggerRuntime } from "./runtime.js";
import { describeTimer, formatClockTime, oneLine } from "./schedule.js";
import { otherStates } from "./state.js";

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

const SUBCOMMANDS: Array<{ value: string; description: string }> = [
	{ value: "list", description: "Show timers, pending triggers and settings" },
	{ value: "cancel", description: "cancel <id|all>: delete timers" },
	{ value: "run", description: "run <id>: fire a timer now" },
	{ value: "pause", description: "Stop firing timers and delivering triggers" },
	{ value: "resume", description: "Resume timers and deliveries" },
	{ value: "compact", description: "compact <on|off|default>: compact a cold cache before trigger runs in this session" },
	{ value: "policy", description: "policy <keep|rebase>: how trigger runs treat the conversation" },
	{ value: "inbox", description: "inbox <alias|off>: name this session for external triggers (@alias)" },
	{ value: "budget", description: "budget <usd|default>: daily spending limit of trigger runs (0 = none)" },
	{ value: "deliver", description: "Deliver pending triggers now" },
	{ value: "clear", description: "Discard pending triggers" },
];

const ARGUMENTS: Record<string, string[]> = {
	compact: ["on", "off", "default"],
	policy: ["keep", "rebase"],
	inbox: ["off"],
	budget: ["default", "0"],
	cancel: ["all"],
};

export function registerTriggerCommands(pi: ExtensionAPI, runtime: TriggerRuntime): void {
	pi.registerCommand("trigger", {
		description: "Timers, external triggers and trigger settings of this session",
		getArgumentCompletions(prefix): AutocompleteItem[] | null {
			const parts = prefix.split(/\s+/);
			// A word typed out in full gets no completion, so Enter submits instead of accepting the completion.
			if (parts.length <= 1) {
				const word = parts[0] ?? "";
				if (SUBCOMMANDS.some((s) => s.value === word)) return null;
				const items = SUBCOMMANDS.filter((s) => s.value.startsWith(word)).map((s) => ({
					value: s.value,
					label: s.value,
					description: s.description,
				}));
				return items.length ? items : null;
			}
			const sub = parts[0]!;
			const last = parts[parts.length - 1] ?? "";
			const options = sub === "cancel" || sub === "run" ? [...(sub === "cancel" ? ["all"] : []), ...(runtime.state?.timers.map((t) => t.id) ?? [])] : (ARGUMENTS[sub] ?? []);
			if (options.includes(last)) return null;
			const items = options.filter((o) => o.startsWith(last)).map((o) => ({ value: `${parts.slice(0, -1).join(" ")} ${o}`, label: o }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			try {
				if (!runtime.active) {
					ctx.ui.notify("pi-trigger is inactive here: it needs an interactive pi session", "warning");
					return;
				}
				const words = args.trim().split(/\s+/).filter(Boolean);
				if (words.length === 0) await menu(runtime, ctx);
				else await runSubcommand(runtime, ctx, words);
			} catch (error) {
				ctx.ui.notify(`/trigger: ${errorText(error)}`, "error");
			}
		},
	});

	pi.registerCommand(INTERNAL_COMMAND, {
		description: "internal: used by pi-trigger (do not run manually)",
		handler: async (args, ctx) => runtime.runInternalCommand(args, ctx),
	});
}

async function runSubcommand(runtime: TriggerRuntime, ctx: ExtensionCommandContext, words: string[]): Promise<void> {
	const [sub, arg] = words;
	const s = runtime.requireState();
	switch (sub) {
		case "list":
			ctx.ui.notify(summary(runtime), "info");
			return;
		case "cancel": {
			if (!arg) throw new Error("usage: /trigger cancel <id|all>");
			if (arg === "all") {
				const count = s.timers.length;
				s.timers = [];
				runtime.save();
				ctx.ui.notify(`Cancelled ${count} timer(s)`, "info");
				return;
			}
			if (!runtime.removeTimer(arg)) throw new Error(`no timer "${arg}"`);
			ctx.ui.notify(`Cancelled timer ${arg}`, "info");
			return;
		}
		case "run":
			if (!arg) throw new Error("usage: /trigger run <id>");
			if (!runtime.runTimerNow(arg)) throw new Error(`no timer "${arg}"`);
			ctx.ui.notify(`Queued a run of ${arg}`, "info");
			return;
		case "pause":
			s.paused = true;
			runtime.save();
			ctx.ui.notify("Triggers paused: timers do not fire and nothing is delivered until /trigger resume", "info");
			return;
		case "resume":
			s.paused = false;
			runtime.save();
			runtime.deliverNow();
			ctx.ui.notify("Triggers resumed", "info");
			return;
		case "compact":
			setSends(runtime, ctx, parseSends(arg));
			return;
		case "policy":
			if (arg !== "keep" && arg !== "rebase") throw new Error("usage: /trigger policy <keep|rebase>");
			setPolicy(runtime, ctx, arg);
			return;
		case "inbox":
			if (!arg) throw new Error("usage: /trigger inbox <alias|off>");
			await setAlias(runtime, ctx, arg === "off" ? undefined : arg);
			return;
		case "budget":
			setBudget(runtime, ctx, arg);
			return;
		case "deliver":
			runtime.deliverNow();
			ctx.ui.notify(`Delivering ${s.pending.length} pending trigger(s) when Pi is idle`, "info");
			return;
		case "clear":
			ctx.ui.notify(`Discarded ${runtime.clearPending()} pending trigger(s)`, "info");
			return;
		default:
			throw new Error(`unknown subcommand "${sub}"; try ${SUBCOMMANDS.map((c) => c.value).join(", ")}`);
	}
}

async function menu(runtime: TriggerRuntime, ctx: ExtensionCommandContext): Promise<void> {
	const s = runtime.requireState();
	const now = Date.now();
	const actions = new Map<string, () => Promise<void> | void>();
	for (const timer of [...s.timers].sort((a, b) => a.nextFireAt - b.nextFireAt)) {
		actions.set(`Timer ${timer.id}: ${oneLine(describeTimer(timer, now).split("\n")[0]!.slice(timer.id.length + 2), 70)}`, () => timerMenu(runtime, ctx, timer.id));
	}
	if (s.pending.length) {
		actions.set(`Pending triggers: ${s.pending.length}…`, async () => {
			const choice = await ctx.ui.select(`${s.pending.length} pending trigger(s)`, ["Deliver now", "Discard all", "Back"]);
			if (choice === "Deliver now") runtime.deliverNow();
			if (choice === "Discard all") ctx.ui.notify(`Discarded ${runtime.clearPending()} pending trigger(s)`, "info");
		});
	}
	actions.set(s.paused ? "Resume triggers" : "Pause triggers", () => runSubcommand(runtime, ctx, [s.paused ? "resume" : "pause"]));
	actions.set(`Compact before trigger runs: ${sendsLabel(s.sends)}…`, async () => {
		const options = new Map<string, SendPolicy | undefined>([
			["Use the pi-cache-timer setting (extensionSends)", undefined],
			["Compact first when the cache is cold", "compact"],
			["Never compact; send as is", "pass"],
		]);
		const choice = await ctx.ui.select("Before a trigger run in this session", [...options.keys()]);
		if (choice !== undefined) setSends(runtime, ctx, options.get(choice));
	});
	actions.set(`Context policy: ${s.contextPolicy}…`, async () => {
		const choice = await ctx.ui.select("How trigger runs treat the conversation", [
			"keep: continue the conversation",
			"rebase: start every trigger run from the current point",
		]);
		if (choice) setPolicy(runtime, ctx, choice.startsWith("keep") ? "keep" : "rebase");
	});
	actions.set(`Inbox alias: ${s.alias ? `@${s.alias}` : "none"}…`, async () => {
		const value = await ctx.ui.input("Alias for external triggers (empty to remove)", s.alias ?? "archive");
		if (value === undefined) return;
		await setAlias(runtime, ctx, value.trim() || undefined);
	});
	const budget = runtime.budget();
	actions.set(`Daily budget: ${budget > 0 ? `$${budget.toFixed(2)}` : "no limit"} (spent $${s.spent.usd.toFixed(2)} today)…`, async () => {
		const value = await ctx.ui.input("Daily budget of trigger runs in USD (0 = no limit, empty = default)", String(budget));
		if (value === undefined) return;
		setBudget(runtime, ctx, value.trim() || "default");
	});

	const choice = await ctx.ui.select("Triggers of this session", [...actions.keys()]);
	if (choice !== undefined) await actions.get(choice)?.();
}

async function timerMenu(runtime: TriggerRuntime, ctx: ExtensionCommandContext, id: string): Promise<void> {
	const timer = runtime.state?.timers.find((t) => t.id === id);
	if (!timer) return;
	const choice = await ctx.ui.select(describeTimer(timer, Date.now()), ["Run now", "Cancel timer", "Back"]);
	if (choice === "Run now") await runSubcommand(runtime, ctx, ["run", id]);
	if (choice === "Cancel timer") await runSubcommand(runtime, ctx, ["cancel", id]);
}

function parseSends(arg: string | undefined): SendPolicy | undefined {
	if (arg === "on") return "compact";
	if (arg === "off") return "pass";
	if (arg === "default") return undefined;
	if (arg && SEND_POLICIES.includes(arg as SendPolicy)) return arg as SendPolicy;
	throw new Error("usage: /trigger compact <on|off|default>");
}

function sendsLabel(sends: SendPolicy | undefined): string {
	if (sends === "compact") return "on";
	if (sends === "pass") return "off";
	return "pi-cache-timer default";
}

function setSends(runtime: TriggerRuntime, ctx: ExtensionCommandContext, sends: SendPolicy | undefined): void {
	const s = runtime.requireState();
	if (sends === undefined) delete s.sends;
	else s.sends = sends;
	runtime.save();
	ctx.ui.notify(`Compact before trigger runs in this session: ${sendsLabel(sends)}`, "info");
}

function setPolicy(runtime: TriggerRuntime, ctx: ExtensionCommandContext, policy: "keep" | "rebase"): void {
	const s = runtime.requireState();
	if (policy === "keep") {
		s.contextPolicy = "keep";
		delete s.baseEntryId;
		runtime.save();
		ctx.ui.notify("Context policy: keep. Trigger runs continue the conversation.", "info");
		return;
	}
	if (!ctx.isIdle()) throw new Error("wait until Pi is idle: the base is the current end of the conversation");
	const leafId = ctx.sessionManager.getLeafId();
	const leaf = leafId ? ctx.sessionManager.getEntry(leafId) : undefined;
	if (!leafId || !leaf) throw new Error("the conversation is empty; write the instructions for this session first");
	if (leaf.type === "message" && leaf.message.role === "user") throw new Error("the conversation ends with an unanswered user message");
	s.contextPolicy = "rebase";
	s.baseEntryId = leafId;
	runtime.save();
	ctx.ui.notify(
		`Context policy: rebase. Every trigger run starts from the current point (${formatClockTime(Date.now())}); earlier runs stay in /tree.`,
		"info",
	);
}

async function setAlias(runtime: TriggerRuntime, ctx: ExtensionCommandContext, alias: string | undefined): Promise<void> {
	const s = runtime.requireState();
	if (alias === undefined) {
		const old = s.alias;
		delete s.alias;
		delete s.aliasSetAt;
		runtime.save();
		ctx.ui.notify(old ? `Removed @${old}` : "This session has no alias", "info");
		return;
	}
	const name = alias.replace(/^@/, "");
	if (!ALIAS_PATTERN.test(name)) throw new Error(`invalid alias "${alias}": lowercase letters, digits and dashes (max 40)`);
	if (!s.sessionFile) throw new Error("this session is not saved to a file, so the hub cannot reach it");
	const holder = otherStates(s.sessionId).find((o) => o.alias === name && !!o.sessionFile && existsSync(o.sessionFile));
	if (holder) {
		const ok = await ctx.ui.confirm(`@${name} is in use`, `Session ${holder.sessionFile ?? holder.sessionId} has @${name}. Move it to this session?`);
		if (!ok) return;
	}
	s.alias = name;
	s.aliasSetAt = Date.now();
	runtime.save();
	ctx.ui.notify(`This session is now @${name}. Routes in hub.json and "pi-hostd trigger send @${name} …" reach it.`, "info");
}

function setBudget(runtime: TriggerRuntime, ctx: ExtensionCommandContext, arg: string | undefined): void {
	const s = runtime.requireState();
	if (!arg) throw new Error("usage: /trigger budget <usd|default>");
	if (arg === "default") delete s.dailyBudgetUsd;
	else {
		const value = Number(arg.replace(/^\$/, ""));
		if (!Number.isFinite(value) || value < 0) throw new Error(`invalid amount "${arg}"`);
		s.dailyBudgetUsd = value;
	}
	runtime.save();
	runtime.deliverNow();
	const budget = runtime.budget();
	ctx.ui.notify(`Daily budget of trigger runs: ${budget > 0 ? `$${budget.toFixed(2)}` : "no limit"}`, "info");
}

function summary(runtime: TriggerRuntime): string {
	const s = runtime.requireState();
	const now = Date.now();
	const budget = runtime.budget();
	const lines = [
		`alias: ${s.alias ? `@${s.alias}` : "none"} · policy: ${s.contextPolicy} · compact: ${sendsLabel(s.sends)} · ${s.paused ? "paused" : "active"}`,
		`budget: ${budget > 0 ? `$${budget.toFixed(2)}` : "no limit"}, spent today $${s.spent.usd.toFixed(2)}`,
		s.timers.length ? `timers:\n${s.timers.map((t) => describeTimer(t, now)).join("\n")}` : "timers: none",
		s.pending.length ? `pending:\n${s.pending.map((p) => `  ${p.label}: ${oneLine(p.title, 80)}`).join("\n")}` : "pending: none",
	];
	return lines.join("\n");
}
