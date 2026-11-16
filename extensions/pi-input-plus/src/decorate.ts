import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type EditorComponent, matchesKey, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { formatPicked } from "./format.js";
import { type Block, cursorOffset, findBlocks } from "./paste-blocks.js";
import { openPicker, printable } from "./picker.js";
import { AT_TOKEN, pathToken, pickAtToken } from "./tab-complete.js";
import { openImageViewer, openTextViewer } from "./viewer.js";

const DECORATED = Symbol.for("pi-input-plus.decorated");

/** Members of Pi's Editor class that EditorComponent does not declare; all optional here. */
interface EditorExtras {
	getCursor?(): { line: number; col: number };
	getLines?(): string[];
	isShowingAutocomplete?(): boolean;
	[DECORATED]?: boolean;
}

type Host = EditorComponent & EditorExtras;

/**
 * Adds behaviour to an editor instance by wrapping its public `handleInput` and
 * `handleMouse`, so it composes with other extensions that decorate the same editor:
 * - `@` after whitespace opens the file picker instead of the built-in list;
 * - Space before, or a click on, a large paste or a pasted image opens a viewer.
 */
export function decorateEditor(editor: EditorComponent, tui: TUI, getContext: () => ExtensionContext | undefined): void {
	const host = editor as Host;
	if (host[DECORATED]) return;
	host[DECORATED] = true;

	let busy = false;

	const tuiContext = (): ExtensionContext | undefined => {
		const ctx = getContext();
		return ctx?.mode === "tui" ? ctx : undefined;
	};

	const snapshot = () => {
		const lines = host.getLines?.();
		const cursor = host.getCursor?.();
		return lines && cursor ? { lines, cursor } : undefined;
	};

	const insert = (text: string): void => {
		if (host.insertTextAtCursor) host.insertTextAtCursor(text);
		else getContext()?.ui.pasteToEditor(text);
		tui.requestRender();
	};

	const blocks = (): Block[] => {
		const text = host.getText();
		return findBlocks(text, host.getExpandedText?.() ?? text);
	};

	const run = async (task: () => Promise<void>): Promise<void> => {
		busy = true;
		try {
			await task();
		} catch (error) {
			getContext()?.ui.notify(error instanceof Error ? error.message : String(error), "error");
		} finally {
			busy = false;
			tui.requestRender();
		}
	};

	const pickFile = (ctx: ExtensionContext): Promise<void> =>
		run(async () => {
			const picked = await openPicker(ctx.ui, { cwd: ctx.cwd, title: "Attach a file or directory" });
			// The "@" was swallowed to open the picker; closing without a choice gives it back.
			// A directory gets no trailing space so Tab can go on picking inside it.
			insert(picked ? `${formatPicked(picked, "ref")}${picked.isDirectory ? "" : " "}` : "@");
		});

	const preview = (ctx: ExtensionContext, block: Block): Promise<void> =>
		run(async () => {
			if (block.kind === "text") await openTextViewer(ctx.ui, block.label, block.text);
			else await openImageViewer(ctx.ui, block.path);
		});

	const atTrigger = (data: string): boolean => {
		if (printable(data) !== "@" || busy) return false;
		const ctx = tuiContext();
		const state = snapshot();
		if (!ctx || !state || host.isShowingAutocomplete?.()) return false;
		const line = state.lines[state.cursor.line] ?? "";
		const previous = state.cursor.col > 0 ? line[state.cursor.col - 1] : undefined;
		if (previous !== undefined && !/\s/u.test(previous)) return false;
		if ((state.lines[0] ?? "").trimStart().startsWith("!")) return false;
		void pickFile(ctx);
		return true;
	};

	const spaceTrigger = (data: string): boolean => {
		if (busy || !(matchesKey(data, "space") || data === " ")) return false;
		const ctx = tuiContext();
		const state = snapshot();
		if (!ctx || !state) return false;
		const offset = cursorOffset(state.lines, state.cursor);
		const block = blocks().find((b) => b.start === offset);
		if (!block) return false;
		void preview(ctx, block);
		return true;
	};

	const handleInput = host.handleInput.bind(host);

	// Tab after a path ending in "/" opens the picker there. Handled here rather than in the
	// autocomplete provider because Pi treats a line starting with "/" as a slash command
	// and never asks the provider for a path in that case.
	const tabTrigger = (data: string): boolean => {
		if (busy || !matchesKey(data, "tab")) return false;
		const ctx = tuiContext();
		const state = snapshot();
		if (!ctx || !state || host.isShowingAutocomplete?.()) return false;
		const line = state.lines[state.cursor.line] ?? "";
		const before = line.slice(0, state.cursor.col);
		if (AT_TOKEN.test(before) || before.trim() === "/") return false;
		const token = pathToken(before);
		if (!token?.raw.endsWith("/")) return false;
		void run(async () => {
			const text = await pickAtToken(ctx, line, token);
			if (text === undefined) return;
			// Remove the token through the editor's own backspace handling, then insert the pick.
			for (let i = [...token.prefix].length; i > 0; i--) handleInput("\x7f");
			insert(text);
		});
		return true;
	};

	host.handleInput = (data: string): void => {
		if (atTrigger(data) || spaceTrigger(data) || tabTrigger(data)) return;
		handleInput(data);
	};

	const handleMouse = host.handleMouse?.bind(host);
	if (handleMouse) {
		host.handleMouse = (event: TuiMouseEvent) => {
			const result = handleMouse(event);
			if (event.type !== "click" || event.button !== "left" || busy) return result;
			const ctx = tuiContext();
			const state = snapshot();
			if (!ctx || !state || host.isShowingAutocomplete?.()) return result;
			// Only clicks on the text rows count; the borders around them also report as editor clicks.
			const textRows = host.render(event.width).length - 2;
			if (event.y < 1 || event.y > textRows) return result;
			const offset = cursorOffset(state.lines, state.cursor);
			const block = blocks().find((b) => offset >= b.start && offset < b.end);
			if (block) void preview(ctx, block);
			return result;
		};
	}
}
