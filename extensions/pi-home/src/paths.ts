import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** pi's agent directory; honours PI_CODING_AGENT_DIR like pi itself (docs/environment-variables.md). */
export function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return resolve(env.replace(/^~(?=$|\/)/, homedir()));
	return join(homedir(), ".pi", "agent");
}

export const homeDataDir = (): string => join(agentDir(), "pi-home");
export const configPath = (): string => join(homeDataDir(), "config.json");
export const indexPath = (): string => join(homeDataDir(), "index.json");
export const metaPath = (): string => join(homeDataDir(), "meta.json");
export const runDir = (): string => join(homeDataDir(), "run");
export const liveDir = (): string => join(homeDataDir(), "live");
export const promptsDir = (): string => join(homeDataDir(), "prompts");
export const settingsPath = (): string => join(agentDir(), "settings.json");
export const defaultSessionsDir = (): string => join(agentDir(), "sessions");

/** Replace the home directory prefix with ~ for display. */
export function tildify(p: string): string {
	const h = homedir();
	return p === h ? "~" : p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

/** Where new project folders are created by default. */
export const projectsRoot = (): string => join(homedir(), "Projects");

/** Expand a leading ~ or ~/ using the user's home directory. */
export function expandHome(p: string): string {
	const h = homedir();
	if (p === "~") return h;
	if (p.startsWith("~/")) return join(h, p.slice(2));
	return p;
}

/** Format a directory path for interactive editing, ending with a single slash. */
export function formatDirInput(p: string): string {
	const t = tildify(p);
	return t.endsWith("/") ? t : `${t}/`;
}

/** Root of the pi-home package (two levels above this file). */
export const packageRoot = (): string => resolve(import.meta.dirname, "..");
