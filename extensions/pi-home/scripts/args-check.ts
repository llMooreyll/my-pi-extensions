// Dev tool: node scripts/args-check.ts — prints normalizeProfile results and profileArgs per table row.
import { emptyProfile, normalizeProfile } from "../shared/profile.ts";
import type { Profile } from "../shared/profile.ts";
import { profileArgs } from "../src/launch/args.ts";
import type { LaunchTarget } from "../src/launch/args.ts";
import type { ResourceItem } from "../src/resources/types.ts";

const item = (name: string): ResourceItem => ({
	kind: "extension",
	name,
	arg: `/ext/${name}.ts`,
	source: "global-dir",
	enabledByDefault: true,
	description: "",
});
const env = { defaultExtensions: [item("a"), item("b"), item("c")], companionEntry: "/pkg/extension/index.ts" };
const newT: LaunchTarget = { kind: "new", cwd: "/p" };
const resumeT: LaunchTarget = { kind: "resume", cwd: "/p", sessionFile: "/s.jsonl" };

for (const [name, input] of [
	["null", null],
	["{}", {}],
	["{version:1}", { version: 1 }],
	['{version:1, mcp:"no"}', { version: 1, mcp: "no" }],
	['{version:1, extensions:{mode:"only", only:["a"]}}', { version: 1, extensions: { mode: "only", only: ["a"] } }],
] as const) {
	console.log(`normalize ${name}: ${JSON.stringify(normalizeProfile(input))}`);
}

const rows: [string, (p: Profile) => void][] = [
	["model", (p) => (p.model = "prov/model-x")],
	["thinking", (p) => (p.thinking = "high")],
	["modelsScope", (p) => (p.modelsScope = ["a/*", "b"])],
	["extensions exclude", (p) => ((p.extensions.mode = "exclude"), (p.extensions.exclude = ["/ext/b.ts"]))],
	["extensions only", (p) => ((p.extensions.mode = "only"), (p.extensions.only = ["/ext/a.ts", "/ext/c.ts"]))],
	["mcp off", (p) => (p.mcp = false)],
	["skills none", (p) => (p.skills.mode = "none")],
	["skills only", (p) => ((p.skills.mode = "only"), (p.skills.only = ["/s/one/SKILL.md", "/s/two/SKILL.md"]))],
	["prompts none", (p) => (p.promptTemplates.mode = "none")],
	["prompts only", (p) => ((p.promptTemplates.mode = "only"), (p.promptTemplates.only = ["/p/x.md"]))],
	["context none", (p) => (p.contextFiles.mode = "none")],
	["system replace", (p) => (p.systemPrompt.replace = "/sys.md")],
	["system append", (p) => (p.systemPrompt.append = ["/a1.md", "/a2.md"])],
	["tools none", (p) => ((p.tools.none = true), (p.tools.allow = ["read"]))],
	["tools noBuiltin", (p) => (p.tools.noBuiltin = true)],
	["tools allow", (p) => (p.tools.allow = ["read", "grep"])],
	["tools add/remove", (p) => ((p.tools.add = ["codemode", "ls"]), (p.tools.remove = ["write"]))],
	["tools exclude", (p) => (p.tools.exclude = ["mcp__*", "bash"])],
	["trust", (p) => (p.trust = "trust")],
	["deny", (p) => (p.trust = "deny")],
	["offline", (p) => (p.offline = true)],
	["extensionFlags", (p) => (p.extensionFlags = { plan: true, foo: "bar", off: false })],
	["sessionName", (p) => (p.sessionName = "my session")],
];

console.log(`empty: ${JSON.stringify(profileArgs(emptyProfile(), newT, env))}`);
const all = emptyProfile();
for (const [name, apply] of rows) {
	const p = emptyProfile();
	apply(p);
	apply(all);
	console.log(`${name}: ${JSON.stringify(profileArgs(p, newT, env))}`);
}
console.log(`all (new): ${JSON.stringify(profileArgs(all, newT, env))}`);
console.log(`all (resume, no model/thinking/name): ${JSON.stringify(profileArgs(all, resumeT, env))}`);
