import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decorateEditor } from "./decorate.js";
import { createFilePickerService, registerFilePickerService } from "./service.js";
import { createTabCompletion } from "./tab-complete.js";

export default function piInputPlus(pi: ExtensionAPI): void {
	// Newest context; the editor and completion callbacks outlive a single session_start.
	let latest: ExtensionContext | undefined;
	let unregisterService: (() => void) | undefined;
	let mounted = false;

	pi.on("session_start", async (_event, ctx) => {
		latest = ctx;
		if (ctx.mode !== "tui") return;

		unregisterService ??= registerFilePickerService(createFilePickerService());
		if (mounted) return;
		mounted = true;

		ctx.ui.addAutocompleteProvider(createTabCompletion(() => latest));

		// Decorate whichever editor is configured instead of replacing it (statusline-pi does the same).
		const previous = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			decorateEditor(editor, tui, () => latest);
			return editor;
		});
	});

	pi.on("session_shutdown", async () => {
		mounted = false;
		latest = undefined;
		unregisterService?.();
		unregisterService = undefined;
	});
}
