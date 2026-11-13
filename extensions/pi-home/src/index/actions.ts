import { spawn } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { liveDir } from "../paths.ts";

export interface LiveSession {
	pid: number;
	sessionFile: string;
	cwd: string;
	startedAt: number;
}

/**
 * Sessions currently open in a pi process, from status files written by the companion extension
 * (PLAN.md §5.4). Files of dead processes are removed.
 */
export function liveSessions(): Map<string, LiveSession> {
	const out = new Map<string, LiveSession>();
	let names: string[] = [];
	try {
		names = readdirSync(liveDir());
	} catch {
		return out;
	}
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const path = join(liveDir(), name);
		try {
			const s = JSON.parse(readFileSync(path, "utf8")) as LiveSession;
			try {
				process.kill(s.pid, 0);
			} catch (e) {
				// ESRCH = no such process; EPERM means it exists but belongs to someone else.
				if ((e as NodeJS.ErrnoException).code === "ESRCH") {
					rmSync(path, { force: true });
					continue;
				}
			}
			if (s.sessionFile) out.set(s.sessionFile, s);
		} catch {
			/* half-written or foreign file */
		}
	}
	return out;
}

/** Set the session name the same way /name does (appends a session_info entry). */
export async function renameSession(file: string, name: string): Promise<void> {
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const sm = SessionManager.open(file);
	sm.appendSessionInfo(name);
}

function run(cmd: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
		let err = "";
		child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `${cmd} exited ${code}`))));
	});
}

/** Move a session file to the desktop trash (never deletes permanently). */
export function trashSession(file: string): Promise<void> {
	return run("gio", ["trash", "--", file]);
}

/** Export to HTML with `pi --export <file> <out>`. */
export function exportSessionHtml(piBinary: string, file: string, out: string): Promise<void> {
	return run(piBinary, ["--export", file, out]);
}
