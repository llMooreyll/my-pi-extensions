import { basename } from "node:path";

export interface Picked {
	path: string;
	isDirectory: boolean;
}

/**
 * How a picked path is written into the prompt.
 * - "ref": text the model reads as an attachment: `name[/abs/path]` for files, the bare absolute path for directories.
 * - "plain": the bare absolute path, for shell lines and slash-command arguments where brackets would break parsing.
 */
export type InsertStyle = "ref" | "plain";

export function quoteIfNeeded(path: string): string {
	return /\s/.test(path) ? `"${path}"` : path;
}

export function formatPicked(picked: Picked, style: InsertStyle): string {
	if (picked.isDirectory) {
		const dir = picked.path.endsWith("/") ? picked.path : `${picked.path}/`;
		return style === "plain" ? quoteIfNeeded(dir) : dir;
	}
	return style === "plain" ? quoteIfNeeded(picked.path) : `${basename(picked.path)}[${picked.path}]`;
}
