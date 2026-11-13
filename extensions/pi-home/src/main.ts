#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { SessionIndex } from "./index/indexer.ts";
import { MetaStore } from "./index/meta.ts";
import { writeLaunchFile } from "./launch/launch-file.ts";
import { packageRoot } from "./paths.ts";
import { detectCaps } from "./term/caps.ts";
import { loadThemeColors, makePalette } from "./theme.ts";
import { App, type LaunchRequest, type Page, type TabId } from "./ui/app.ts";
import { registerPages } from "./ui/pages/registry.ts";

const HELP = `pi-home — console home for pi

Usage:
  pi-home [--launch-file <path>]   open the console; the chosen launch is written to <path>
                                   (NUL-separated: cwd, then pi args). Without it, pi is run directly.
  pi-home --config <key>           print a config value (used by the zsh loop)
  pi-home --crt-window             open pi-home in a new Ghostty window with the CRT shader
  pi-home --dump                   print the session index summary as JSON and exit
  pi-home --help

Exit status: 0 = a launch was chosen, 1 = the user quit.
Environment: PI_HOME_TIER=crt|truecolor|256|plain, PI_HOME_REDUCED_MOTION=1, PI_HOME_THEME=<name>`;

async function main(): Promise<number> {
	const { values } = parseArgs({
		options: {
			"launch-file": { type: "string" },
			config: { type: "string" },
			"crt-window": { type: "boolean" },
			dump: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: false,
	});
	if (values.help) {
		process.stdout.write(`${HELP}\n`);
		return 0;
	}
	const config = loadConfig();
	if (values.config !== undefined) {
		const v = (config as unknown as Record<string, unknown>)[values.config];
		process.stdout.write(`${typeof v === "string" ? v : JSON.stringify(v)}\n`);
		return 0;
	}
	if (values["crt-window"]) return openCrtWindow();

	const index = new SessionIndex({ politeWords: config.analytics.politeWords, rushWords: config.analytics.rushWords });
	index.loadCache();
	if (values.dump) {
		await index.refresh();
		const rows = [...index.records.values()].map(({ ev: _ev, ...r }) => r);
		process.stdout.write(`${JSON.stringify({ progress: index.progress, sessions: rows.length, records: rows.slice(0, 3) }, null, 2)}\n`);
		return 0;
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		process.stderr.write("pi-home needs an interactive terminal\n");
		return 2;
	}

	const caps = detectCaps(process.env, config.visual.tier, config.visual.motion);
	const pal = makePalette(loadThemeColors(), caps);
	const meta = new MetaStore();
	let launch: LaunchRequest | null = null;
	const app = new App({
		pal,
		config,
		index,
		meta,
		onLaunch: (req) => {
			if (values["launch-file"]) writeLaunchFile(values["launch-file"], req.cwd, req.args);
			launch = req;
		},
	});
	const pages: { id: TabId; page: Page }[] = registerPages(app);
	app.tabs = pages;
	void index.refresh();
	const code = await app.run();
	const chosen = launch as LaunchRequest | null;
	if (code === 0 && chosen && !values["launch-file"]) {
		// No zsh loop: run pi ourselves.
		const r = spawnSync(config.piBinary, chosen.args, { cwd: chosen.cwd, stdio: "inherit" });
		return r.status ?? 1;
	}
	return code;
}

/** Open a dedicated Ghostty window whose only shader is pi-home's CRT shader (VISUAL.md §6). */
function openCrtWindow(): number {
	const shader = join(packageRoot(), "shaders", "crt.glsl");
	if (!existsSync(shader)) {
		process.stderr.write(`shader not found: ${shader}\n`);
		return 2;
	}
	const loop = join(packageRoot(), "shell", "pi-home.zsh");
	const child = spawn(
		"ghostty",
		[
			`--custom-shader=${shader}`,
			"--custom-shader-animation=true",
			"--title=pi-home",
			"-e",
			"zsh",
			"-ic",
			`export PI_HOME_CRT_SHADER=1; source ${JSON.stringify(loop)}; pi-home-loop`,
		],
		{ stdio: "ignore", detached: true },
	);
	child.on("error", (e) => process.stderr.write(`failed to start ghostty: ${e.message}\n`));
	child.unref();
	return 0;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		process.stderr.write(`pi-home: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
		process.exit(2);
	},
);
