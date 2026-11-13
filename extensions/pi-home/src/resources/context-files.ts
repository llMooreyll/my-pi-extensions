import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentDir } from "../paths.ts";

export interface ContextFile {
	path: string;
	scope: "global" | "ancestor" | "cwd";
}

// Candidate order of pi's loadContextFileFromDir (resource-loader.js); docs/configuration.md:
// AGENTS.override.md replaces AGENTS.md/CLAUDE.md in the same directory only.
const CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

function fileIn(dir: string): string | null {
	for (const name of CANDIDATES) {
		const p = join(dir, name);
		try {
			if (existsSync(p) && statSync(p).isFile()) return p;
		} catch {
			// unreadable candidate: try the next one
		}
	}
	return null;
}

/** Context files in the order pi loads them: agent dir, then ancestors from the root down to cwd. */
export function listContextFiles(cwd: string): ContextFile[] {
	const start = resolve(cwd);
	const out: ContextFile[] = [];
	const global = fileIn(agentDir());
	if (global) out.push({ path: global, scope: "global" });
	const chain: ContextFile[] = [];
	let dir = start;
	while (true) {
		const p = fileIn(dir);
		if (p && !out.some((f) => f.path === p)) chain.unshift({ path: p, scope: dir === start ? "cwd" : "ancestor" });
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return [...out, ...chain];
}
