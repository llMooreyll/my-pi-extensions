/**
 * pi-home companion extension (PLAN.md §5): stores the launch profile in the session, applies the
 * runtime-only settings (context file pick/extra, skill hiding) and publishes live-session status.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../shared/agent-dir.ts";
import { describeProfile, normalizeProfile, PROFILE_ENTRY_TYPE } from "../shared/profile.ts";
import type { Profile } from "../shared/profile.ts";

const startedAt = Date.now();
const liveFile = (): string => join(agentDir(), "pi-home", "live", `${process.pid}.json`);

function readProfileFile(path: string): Profile | null {
	try {
		return normalizeProfile(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return null;
	} finally {
		// The launcher writes one file per launch; it is only meant to be read once.
		rmSync(path, { force: true });
	}
}

export default function (pi: ExtensionAPI): void {
	let active: Profile | null = null;
	const warnedMissing = new Set<string>();

	pi.registerFlag("home-profile", { type: "string", description: "pi-home profile file" });

	pi.on("session_start", (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		let stored: Profile | null = null;
		for (const e of entries) {
			if (e.type === "custom" && e.customType === PROFILE_ENTRY_TYPE) stored = normalizeProfile(e.data) ?? stored;
		}
		const flag = pi.getFlag("home-profile");
		const fromFile = typeof flag === "string" && flag !== "" ? readProfileFile(flag) : null;
		if (fromFile) {
			if (JSON.stringify(fromFile) !== JSON.stringify(stored)) pi.appendEntry(PROFILE_ENTRY_TYPE, fromFile);
			active = fromFile;
		} else active = stored;

		try {
			mkdirSync(join(agentDir(), "pi-home", "live"), { recursive: true });
			writeFileSync(
				liveFile(),
				JSON.stringify({
					pid: process.pid,
					sessionFile: ctx.sessionManager.getSessionFile() ?? null,
					cwd: ctx.sessionManager.getCwd(),
					startedAt,
				}),
			);
		} catch {
			// live status is best effort
		}
	});

	pi.on("session_shutdown", (event) => {
		if (event.reason === "quit") rmSync(liveFile(), { force: true });
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!active) return;
		const opts = event.systemPromptOptions;
		const cf = active.contextFiles;
		if (cf.mode === "pick") {
			const keep = opts.contextFiles.filter((f) => cf.include.includes(f.path));
			opts.contextFiles.splice(0, opts.contextFiles.length, ...keep);
		}
		if (cf.mode !== "none") {
			for (const path of cf.extra) {
				if (opts.contextFiles.some((f) => f.path === path)) continue;
				try {
					opts.contextFiles.push({ path, content: readFileSync(path, "utf8") });
				} catch {
					if (!warnedMissing.has(path)) {
						warnedMissing.add(path);
						ctx.ui.notify(`pi-home: extra context file not found: ${path}`, "warning");
					}
				}
			}
		}
		const hide = active.skills.hideInPrompt;
		if (hide.length > 0) {
			const keep = opts.skills.filter((s) => !hide.includes(s.name));
			opts.skills.splice(0, opts.skills.length, ...keep);
		}
	});

	pi.registerCommand("home-profile", {
		description: "Show the active pi-home profile",
		handler: async (_args, ctx) => {
			const lines = active ? describeProfile(active) : [];
			ctx.ui.notify(active ? `pi-home profile: ${lines.join("; ") || "default settings"}` : "no pi-home profile", "info");
		},
	});
}
