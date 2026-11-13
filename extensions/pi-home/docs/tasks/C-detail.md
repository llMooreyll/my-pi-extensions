# Brief C — command preview polish and the session detail page

Read `docs/tasks/README.md` first; its hard rules apply. Ask the lead whenever this brief does not
decide something.

## Files you own

- `src/ui/pages/profile-editor.ts`, `src/ui/pages/profile-hooks.ts` (existing, written by a
  previous member; you may change them only as described in C1)
- `src/ui/pages/session-detail.ts` (new)
- `src/index/session-tree.ts` (new)
- In `src/ui/pages/registry.ts`: one call `installSessionDetail(app)` at the top of
  `registerPages` (next to `installProfileHooks(app)`) and its import.

Read-only references you will use: `src/ui/charts/*` (chart library, read the doc comments),
`src/ui/pages/analytics/layout.ts` (panel layout + scrolling helper used by the Analytics tab),
`src/ui/pages/sessions.ts` (`drawDetail` / `drawWater` show the data you have), `src/ui/nav.ts`,
`src/ui/pages/home.ts` (`launchTarget`, `homeHooks`), `src/resources/models.ts`.

## Step C1 — command preview

In the profile editor's `[ COMMAND_PREVIEW ]` panel and in the presets page preview (both use
`previewCommand` in `profile-hooks.ts`):
1. Replace the home directory prefix of every path argument with `~` (use `tildify` from
   `src/paths.ts`).
2. Collapse 3 or more consecutive `-e <path>` pairs into one token
   `-e ×N[<first name>, <second name>, …]` where names are the last path segment (for
   `…/extension/index.ts` use the package directory name; `builtin:x` stays as is), joined with
   `, `, truncated with `…` to at most 60 characters inside the brackets.
3. Panel height: 4 rows minimum; when the editor has spare vertical space, grow up to 8 rows.
4. New key `v` in the editor and in the presets page: open a modal titled `FULL_COMMAND` that
   lists the real (uncompressed, untildified) arguments one per line in a scrollable `ListView`,
   with `esc` to close. Do not add a clipboard action.

Acceptance C1: tsc clean; tmux capture (160×48) of the editor preview for the exclude-mode case
from brief B (one extension excluded, MCP off) showing the compact command with
`--no-mcp --home-profile <file>` fully visible; capture of the `v` modal (first 10 rows).
Commit: `pi-home: compact command preview with full-command view`.

## Step C2 — session tree reader

`src/index/session-tree.ts`:

```ts
export interface TreeEntry {
	id: string;
	parentId: string | null;
	type: string;            // entry type ("message", "compaction", "branch_summary", ...)
	role?: string;           // message role
	t: number;               // timestamp ms
	/** First 60 characters of user text (role user) or of the branch summary. */
	preview?: string;
	/** Latest label set on this entry by a "label" entry (see docs/session-format.md). */
	label?: string;
}
export async function readSessionTree(file: string): Promise<{ entries: Map<string, TreeEntry>; roots: string[]; children: Map<string, string[]>; leafId: string | null }>;
```

Stream the file line by line like `src/index/parse.ts` does (skip bad lines). Check the
"label" entry shape in `/usr/lib/node_modules/pi/packages/coding-agent/docs/session-format.md`
and quote it in your report. `leafId` = id of the last entry in the file.

Then a pure function `compactTree(tree, maxNodes = 200): TreeNode` (TreeNode from
`src/ui/charts/tree.ts`) that collapses linear chains: a node represents a run of entries without
branching; its label is `"<n> entries · <preview of the first user message in the run>"`, plus
`" [label]"` for each labelled entry in the run, and `" ◆"` is NOT allowed (glyph whitelist) —
mark the run containing `leafId` with the suffix `" « current"`. Children are the branches.

Acceptance C2: tsc clean; a script `scripts/tree-check.ts <file>` printing node count and the
compact tree as indented text; report its output for the session file with the most `branches`
in the index (find it from `~/.pi/agent/pi-home/index.json`) and for one with 0 branches.
Commit: `pi-home: session tree reader with compact branch view`.

## Step C3 — session detail page

`src/ui/pages/session-detail.ts` exports `installSessionDetail(app: App): void` which sets
`navHandlers.openSession = (app, rec) => app.push(new SessionDetailPage(app, rec))`, and
`class SessionDetailPage implements Page` with title = `"SESSION"`.

Layout (use the analytics `layout.ts` panel/scroll helper so panels never overlap and Up/Down
scroll by panel):

| Panel | Content |
|---|---|
| header (always visible, 4 rows) | session title (`pal.strong`), path, created → last activity, main model, `TOKENS`, `COST` (+ warm-up), `ACTIVE`, status (`OPEN in pi (pid N)` from `liveSessions()` in `src/index/actions.ts`, else `idle`); hint line: `enter resume  f fork  e profile  esc back` |
| CONTEXT_LEVEL | `lineChart` (area) of `cIn + cCR + cCW` per call; markers at each compaction event (place on the first call with `cT >= event time`, label `compact`); section right label = peak and, if the main model's context window is known from `loadModels()` (parse `1.0M`, `200K`, `128K` strings), `limit <value>` |
| CUMULATIVE_COST | `lineChart` (area, money axis) of running sum of `cCost`; markers at `model_change` events labelled with the short model name |
| TURNS | `gantt` with one row per user turn (latest turns that fit): start = `uT[i]`, end = next user turn time or the last event time of the session; label `turn <i+1> · <calls in turn> calls · <tools in turn> tools`; colour by `pal.series(0)` |
| TOOL_DNA | the session's tool results in time order as a strip of cells (`█`, one per call, wrapping across rows), colour `pal.series(index of tool in this session's tool list sorted by count)`; `legend()` below |
| TOOLS | `hbars` per tool: calls, `part` = errors |
| MODELS | `waffle` share of calls per model |
| FILES | list `path  e<edits+writes> r<reads>`, tildified, sorted by edits+writes, then reads |
| BRANCHES | `tree(compactTree(await readSessionTree(rec.file)))` — load asynchronously on page enter, show `loading…` until ready, `NO BRANCHES` when the compact tree is a single node |

Keys: `enter` → `launchTarget(app, { kind: "resume", cwd, sessionFile }, rec)`, `f` → fork,
`e` → `homeHooks.editProfile` (toast `profile editor not available` if unset). Esc is handled by
the App (back).

Animations: pass `progress: app.progress(500)`.

Acceptance C3: tsc clean; tmux captures at 160×48 and 100×30 of the detail page opened from the
Sessions tab (`2`, then `i` on the first row), plus one capture after scrolling down to BRANCHES
for the session with the most branches (use the Sessions tab search to find it by title).
Commit: `pi-home: session detail page`.
