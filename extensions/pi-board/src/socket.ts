// Unix socket the board pane uses to send quoted items back to the main agent (DESIGN §8.4).

import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { PaneRequest } from "./shared/types.ts";

const MAX_LINE = 1024 * 1024;

/** `$XDG_RUNTIME_DIR/pi-board/<sessionId>.sock`, with a per-user temp directory when the variable is unset. */
export function socketPathFor(session: string): string {
	const runtime = process.env.XDG_RUNTIME_DIR;
	const dir = runtime ? join(runtime, "pi-board") : join(tmpdir(), `pi-board-${process.getuid?.() ?? "user"}`);
	return join(dir, `${session}.sock`);
}

export interface QuoteServer {
	close(): void;
}

/** True when something accepts connections on the socket (or does not answer in time). */
function isAlive(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const conn = connect(path);
		const done = (alive: boolean) => {
			clearTimeout(timer);
			conn.destroy();
			resolve(alive);
		};
		const timer = setTimeout(() => done(true), 500);
		conn.once("connect", () => done(true));
		conn.once("error", () => done(false));
	});
}

/** Removes sockets of earlier sessions whose listener is gone. */
async function removeStaleSockets(dir: string, own: string): Promise<void> {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.endsWith(".sock") || name === basename(own)) continue;
		const file = join(dir, name);
		if (!(await isAlive(file))) rmSync(file, { force: true });
	}
}

/** Resolves to undefined when the socket cannot be created; the caller reports that. */
export async function startQuoteServer(path: string, onQuote: (text: string) => void): Promise<QuoteServer | undefined> {
	const handle = (line: string) => {
		if (line.trim() === "") return;
		try {
			const request = JSON.parse(line) as Partial<PaneRequest>;
			if (request.type === "quote" && typeof request.text === "string" && request.text !== "") onQuote(request.text);
		} catch {
			// malformed line: ignore
		}
	};

	let server: Server;
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		rmSync(path, { force: true });
		await removeStaleSockets(dirname(path), path);
		server = createServer((conn) => {
			let buffer = "";
			conn.setEncoding("utf8");
			conn.on("data", (chunk: string) => {
				buffer += chunk;
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					handle(buffer.slice(0, newline));
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
				}
				if (buffer.length > MAX_LINE) conn.destroy();
			});
			conn.on("end", () => handle(buffer));
			conn.on("error", () => undefined);
		});
		const listening = await new Promise<boolean>((resolve) => {
			server.once("error", () => resolve(false));
			server.listen(path, () => resolve(true));
		});
		if (!listening) return undefined;
		server.on("error", () => undefined);
		try {
			chmodSync(path, 0o600);
		} catch {
			// best effort
		}
	} catch {
		return undefined;
	}

	return {
		close() {
			server.close();
			rmSync(path, { force: true });
		},
	};
}
