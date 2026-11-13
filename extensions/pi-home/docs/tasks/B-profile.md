# Brief B — resources, profiles, launch arguments, profile editor, presets, companion extension

Read `docs/tasks/README.md` first; its hard rules apply. Ask the lead whenever this brief does not
decide something. pi documentation is in `/usr/lib/node_modules/pi/packages/coding-agent/docs/`
(read-only). Quote the doc file and line in your report whenever your code depends on a pi rule.

## Files you own

- `src/resources/*.ts` (new)
- `shared/profile.ts` (existing — you may ADD functions; do not change the `Profile` interface,
  `emptyProfile`, `PROFILE_VERSION` or `PROFILE_ENTRY_TYPE` without asking)
- `src/launch/args.ts` (existing — implement `profileArgs`; keep `targetArgs` and `launchArgs`
  behaviour), `src/launch/resolve.ts` (new), `src/launch/profile-file.ts` (new)
- `src/ui/pages/profile-editor.ts` (new), `src/ui/pages/presets.ts` (new),
  `src/ui/pages/profile-hooks.ts` (new)
- `extension/index.ts` (new)
- `scripts/list-resources.ts`, `scripts/args-check.ts` (new, dev tools)
- In `src/ui/pages/registry.ts`: only the `presets` tab line, plus one call
  `installProfileHooks(app)` added at the top of `registerPages` (import from `profile-hooks.ts`).

## Step B1 — resource discovery (`src/resources/`)

Goal: list what the profile editor can toggle, using pi's documented discovery rules.

```ts
// src/resources/types.ts
export interface ResourceItem {
	kind: "extension" | "skill" | "prompt";
	/** Display name (package name, file stem or skill name). */
	name: string;
	/** Exact value to pass to pi: a path for -e/--skill/--prompt-template, or "builtin:<name>". */
	arg: string;
	source: "builtin" | "global-package" | "global-dir" | "global-settings" | "project-package" | "project-dir" | "project-settings";
	/** Loaded by pi when no CLI flag changes it (skills: honours +/- prefixes in settings). */
	enabledByDefault: boolean;
	/** Package source string from settings.json when it came from a package. */
	packageSource?: string;
	/** Short description (skill frontmatter `description`, package.json `description`), may be "". */
	description: string;
}
```

Files:
- `src/resources/packages.ts` — `listPackages(cwd: string, trusted: boolean)`: read the `packages`
  arrays of `<agentDir>/settings.json` and (only when `trusted`) `<cwd>/.pi/settings.json`; resolve
  each source to a directory exactly as `docs/packages.md` describes (npm → where pi installs it,
  git → where pi clones it, local path → relative to the settings file's directory). Read the
  package's `package.json` `pi` field (`extensions`, `skills`, `prompts`, `themes`) and fall back to
  the conventional directories from `docs/packages.md`. Also honour package filter objects if
  `docs/packages.md` defines them.
- `src/resources/extensions.ts` — `listExtensions(cwd, trusted): ResourceItem[]` from packages,
  `settings.extensions`, `<agentDir>/extensions/` (only real entry points — a directory needs an
  `index.ts`/`index.js` or a `package.json` with `pi.extensions`; e.g. `~/.pi/agent/extensions/pi-tool-display`
  contains only `config.json` and must NOT be listed), project equivalents when trusted, and the
  built-ins. The built-in list must be taken from `docs/cli.md` / `docs/extensions.md` / `pi --help`
  text (report which), not guessed.
- `src/resources/skills.ts` — `listSkills(cwd, trusted)` and `src/resources/prompts.ts` —
  `listPrompts(cwd, trusted)` following `docs/skills.md` and `docs/prompt-templates.md`, including
  the `+path` / `-path` default-enabled prefixes in `settings.skills`.
- `src/resources/context-files.ts` — `listContextFiles(cwd): { path: string; scope: "global" | "ancestor" | "cwd" }[]`
  in the order pi loads them, following `docs/configuration.md` (AGENTS.override.md rules
  included).
- `src/resources/trust.ts` — `isProjectTrusted(cwd): boolean` following `docs/security.md`
  (where pi stores trust decisions). If the docs do not say where trust is stored, ask the lead.
- `src/resources/models.ts` — `loadModels(force?: boolean): Promise<{ id: string; provider: string; contextWindow?: string }[]>`:
  runs `<config.piBinary> --offline --list-models` (this is the only pi invocation allowed in this
  brief), parses the table (columns: provider, model, context, max-out, thinking, images),
  caches to `<homeDataDir>/models.json` with a timestamp, returns cache when younger than 24 h unless
  `force`.

`scripts/list-resources.ts <cwd>` prints JSON `{ trusted, extensions, skills, prompts, contextFiles }`.

Acceptance B1:
- tsc clean.
- Run `node scripts/list-resources.ts /home/moorey/Projects/Pi-extension-dev` and report:
  number of extensions per source, all extension names, number of skills with enabledByDefault
  true/false, the contextFiles list. Cross-check: every entry of `~/.pi/agent/settings.json`
  `packages` must be represented (report a table package → resolved dir → entries).
- Run `node -e` or a tiny script calling `loadModels(true)` and report the count of models.
- Commit: `pi-home: discover extensions, skills, prompts, context files, trust and models`.

## Step B2 — profile helpers

Add to `shared/profile.ts`:
- `normalizeProfile(x: unknown): Profile | null` — returns a full Profile when `x` is an object
  with `version === 1`; every field is validated by type; invalid or missing fields take the
  `emptyProfile()` value; unknown fields are dropped. Returns null otherwise.
- `isEmptyProfile(p: Profile): boolean` — deep-equal to `emptyProfile()`.
- `describeProfile(p: Profile): string[]` — short English lines for non-default settings only,
  e.g. `model zero-cat/deepseek-v4.1-flash-1017`, `extensions: only 3`, `no MCP`,
  `context files: pick 2 + 1 extra`. Used in lists.

Create `src/launch/resolve.ts`:
- `resolveProfile(config: HomeConfig, target: LaunchTarget, rec: SessionRecord | null): { profile: Profile | null; origin: "session" | "project" | "global" | "none" }`
  — precedence: `normalizeProfile(rec?.profile)` (only for resume/fork targets) → `config.projectDefaults[target.cwd]` →
  `config.globalDefault` → null. Empty profiles count as null.

Acceptance B2: tsc clean; `scripts/args-check.ts` (created in B3) also prints
`normalizeProfile` results for: `null`, `{}`, `{version:1}`, `{version:1, mcp:"no"}` (must keep
mcp true), `{version:1, extensions:{mode:"only", only:["a"]}}`. Commit together with B3.

## Step B3 — `profileArgs`

`profileArgs(profile, target, env)` — change the signature to add a third parameter
`env: { defaultExtensions: ResourceItem[]; companionEntry: string }` and update `launchArgs`
to `launchArgs(target, profile, env)` accordingly. Its only caller will be your own hook
(B4); `src/ui/pages/home.ts` does not call `launchArgs`. `companionEntry` is the absolute path of
`extension/index.ts` (compute it from `packageRoot()` in `src/paths.ts`).
Mapping (binding; flags from `docs/cli.md`):

| Profile field | Arguments |
|---|---|
| `model` (only when `target.kind === "new"`) | `--model <model>` |
| `thinking` (only when `target.kind === "new"`) | `--thinking <level>` |
| `modelsScope` non-empty | `--models <comma-joined>` |
| `extensions.mode === "exclude"` | `-ne`, then `-e <arg>` for each `env.defaultExtensions` item whose `arg` is not in `exclude`, then `-e <env.companionEntry>` |
| `extensions.mode === "only"` | `-ne`, `-e <arg>` for each `only`, then `-e <env.companionEntry>` |
| `mcp === false` | `--no-mcp` |
| `skills.mode === "none"` | `-ns` |
| `skills.mode === "only"` | `-ns`, `--skill <p>` for each |
| `promptTemplates.mode === "none"` | `-np` |
| `promptTemplates.mode === "only"` | `-np`, `--prompt-template <p>` for each |
| `contextFiles.mode === "none"` | `-nc` |
| `systemPrompt.replace` | `--system-prompt <file>` |
| `systemPrompt.append` | `--append-system-prompt <file>` for each |
| `tools.none` | `-nt` (and ignore other tool fields) |
| `tools.noBuiltin` | `-nbt` |
| `tools.allow` non-null | `--tools <comma-joined>` |
| `tools.allow` null and add/remove non-empty | `--tools <+a,+b,-c>` |
| `tools.exclude` non-empty | `-xt <comma-joined>` |
| `trust` | `trust` → `-a`, `deny` → `-na`, `ask` → nothing |
| `offline` | `--offline` |
| `extensionFlags` | `true` → `--<name>`; string → `--<name>`, `<value>`; `false` → nothing |
| `sessionName` (only when `target.kind === "new"`) | `-n <name>` |

Order: exactly the table order. `scripts/args-check.ts` prints the args for: empty profile (must
be `[]`), and one profile per table row, plus one profile combining all rows. Each printed line:
`<case name>: <JSON args>`.

Acceptance B3: tsc clean, report the full output of `node scripts/args-check.ts`.
Commit: `pi-home: profile normalisation, resolution and profile → pi CLI arguments`.

## Step B4 — profile file, hooks and editor

`src/launch/profile-file.ts`: `writeProfileFile(profile: Profile): string` writes
`<runDir>/<Date.now()>-<random 6 hex>.json` (mode 0600) and returns the path;
`cleanupProfileFiles(maxAgeMs = 86_400_000)` deletes older files in `runDir`.

`src/ui/pages/profile-hooks.ts` exports `installProfileHooks(app: App): void` which sets
`homeHooks.buildArgs` and `homeHooks.editProfile` (`homeHooks` is exported by
`src/ui/pages/home.ts`; read its doc comments):
- `buildArgs(app, target, rec)` → `const { profile } = resolveProfile(app.config, target, rec)`;
  `args = launchArgs(target, profile, env)` with `env.defaultExtensions` = extensions from B1 with
  `enabledByDefault` (cache the list per cwd for the app lifetime); when `profile` is non-null,
  append `--home-profile <writeProfileFile(profile)>`. (The companion extension registers this
  flag. Verify in `docs/extensions.md` how pi treats flags registered by extensions and quote the
  line; if an unknown flag could make pi fail when the companion extension is not loaded, ask the
  lead.)
- `editProfile` → `app.push(new ProfileEditorPage(app, target, rec))`.
- Also call `cleanupProfileFiles()` once.

`src/ui/pages/profile-editor.ts` — `class ProfileEditorPage implements Page`, title `"PROFILE"`.
Layout (content surface):
- Header: target description (`NEW SESSION in <cwd>` / `RESUME <session title>` / `FORK ...`) and
  origin of the loaded profile (`session`, `project default`, `global default`, `none`).
- Left column (40%): group list `SESSION`, `MODEL`, `EXTENSIONS`, `SKILLS`, `PROMPTS`,
  `CONTEXT FILES`, `SYSTEM PROMPT`, `TOOLS`, `OTHER`, `FLAGS`. Each group shows a one-line summary.
- Right column: the fields of the selected group, each row `label  value  [CLI]` or `[RUN]` tag
  (`[CLI]` = applied at launch, `[RUN]` = applied by the companion extension at runtime: context
  file pick/extra and skill hideInPrompt).
- Bottom panel (4 rows): `[ COMMAND_PREVIEW ]` with `pi <args>` wrapped, computed live from
  the same argument builder WITHOUT writing a profile file (show `--home-profile <file>`
  literally).
- Editing: Up/Down move, Left/Right switch column focus, Space toggles booleans / list items,
  Enter edits (opens `MenuModal` for enums such as modes and thinking level, `PromptModal` for text
  and paths, a checklist modal for multi-select lists — implement `ChecklistModal` in this file
  using `ListView`, with a filter `TextInput` on top and Space to toggle).
- Lists come from B1: extensions (with source tag), skills, prompts, context files (for `pick` the
  checklist preselects all discovered files), models (from `loadModels()`, MenuModal with filter).
- Actions (footer hints): `ctrl+s` save to this session (only for resume/fork; stores the profile
  in the target via launch: it is saved by the companion extension when launched — so `ctrl+s`
  here means "launch with this profile"), `d` save as project default, `g` save as global
  default, `p` save as preset (PromptModal for the name), `l` load preset (MenuModal),
  `x` reset to empty, `enter` on the header launches. Every save shows a toast and writes config
  via `app.saveConfig()`.
- Launch: call `app.launch({ cwd, args })` with args built from the edited profile (same
  logic as `buildArgs` but with the edited profile instead of `resolveProfile`; factor the shared
  part into a function in `profile-hooks.ts`).

Acceptance B4:
- tsc clean.
- tmux captures (160×48) of the editor opened from Home with `e` on project
  `Pi-extension-dev`: group EXTENSIONS selected; the checklist modal open; the command preview
  after setting extensions mode `exclude` with one extension excluded and MCP off.
- Report the exact preview text.
- Commit: `pi-home: profile editor with command preview, project/global defaults and presets save`.

## Step B5 — Presets tab

`src/ui/pages/presets.ts` — `class PresetsPage implements Page`, title `"PRESETS"`, registered in
`registry.ts` (replace the presets placeholder). Left: list of `config.presets` names plus two
pseudo-entries `GLOBAL DEFAULT` and `PROJECT DEFAULTS (<n>)`; right: `describeProfile` lines and
the args preview for a `new` target in `process.cwd()`. Keys: `n` new (empty profile, name prompt),
`enter` edit (push `ProfileEditorPage` in a "preset editing" mode — add a constructor option
`{ editPreset: string }` that changes the save action to "save preset" and hides launch), `r`
rename, `d` delete with `ConfirmModal`, `c` duplicate. For PROJECT DEFAULTS, enter opens a
`MenuModal` of cwds; choosing one opens the editor in "project default" mode.

Acceptance B5: tsc clean; tmux capture with two presets created through the UI (report the
`config.json` `presets` keys afterwards, then delete the two test presets through the UI and
report `config.json` again). Commit: `pi-home: presets tab`.

## Step B6 — companion extension (`extension/index.ts`)

pi extension (see `docs/extensions.md`; import types from `@earendil-works/pi-coding-agent`, which
is installed as a devDependency). Behaviour (PLAN.md §5):
1. `pi.registerFlag("home-profile", { type: "string", description: "pi-home profile file" })`.
2. On `session_start`: read the flag value; if set, read the file, `normalizeProfile` it; compare
   with the latest `pi-home/profile` custom entry in `ctx.sessionManager.getEntries()`; when
   different (JSON string compare), `pi.appendEntry("pi-home/profile", profile)`. Delete the profile
   file after reading. Without the flag, take the profile from the latest entry (if any). Keep it in
   a module variable `active`.
3. On `before_agent_start`: if `active` exists —
   - `contextFiles.mode === "pick"`: keep only entries of `event.systemPromptOptions.contextFiles`
     whose `path` is in `include`;
   - for each `contextFiles.extra` path (mode `default` or `pick`): read the file (skip missing,
     `ctx.ui.notify` once per missing file) and push `{ path, content }` (check the exact element
     type in pi's `.d.ts` under `node_modules/@earendil-works/pi-coding-agent/dist` and quote it);
   - `skills.hideInPrompt`: remove those names from `event.systemPromptOptions.skills` (check the
     element type and quote it).
   Mutate in place; do not return a system prompt.
4. Live status: on `session_start` write `<agentDir>/pi-home/live/<process.pid>.json`
   `{ pid, sessionFile, cwd, startedAt }` (sessionFile from `ctx.sessionManager.getSessionFile()`);
   rewrite it on every `session_start`; delete it on `session_shutdown` with reason `quit`.
   (Use `node:fs` and the same path layout as `src/paths.ts`; do NOT import from `src/` — only from
   `shared/`. Duplicate the tiny `agentDir()` logic in `shared/agent-dir.ts`, a new file you own.)
5. Command `/home-profile`: shows `describeProfile(active)` lines via `ctx.ui.notify` (or "no
   pi-home profile").

Acceptance B6:
- tsc clean (the tsconfig already includes `extension/` and `shared/`).
- Load test WITHOUT a model call: run
  `pi --offline -ne -e ./extension/index.ts --no-session --list-models > /dev/null` and report exit
  code and stderr (this proves the extension loads; ask the lead before running anything else
  with pi).
- Report the quoted `.d.ts` lines for the `contextFiles` and `skills` element types.
- Commit: `pi-home: companion extension storing the session profile and applying runtime settings`.
