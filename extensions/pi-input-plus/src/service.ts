import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { openPicker } from "./picker.js";

/** Other extensions find the picker on globalThis[Symbol.for("pi.file-picker.v1")]. */
export const FILE_PICKER_SYMBOL = Symbol.for("pi.file-picker.v1");

export interface PickOptions {
	/** Directory the picker opens in. */
	cwd: string;
	title?: string;
	/** Only files with one of these extensions are listed, e.g. [".mp4"]. Directories always are. */
	extensions?: string[];
	/** Extra file filter; combined with `extensions`. */
	accept?: (absolutePath: string) => boolean;
	/** When false, Enter on a directory descends into it instead of choosing it. Default true. */
	selectDirectories?: boolean;
}

export interface PickResult {
	path: string;
	isDirectory: boolean;
}

export interface FilePickerService {
	readonly version: 1;
	/** Opens the floating picker; resolves undefined when the user closes it. Needs a TUI (`ctx.mode === "tui"`). */
	pick(ui: ExtensionUIContext, options: PickOptions): Promise<PickResult | undefined>;
}

export function createFilePickerService(): FilePickerService {
	return { version: 1, pick: (ui, options) => openPicker(ui, options) };
}

export function registerFilePickerService(service: FilePickerService): () => void {
	const registry = globalThis as unknown as Record<symbol, FilePickerService | undefined>;
	registry[FILE_PICKER_SYMBOL] = service;
	return () => {
		if (registry[FILE_PICKER_SYMBOL] === service) delete registry[FILE_PICKER_SYMBOL];
	};
}
