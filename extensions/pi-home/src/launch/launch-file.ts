import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Launch file handed to the zsh loop (PLAN.md §3.2): NUL-separated fields, first the working
 * directory, then the pi arguments. NUL cannot appear in paths or argv, so no quoting is needed.
 */
export function writeLaunchFile(path: string, cwd: string, args: string[]): void {
	for (const a of [cwd, ...args]) if (a.includes("\0")) throw new Error("argument contains NUL");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, [cwd, ...args].join("\0"), { encoding: "utf8", mode: 0o600 });
}
