import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** pi's agent directory; same rule as src/paths.ts (duplicated so extension/ never imports from src/). */
export function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return resolve(env.replace(/^~(?=$|\/)/, homedir()));
	return join(homedir(), ".pi", "agent");
}
