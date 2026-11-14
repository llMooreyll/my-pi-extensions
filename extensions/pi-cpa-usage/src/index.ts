import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchUsageSnapshot } from "./client.js";
import {
	getConfigPath,
	loadConfig,
	maskSecret,
	normalizeBaseUrl,
	resolveActiveServer,
	saveConfig,
} from "./config.js";
import { formatPlainReport, formatStatuslineCompact } from "./format.js";
import { UsageOverlayComponent, type UsageOverlayAction } from "./overlay.js";
import type { CpaUsageConfig, UsageSnapshot } from "./types.js";

const STATUS_KEY = "cpa-usage";

const SUBCOMMANDS = [
	{ value: "refresh", label: "refresh", description: "Force live refresh and open usage panel" },
	{ value: "text", label: "text", description: "Fetch live usage and show plain text summary" },
	{ value: "statusline on", label: "statusline on", description: "Enable compact 5h/weekly summary in statusline" },
	{ value: "statusline off", label: "statusline off", description: "Disable statusline usage summary" },
	{ value: "statusline toggle", label: "statusline toggle", description: "Toggle statusline usage summary" },
	{ value: "server", label: "server", description: "List or switch CPA server profile" },
	{ value: "config", label: "config", description: "Configure CPA server URL, key, and options" },
	{ value: "on", label: "on", description: "Enable pi-cpa-usage extension" },
	{ value: "off", label: "off", description: "Disable pi-cpa-usage extension" },
	{ value: "help", label: "help", description: "Show /usage command help" },
];

export default function cpaUsageExtension(pi: ExtensionAPI) {
	let config: CpaUsageConfig = loadConfig();
	let cachedSnapshot: UsageSnapshot | undefined;
	let inFlight: Promise<UsageSnapshot> | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let activeCtx: ExtensionContext | undefined;

	function stopPolling(): void {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
	}

	function updateStatusline(ctx: ExtensionContext | undefined): void {
		if (!ctx?.hasUI) return;
		if (!config.enabled || !config.statusline.enabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		if (!cachedSnapshot) {
			const srv = resolveActiveServer(config);
			ctx.ui.setStatus(
				STATUS_KEY,
				srv ? ctx.ui.theme.fg("dim", "CPA …") : ctx.ui.theme.fg("warning", "CPA unconfigured"),
			);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, formatStatuslineCompact(cachedSnapshot, ctx.ui.theme));
	}

	async function getSnapshot(options: { forceRefresh?: boolean } = {}): Promise<UsageSnapshot> {
		const server = resolveActiveServer(config);
		if (!server) {
			return {
				serverName: "",
				serverUrl: "",
				fetchedAtMs: Date.now(),
				accounts: [],
				error: "No CPA server configured. Run /usage config.",
			};
		}

		const nowMs = Date.now();
		const cacheTtlMs = config.cacheTtlSec * 1000;
		if (
			!options.forceRefresh &&
			cachedSnapshot &&
			cachedSnapshot.serverUrl === server.baseUrl &&
			nowMs - cachedSnapshot.fetchedAtMs < cacheTtlMs
		) {
			return cachedSnapshot;
		}

		if (inFlight && !options.forceRefresh) {
			return inFlight;
		}

		const promise = fetchUsageSnapshot(server, {
			timeoutMs: config.requestTimeoutMs,
			includeDisabled: config.statusline.showDisabled,
		}).then((snap) => {
			cachedSnapshot = snap;
			updateStatusline(activeCtx);
			return snap;
		});

		inFlight = promise;
		try {
			return await promise;
		} finally {
			if (inFlight === promise) inFlight = undefined;
		}
	}

	function syncPolling(ctx: ExtensionContext | undefined): void {
		stopPolling();
		if (!ctx?.hasUI || !config.enabled || !config.statusline.enabled) {
			updateStatusline(ctx);
			return;
		}
		updateStatusline(ctx);
		void getSnapshot({ forceRefresh: false });
		const intervalMs = Math.max(15_000, config.statusline.refreshIntervalSec * 1000);
		pollTimer = setInterval(() => {
			if (!config.enabled || !config.statusline.enabled) {
				stopPolling();
				return;
			}
			void getSnapshot({ forceRefresh: true });
		}, intervalMs);
	}

	function persistConfig(next: CpaUsageConfig): void {
		config = next;
		saveConfig(config);
	}

	function toggleStatusline(ctx: ExtensionContext, desired?: boolean): boolean {
		const nextEnabled = desired ?? !config.statusline.enabled;
		persistConfig({
			...config,
			statusline: { ...config.statusline, enabled: nextEnabled },
		});
		syncPolling(ctx);
		return nextEnabled;
	}

	async function runSwitchServer(ctx: ExtensionCommandContext): Promise<boolean> {
		const names = Object.keys(config.servers);
		if (names.length === 0) {
			ctx.ui.notify("No servers configured yet. Opening setup…", "info");
			return runConfigWizard(ctx);
		}
		const choices = names.map((name) => {
			const srv = config.servers[name]!;
			const mark = name === config.activeServer ? " (active)" : "";
			return `${name}${mark} — ${srv.baseUrl}`;
		});
		choices.push("+ Add / edit server…");

		const picked = await ctx.ui.select("Select CPA server:", choices);
		if (!picked) return false;
		if (picked === "+ Add / edit server…") {
			return runConfigWizard(ctx);
		}
		const idx = choices.indexOf(picked);
		const chosenName = names[idx];
		if (!chosenName) return false;

		persistConfig({ ...config, activeServer: chosenName });
		cachedSnapshot = undefined;
		syncPolling(ctx);
		ctx.ui.notify(`Active CPA server: ${chosenName}`, "info");
		return true;
	}

	async function runConfigWizard(ctx: ExtensionCommandContext): Promise<boolean> {
		if (!ctx.hasUI) {
			ctx.ui.notify(`Edit config directly at ${getConfigPath()}`, "info");
			return false;
		}

		const action = await ctx.ui.select("CPA Usage Config:", [
			"Add or update CPA server",
			"Switch active CPA server",
			"Remove CPA server",
			`Toggle statusline summary (currently ${config.statusline.enabled ? "ON" : "OFF"})`,
			`Toggle extension (currently ${config.enabled ? "ON" : "OFF"})`,
		]);
		if (!action) return false;

		if (action.startsWith("Switch active")) {
			return runSwitchServer(ctx);
		}

		if (action.startsWith("Toggle statusline")) {
			const next = toggleStatusline(ctx);
			ctx.ui.notify(`CPA statusline ${next ? "enabled" : "disabled"}`, "info");
			return true;
		}

		if (action.startsWith("Toggle extension")) {
			const next = !config.enabled;
			persistConfig({ ...config, enabled: next });
			syncPolling(ctx);
			ctx.ui.notify(`pi-cpa-usage ${next ? "enabled" : "disabled"}`, "info");
			return true;
		}

		if (action.startsWith("Remove CPA")) {
			const names = Object.keys(config.servers);
			if (names.length === 0) {
				ctx.ui.notify("No servers to remove.", "warning");
				return false;
			}
			const target = await ctx.ui.select("Remove which server?", names);
			if (!target) return false;
			const nextServers = { ...config.servers };
			delete nextServers[target];
			const nextActive = config.activeServer === target ? (Object.keys(nextServers)[0] ?? "") : config.activeServer;
			persistConfig({ ...config, servers: nextServers, activeServer: nextActive });
			cachedSnapshot = undefined;
			syncPolling(ctx);
			ctx.ui.notify(`Removed server "${target}"`, "info");
			return true;
		}

		// Add or update CPA server
		const defaultName = config.activeServer || "default";
		const nameInput = await ctx.ui.input("Server profile name:", defaultName);
		const name = nameInput?.trim();
		if (!name) return false;

		const existing = config.servers[name];
		const urlInput = await ctx.ui.input(
			"CPA / CPAMP base URL (e.g. https://cpamp.example.com or http://127.0.0.1:8317):",
			existing?.baseUrl ?? "https://",
		);
		const baseUrl = urlInput ? normalizeBaseUrl(urlInput) : "";
		if (!baseUrl) {
			ctx.ui.notify("Cancelled: base URL cannot be empty.", "warning");
			return false;
		}

		const keyPrompt = existing?.managementKey
			? `Management / Admin Key (current: ${maskSecret(existing.managementKey)}, or env:VAR_NAME):`
			: "Management / Admin Key (or env:VAR_NAME):";
		const keyInput = await ctx.ui.input(keyPrompt, existing?.managementKey ?? "");
		if (keyInput === undefined) return false;
		const managementKey = keyInput.trim() || existing?.managementKey || "";

		persistConfig({
			...config,
			activeServer: name,
			servers: {
				...config.servers,
				[name]: { baseUrl, managementKey },
			},
		});
		cachedSnapshot = undefined;
		syncPolling(ctx);
		ctx.ui.notify(`Saved CPA server "${name}" (${baseUrl})`, "info");
		return true;
	}

	async function openUsageOverlay(ctx: ExtensionCommandContext): Promise<void> {
		while (true) {
			const server = resolveActiveServer(config);
			if (!server && ctx.hasUI) {
				const configured = await runConfigWizard(ctx);
				if (!configured) return;
				continue;
			}

			const action = await ctx.ui.custom<UsageOverlayAction>(
				(tui, theme, _kb, done) =>
					new UsageOverlayComponent(
						tui,
						theme,
						{
							initialSnapshot: cachedSnapshot,
							serverName: server?.name ?? "",
							serverUrl: server?.baseUrl ?? "",
							statuslineEnabled: config.statusline.enabled,
							showDisabled: config.statusline.showDisabled,
							// Always force a live refresh whenever /usage opens or refreshes
							refresh: () => getSnapshot({ forceRefresh: true }),
							onToggleStatusline: () => toggleStatusline(ctx),
							onToggleShowDisabled: () => {
								const next = !config.statusline.showDisabled;
								persistConfig({
									...config,
									statusline: { ...config.statusline, showDisabled: next },
								});
								return next;
							},
						},
						done,
					),
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "86%",
						maxHeight: "88%",
					},
				},
			);

			if (!action || action.type === "close") return;
			if (action.type === "switch-server") {
				const changed = await runSwitchServer(ctx);
				if (!changed) return;
				continue;
			}
			if (action.type === "open-config") {
				const changed = await runConfigWizard(ctx);
				if (!changed) return;
			}
		}
	}

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		config = loadConfig();
		syncPolling(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopPolling();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		activeCtx = undefined;
	});

	pi.registerCommand("usage", {
		description: "Show live CPA OAuth 5h/weekly quota usage (/usage [refresh|text|statusline on|off|server|config])",
		getArgumentCompletions: (prefix) => {
			const lower = prefix.toLowerCase();
			const serverItems = Object.keys(config.servers).map((name) => ({
				value: `server ${name}`,
				label: `server ${name}`,
				description: config.servers[name]!.baseUrl,
			}));
			const matches = [...SUBCOMMANDS, ...serverItems].filter((item) => item.value.toLowerCase().startsWith(lower));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			activeCtx = ctx;
			config = loadConfig();
			const raw = args.trim();
			const parts = raw ? raw.split(/\s+/) : [];
			const sub = (parts[0] ?? "").toLowerCase();
			const arg1 = parts[1]?.toLowerCase() ?? "";

			if (sub === "help" || sub === "-h" || sub === "--help") {
				ctx.ui.notify(
					[
						"/usage                Open live usage panel (always refreshes)",
						"/usage refresh        Force live refresh and open panel",
						"/usage text           Force live refresh and show plain text report",
						"/usage statusline on|off|toggle   Toggle compact statusline display",
						"/usage server [name]  List or switch configured CPA server",
						"/usage config         Configure CPA servers and preferences",
						"/usage on|off         Enable or disable extension",
					].join("\n"),
					"info",
				);
				return;
			}

			if (sub === "on") {
				persistConfig({ ...config, enabled: true });
				syncPolling(ctx);
				ctx.ui.notify("pi-cpa-usage enabled", "info");
				return;
			}

			if (sub === "off") {
				persistConfig({ ...config, enabled: false });
				syncPolling(ctx);
				ctx.ui.notify("pi-cpa-usage disabled", "info");
				return;
			}

			if (sub === "statusline" || sub === "status") {
				let desired: boolean | undefined;
				if (arg1 === "on" || arg1 === "true" || arg1 === "enable") desired = true;
				else if (arg1 === "off" || arg1 === "false" || arg1 === "disable") desired = false;
				else if (arg1 === "" || arg1 === "toggle") desired = undefined;
				else {
					ctx.ui.notify("Usage: /usage statusline [on|off|toggle]", "warning");
					return;
				}
				if (!config.enabled && desired !== false) {
					persistConfig({ ...config, enabled: true });
				}
				const next = toggleStatusline(ctx, desired);
				ctx.ui.notify(`CPA statusline ${next ? "enabled" : "disabled"}`, "info");
				return;
			}

			if (sub === "config") {
				await runConfigWizard(ctx);
				return;
			}

			if (sub === "server") {
				const targetName = parts[1];
				if (!targetName) {
					if (ctx.hasUI && ctx.mode === "tui") {
						await runSwitchServer(ctx);
					} else {
						const list = Object.entries(config.servers)
							.map(([n, s]) => `${n === config.activeServer ? "* " : "  "}${n}: ${s.baseUrl}`)
							.join("\n");
						ctx.ui.notify(list || "No CPA servers configured.", "info");
					}
					return;
				}
				if (!config.servers[targetName]) {
					ctx.ui.notify(`Unknown CPA server "${targetName}". Available: ${Object.keys(config.servers).join(", ") || "(none)"}`, "error");
					return;
				}
				persistConfig({ ...config, activeServer: targetName });
				cachedSnapshot = undefined;
				syncPolling(ctx);
				ctx.ui.notify(`Switched CPA server to "${targetName}" (${config.servers[targetName]!.baseUrl})`, "info");
				return;
			}

			if (!config.enabled) {
				ctx.ui.notify("pi-cpa-usage is disabled. Run /usage on to enable.", "warning");
				return;
			}

			if (sub === "text" || ctx.mode !== "tui" || !ctx.hasUI) {
				const snap = await getSnapshot({ forceRefresh: true });
				ctx.ui.notify(formatPlainReport(snap), snap.error && snap.accounts.length === 0 ? "error" : "info");
				return;
			}

			if (sub === "" || sub === "refresh") {
				await openUsageOverlay(ctx);
				return;
			}

			ctx.ui.notify(`Unknown /usage subcommand "${raw}". Run /usage help.`, "warning");
		},
	});
}
