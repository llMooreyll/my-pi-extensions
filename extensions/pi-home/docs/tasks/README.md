# pi-home task briefs for team members

Each team member works through one brief, step by step, and reports to the lead (main agent)
after every step. This file holds the rules that apply to every brief.

## Hard rules (read twice)

1. **Do not decide anything that the brief does not decide.** If the brief is unclear, if two
   documents disagree, if the plan looks wrong, if an API does not exist, or if you would need a file,
   dependency or behaviour that is not listed: STOP and ask the lead with `team`-message. Wait for the
   answer. Do not pick an option yourself, do not "temporarily" work around it.
2. **Only touch the files your brief lists.** Never edit files owned by another brief or by the lead
   (listed under "Lead-owned files" below). If you need a change there, ask the lead.
3. **All user-visible text is English.** Labels, hints, errors, toasts, chart titles, report text.
   Code comments are English too.
4. **No new dependencies.** Use Node 26 built-ins, `@earendil-works/pi-tui` (already installed) and
   the modules already in `src/`. `npm install` of anything is forbidden.
5. **Colours only from `Palette`** (`src/theme.ts`). Never write an RGB literal in a page or chart.
6. **Glyph whitelist** (VISUAL.md §7): ASCII, box drawing `─│┌┐└┘├┤┬┴┼═║╔╗╚╝╟╢━┃`, blocks
   `█▀▄▌▐▖▗▘▝▁▂▃▄▅▆▇▏▎▍▋▊▉░▒▓`, braille `U+2800–U+28FF`, and `·…›»→←↑↓`. Nothing else
   (no `●○■◎✓✗`, no emoji). When `pal.caps.unicode` is false, use ASCII only.
7. **Type check must pass**: `cd extensions/pi-home && npx tsc -p tsconfig.json` prints nothing.
   Node runs TypeScript directly (type stripping), so: no `enum`, no `namespace`, no constructor
   parameter properties (`constructor(private x)`), always `import type` for types, and import paths
   end in `.ts`.
8. **Do not open GUI windows, do not take screenshots, do not use `wtype`/`niri`/`grim`.** Visual
   evidence is produced with a detached tmux session (see "Evidence" below). The lead does the
   screenshot review.
9. **Do not run pi** (`pi ...`) except where a brief step explicitly says so.
10. **Git**: commit in your worktree branch after each step that passes its acceptance check, one
    commit per step, message `pi-home: <what>` in English, imperative or descriptive, no emoji.
    Never push, never rebase, never touch other branches.
11. **Report after every step** to the lead: step id, files changed, the commit hash, and the
    evidence listed under that step's "Acceptance". Then continue with the next step unless the
    lead told you to wait.

## Lead-owned files (do not edit)

`src/term/*`, `src/theme.ts`, `src/config.ts`, `src/paths.ts`, `src/index/parse.ts`,
`src/index/indexer.ts`, `src/index/types.ts`, `src/index/query.ts`, `src/index/meta.ts`,
`src/ui/app.ts`, `src/ui/chrome.ts`, `src/ui/widgets.ts`, `src/ui/bigtext.ts`, `src/ui/format.ts`,
`src/ui/nav.ts`, `src/ui/pages/home.ts`, `src/ui/pages/sessions.ts`, `src/ui/pages/session-detail.ts`,
`src/main.ts`, `shell/*`, `shaders/*`, `PLAN.md`, `SESSIONS.md`, `VISUAL.md`, `JOURNAL.md`,
`README.md`, `package.json`, `tsconfig.json`.

Exception: `src/ui/pages/registry.ts` — each brief says exactly which line it may change there.

## Orientation (read before coding)

- `VISUAL.md` — look and feel, tiers, glyph rules.
- `SESSIONS.md` — what the Sessions and Analytics tabs must show.
- `PLAN.md` — overall architecture, profiles, launch flow.
- `src/term/canvas.ts` — `Surface` is the only drawing API: `text`, `textIn`, `put`, `fill`,
  `paint`, `hline`, `vline`, `box`, `sub`, `inset`, `hit` (mouse). Coordinates are relative to the
  surface; drawing outside is clipped.
- `src/theme.ts` — `Palette`: `p100/p70/p45/p25`, `screenBg`, `panelBg`, `series(i)`, `ramp(t)`,
  `rampGlyph(t)`, styles `sel/text/dim/faint/title/strong`, `caps.tier`, `caps.unicode`.
- `src/ui/app.ts` — `Page` and `Modal` interfaces; `App` API: `go`, `push`, `back`, `modal`,
  `toast`, `progress(ms)` (0..1 eased grow-in), `animate`, `blinkOn`, `requestRender`, `config`,
  `index` (`SessionIndex`), `meta`.
- `src/ui/widgets.ts` — `section`, `keyValues`, `progressBar`, `ListView`, `selectRow`,
  `TextInput`, `ConfirmModal`, `PromptModal`, `MenuModal`.
- `src/ui/pages/home.ts` — a complete page to copy patterns from.
- `src/index/types.ts` — `SessionRecord` and the column-oriented `SessionEvents`.
- `src/index/query.ts` — `SessionFilter`, `filterSessions`, `RANGES`, `rangeBounds`, `dayKey`,
  `startOfDay`, `sessionTitle`, `mainModel`, `listProjects`.
- `src/ui/nav.ts` — `drillDown(app, patch, label)` and `openSession(app, rec)`.

## Evidence (text screenshots)

Run pi-home in a detached tmux session at a fixed size and capture the screen as text:

```zsh
cd /path/to/your/worktree/extensions/pi-home
tmux kill-session -t ph-$USER-a 2>/dev/null
tmux new-session -d -s ph-$USER-a -x 160 -y 48 "node src/main.ts --launch-file /tmp/ph-a.launch"
sleep 4
tmux send-keys -t ph-$USER-a 3        # e.g. switch to tab 3
sleep 1
tmux capture-pane -t ph-$USER-a -p > /tmp/ph-a-tab3.txt
tmux send-keys -t ph-$USER-a q
```

Use a session name unique to you (`ph-a-...` for brief A, `ph-b-...` for brief B). Attach the
relevant part of the capture (not the whole file) to your report. The session index cache is shared
at `~/.pi/agent/pi-home/index.json`; do not delete it.
