export interface ResourceItem {
	kind: "extension" | "skill" | "prompt";
	/** Display name (package name, file stem or skill name). */
	name: string;
	/** Exact value to pass to pi: a path for -e/--skill/--prompt-template, or "builtin:<name>". */
	arg: string;
	source:
		| "builtin"
		| "global-package"
		| "global-dir"
		| "global-settings"
		| "project-package"
		| "project-dir"
		| "project-settings";
	/** Loaded by pi when no CLI flag changes it (skills: honours +/- prefixes in settings). */
	enabledByDefault: boolean;
	/** Package source string from settings.json when it came from a package. */
	packageSource?: string;
	/** Short description (skill frontmatter `description`, package.json `description`), may be "". */
	description: string;
}
