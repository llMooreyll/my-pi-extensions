import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AutocompleteProviderFactory, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { formatPicked, type InsertStyle } from "./format.js";
import { openPicker } from "./picker.js";

/** A leading `@` token: the `@` picker replaces the built-in attachment list, which must stay silent. */
export const AT_TOKEN = /(?:^|[\s(\[{<`])@(?:"[^"]*|[^\s]*)$/u;
const QUOTED_TOKEN = /"([^"]*)$/u;
const PLAIN_TOKEN = /[^\s"'=()[\]{}<>`]*$/u;

export interface PathToken {
	/** Text the completion replaces, including an opening quote. */
	prefix: string;
	/** The path as typed, without the quote. */
	raw: string;
}

export function pathToken(beforeCursor: string): PathToken | undefined {
	const quoted = QUOTED_TOKEN.exec(beforeCursor);
	if (quoted) return { prefix: quoted[0], raw: quoted[1] ?? "" };
	const plain = PLAIN_TOKEN.exec(beforeCursor)?.[0] ?? "";
	return plain ? { prefix: plain, raw: plain } : undefined;
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function commonPrefix(names: string[]): string {
	let prefix = names[0] ?? "";
	for (const name of names) {
		let i = 0;
		while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
		prefix = prefix.slice(0, i);
	}
	return prefix;
}

function insertStyle(line: string): InsertStyle {
	const text = line.trimStart();
	return text.startsWith("!") || text.startsWith("/") ? "plain" : "ref";
}

/** The replaced prefix includes an opening quote, so a quoted token keeps it (and stays open). */
function quoteValue(value: string, quoted: boolean): string {
	if (quoted) return `"${value}`;
	return /\s/.test(value) ? `"${value}"` : value;
}

/** Longest unambiguous continuation of `raw`, like a shell's Tab; undefined when there is no progress. */
async function completeByPrefix(raw: string, cwd: string): Promise<string | undefined> {
	const slash = raw.lastIndexOf("/");
	const dirPart = raw.slice(0, slash + 1);
	const namePrefix = raw.slice(slash + 1);
	const baseDir = dirPart ? resolve(isAbsolute(expandHome(dirPart)) ? expandHome(dirPart) : join(cwd, expandHome(dirPart))) : cwd;

	let dirents;
	try {
		dirents = await readdir(baseDir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	const visible = dirents.filter((d) => namePrefix.startsWith(".") || !d.name.startsWith("."));
	let matches = visible.filter((d) => d.name.startsWith(namePrefix));
	if (matches.length === 0) {
		const lower = namePrefix.toLowerCase();
		matches = visible.filter((d) => d.name.toLowerCase().startsWith(lower));
	}
	if (matches.length === 0) return undefined;

	if (matches.length === 1) {
		const only = matches[0]!;
		let isDirectory = only.isDirectory();
		if (only.isSymbolicLink()) isDirectory = await stat(join(baseDir, only.name)).then((s) => s.isDirectory(), () => false);
		return `${dirPart}${only.name}${isDirectory ? "/" : ""}`;
	}
	const common = commonPrefix(matches.map((d) => d.name));
	return common.length > namePrefix.length ? `${dirPart}${common}` : undefined;
}

/**
 * Opens the picker in the directory a path token ends with. Resolves the text that
 * replaces the token, or undefined when there is no TUI, the directory does not exist,
 * or the user closed the picker. A chosen directory gets no trailing space, so Tab can
 * be pressed again to go on picking inside it.
 */
export async function pickAtToken(ctx: ExtensionContext, line: string, token: PathToken): Promise<string | undefined> {
	if (ctx.mode !== "tui") return undefined;
	const typed = expandHome(token.raw);
	const directory = isAbsolute(typed) ? typed : resolve(ctx.cwd, typed);
	const isDirectory = await stat(directory).then((s) => s.isDirectory(), () => false);
	if (!isDirectory) return undefined;
	const picked = await openPicker(ctx.ui, { cwd: directory, title: "Pick a path" });
	if (!picked) return undefined;
	let text = formatPicked(picked, insertStyle(line));
	if (token.prefix.startsWith('"') && !text.startsWith('"')) text = `"${text}`;
	return picked.isDirectory ? text : `${text} `;
}

/**
 * Tab completion without a list: a path ending in `/` opens the file picker in that
 * directory; any other path is completed to its longest common prefix. Only Tab
 * (`force`) is handled; typing-triggered completion and slash commands stay built in.
 */
export function createTabCompletion(getContext: () => ExtensionContext | undefined): AutocompleteProviderFactory {
	return (current) => {
		const ours = new WeakSet<AutocompleteItem>();
		const reply = (prefix: string, value: string) => {
			const item: AutocompleteItem = { value, label: value };
			ours.add(item);
			return { prefix, items: [item] };
		};

		return {
			triggerCharacters: current.triggerCharacters,

			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const line = lines[cursorLine] ?? "";
				const before = line.slice(0, cursorCol);
				if (AT_TOKEN.test(before)) return null;
				if (!options.force) return current.getSuggestions(lines, cursorLine, cursorCol, options);

				const ctx = getContext();
				const token = pathToken(before);
				if (!ctx || !token) return null;

				if (token.raw.endsWith("/")) {
					const text = await pickAtToken(ctx, line, token);
					return text === undefined ? null : reply(token.prefix, text);
				}

				const completed = await completeByPrefix(token.raw, ctx.cwd);
				if (completed === undefined) return null;
				return reply(token.prefix, quoteValue(completed, token.prefix.startsWith('"')));
			},

			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				if (!ours.has(item)) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
				const line = lines[cursorLine] ?? "";
				const start = cursorCol - prefix.length;
				const next = [...lines];
				next[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
				return { lines: next, cursorLine, cursorCol: start + item.value.length };
			},

			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		};
	};
}
