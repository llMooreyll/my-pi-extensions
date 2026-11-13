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

/** Root of the pi-home package (two levels above this file). */
export const packageRoot = (): string => resolve(import.meta.dirname, "..");
