# Brief A — chart library, aggregates and the Analytics tab

Read `docs/tasks/README.md` first; its hard rules apply. Ask the lead whenever this brief does not
decide something.

## Files you own

- `src/ui/charts/*.ts` (new)
- `src/index/aggregate.ts` (new)
- `src/ui/pages/analytics.ts` (new) and `src/ui/pages/analytics/*.ts` (new, one file per sub-page)
- `src/ui/pages/wrapped.ts` (new), `src/report/html.ts` (new)
- `scripts/chart-gallery.ts` (new, dev tool)
- In `src/ui/pages/registry.ts`: only the line that creates the `analytics` tab.

## Shared conventions for every chart

Every chart is a plain function in `src/ui/charts/`. Common types live in `src/ui/charts/common.ts`:

```ts
import type { Surface } from "../../term/canvas.ts";
import type { Palette } from "../../theme.ts";
import type { RGB } from "../../term/color.ts";

export interface ChartCtx {
	pal: Palette;
	/** Grow-in progress 0..1 (from app.progress()); multiply drawn magnitudes by it. Default 1. */
	progress?: number;
}
/** Draw "NO DATA" centred in pal.dim. Every chart calls this when it has nothing to show. */
export function noData(s: Surface, ctx: ChartCtx): void;
/** Round up to 1, 2, 2.5, 5 × 10^n. */
export function niceMax(v: number): number;
/** Compact axis label: 0, 950, 1.2K, 3M, $4.20 (when money=true). */
export function axisLabel(v: number, money?: boolean): string;
```

Requirements for **every** chart function (acceptance checks below test these):

- R1 Draw only inside the `Surface` it receives (the Surface clips, but layout must not rely on
  clipping to look right — e.g. labels must be truncated with `truncate()` from `src/term/width.ts`).
- R2 Colours only from `ctx.pal`.
- R3 Empty input or all-zero values → `noData()`.
- R4 Too small to draw meaningfully (state the minimum in the doc comment) → draw nothing but
  `"…"` at (0,0) in `pal.dim`.
- R5 Tier fallbacks: `pal.caps.unicode === false` → ASCII glyphs only (`#`, `=`, `-`, `|`, `+`, `.`,
  `*`); `pal.caps.tier === 0` → distinguish series/heat by glyph density (`pal.rampGlyph(t)`) not
  colour.
- R6 `ctx.progress` scales bar lengths / line heights / filled cells (0 → empty, 1 → full).
- R7 Optional `onClick` callbacks are registered with `surface.hit(...)`.
- R8 Doc comment on each exported function: what it draws, minimum size, parameter meaning.

## Step A1 — chart library

Create these files and exports (signatures are binding; ask before changing any):

| File | Exports |
|---|---|
| `common.ts` | `ChartCtx`, `noData`, `niceMax`, `axisLabel`, `legend(s, x, y, items: {label: string; color: RGB}[], ctx): number` (returns x after last item; draws `█ label` pairs separated by 2 spaces) |
| `spark.ts` | `sparkline(s, x, y, w, values: number[], style: Style, ctx)` — one row, `▁▂▃▄▅▆▇█`, resamples values to `w` columns by max-pooling |
| `bars.ts` | `interface BarItem { label: string; value: number; color?: RGB; part?: number; valueLabel?: string }` (`part` = sub-amount drawn in `pal.err`, e.g. errors). `hbars(s, items, ctx, opts?: { labelWidth?: number; max?: number; onClick?: (i: number) => void })` — one row per item: label, bar with 1/8 precision `▏▎▍▌▋▊▉█`, value label right of bar. `vbars(s, columns: number[][], colors: RGB[], ctx, opts?: { xLabels?: string[]; max?: number; onClick?: (i: number) => void; yAxis?: boolean; money?: boolean })` — stacked vertical columns (each column array = stack bottom→top), 1/8 precision with `▁▂▃▄▅▆▇█`, optional y-axis with 3 ticks, x labels on last row (skip labels that would overlap). `mirrorBars(s, up: number[], down: number[], ctx, opts?: { xLabels?: string[] })` — up bars in `pal.ok` above a centre line, down bars in `pal.err` below it (GitHub additions/deletions) |
| `heat.ts` | `heatGrid(s, x, y, rows: number, cols: number, value: (r: number, c: number) => number, ctx, opts?: { cellW?: 1 \| 2; cursor?: { r: number; c: number }; onClick?: (r: number, c: number) => void })` — `value` returns 0..1 or `NaN` for "no cell"; colour = `pal.ramp(v)`, glyph `█` repeated `cellW` (default 2) with no gap; cursor cell drawn with `pal.sel`. `calendarHeat(s, days: Map<string, number>, ctx, opts?: { weeks?: number; endDay?: number; cursor?: string; onClick?: (day: string) => void })` — GitHub contribution layout: 7 rows Mon..Sun, one column per week ending at `endDay` (ms, default now), each cell `██` coloured by value / max, month labels (`Jan`..`Dec`) on the row above, weekday labels `Mon`, `Wed`, `Fri` on the left; `days` keys are `dayKey()` strings |
| `braille.ts` | `class BrailleCanvas { constructor(wCells: number, hCells: number); readonly pw: number; readonly ph: number; set(px: number, py: number, color?: RGB): void; line(x0, y0, x1, y1, color?): void; draw(s: Surface, x: number, y: number, fallback: RGB): void }` (2×4 dots per cell, last colour written to a cell wins, cells with no dots are not drawn). `lineChart(s, series: { values: number[]; color: RGB }[], ctx, opts?: { area?: boolean; min?: number; max?: number; yAxis?: boolean; money?: boolean; markers?: { index: number; label: string }[] })` — markers draw a `▼` above the point and the label. `scatter(s, points: { x: number; y: number; color: RGB }[], ctx, opts?: { xLabel?: string; yLabel?: string; logX?: boolean; logY?: boolean })`. `donut(s, slices: { value: number; color: RGB; label: string }[], ctx)` — braille ring left, legend with percentages right. `radar(s, axes: { label: string; value: number }[], ctx)` — values 0..1, polygon + spokes + labels. `polar24(s, values: number[], ctx)` — 24 values, clock-face radial bars, hour labels 0/6/12/18. `violin(s, groups: { label: string; values: number[]; color: RGB }[], ctx, opts?: { log?: boolean })` — one horizontal violin per group (density mirrored around a centre line), median tick |
| `waffle.ts` | `waffle(s, x, y, parts: { value: number; color: RGB; label: string }[], ctx, opts?: { cols?: number; rows?: number })` — default 10×10 cells, each cell `█` followed by one space, largest-remainder rounding so cells sum to cols×rows, legend to the right with percentages |
| `treemap.ts` | `treemap(s, items: { label: string; value: number; color?: RGB }[], ctx, opts?: { onClick?: (i: number) => void })` — squarified layout (Bruls et al.), rectangles filled with background colour (`color ?? pal.series(i)` darkened to 45% via `mix` from `src/term/color.ts` towards `pal.screenBg`), label + value inside if it fits, 1-cell gaps |
| `box.ts` | `boxplot(s, groups: { label: string; values: number[] }[], ctx, opts?: { log?: boolean; money?: boolean; format?: (v: number) => string })` — horizontal: whiskers p5–p95 `├─`/`─┤`, box p25–p75 `▐█▌`, median `┃`, axis with min/max labels |
| `timeline.ts` | `gantt(s, rows: { label: string; start: number; end: number; color?: RGB; onClick?: () => void }[], from: number, to: number, ctx, opts?: { labelWidth?: number; tickFormat?: (t: number) => string })` — background-coloured bars on a time axis, ticks on the last row |
| `tree.ts` | `interface TreeNode { label: string; detail?: string; children: TreeNode[]; style?: Style }`, `tree(s, root: TreeNode, ctx, opts?: { scroll?: number }): number` (returns total rows) — `├─ └─ │` drawing |
| `flow.ts` | `flow(s, links: { from: string; to: string; value: number }[], ctx)` — simplified sankey: left column = sources, right column = targets, each link one row group drawn with `━` (width ∝ log value bucket: `─` < `━` < `█`), value label |
| `bignum.ts` | `bigNumber(s, x, y, text: string, ctx, opts?: { style?: Style }): number` — 3×5 digit font for `0-9 . , $ % K M B -` using `█▀▄` half blocks (3 rows tall), returns width; fallback to `pal.strong` text when unicode is off |
| `cloud.ts` | `tagCloud(s, words: { text: string; weight: number }[], ctx)` — sorted by weight, wrapped into lines, 4 weight bands: band 4 `pal.strong`, 3 `pal.text`, 2 `pal.title`, 1 `pal.dim`, two spaces between words |
| `index.ts` | re-exports everything above |

Also create `scripts/chart-gallery.ts`: renders every chart with fixed synthetic data into an
off-screen `Canvas` (from `src/term/canvas.ts`) using a palette from `makePalette(loadThemeColors(),
detectCaps(process.env, "truecolor", false))`, then prints it with `Renderer` (`src/term/renderer.ts`)
to stdout. Usage: `node scripts/chart-gallery.ts [tier] [width] [height]`; tier = `truecolor|256|plain`.
It renders one chart per screen-height block with a title line above each. It must also run every
chart at sizes 1×1, 8×3 and an empty data set and assert (throw) if any cell outside the target
surface changed (compare a canvas snapshot outside the surface rectangle before/after).

Acceptance A1:
- `npx tsc -p tsconfig.json` prints nothing.
- `node scripts/chart-gallery.ts truecolor 120 30 > /tmp/ph-a-gallery.ansi` exits 0; same for
  `256` and `plain`. Report the exit codes.
- Report `tmux` evidence: `tmux new-session -d -s ph-a-gal -x 130 -y 60 "cat /tmp/ph-a-gallery.ansi; sleep 30"`, then `capture-pane -p` text of the first 60 rows for each tier.
- Commit: `pi-home: chart library (bars, heat, braille, waffle, treemap, box, timeline, tree, flow, big numbers, cloud)`.

## Step A2 — aggregates

`src/index/aggregate.ts` computes everything the Analytics tab needs from `SessionRecord`s. All
functions take `(records: SessionRecord[], range: { from: number; to: number })` and only count
events whose timestamp is in `[from, to)`. Callers pass records already filtered with
`filterSessions` (subagents excluded unless the user toggles them). Required exports:

| Function | Returns |
|---|---|
| `dailySeries(records, range)` | `Map<dayKey, { calls; input; output; cacheRead; cacheWrite; reasoning; cost; warmCost; sessions: Set<string>; activeMinutes; userTurns; editAdd; editDel }>` — cost from `ev.cCost`, warm cost from events of kind `cache_warm` (`eVal / 1e6`), sessions = ids with any event that day, activeMinutes = per-day sum of gaps < 5 min between consecutive event timestamps (all of cT, tT, uT) of the same session |
| `hourWeekday(records, range)` | `number[7][24]` call counts, row 0 = Monday, local time |
| `hourOfDay(records, range)` | `number[24]` |
| `streaks(daily)` | `{ current: number; longest: number; longestEnd: string; activeDays: number }` |
| `modelStats(records, range)` | per model: `{ model; calls; input; output; cacheRead; cacheWrite; cost; durMs: number[] (cDur > 0); tps: number[] (cOut / (cDur/1000) when cDur > 1000 and cOut > 0); costPerCall: number[]; errors; aborted; truncated }`, sorted by calls desc |
| `modelWeekly(records, range)` | `{ weeks: string[] (Monday dayKey); models: string[]; calls: number[][] }` (weeks × models) |
| `modelSwitches(records, range)` | `{ from; to; value }[]` from consecutive `model_change` events within a session (dict values), top 12 |
| `thinkingStats(records, range)` | per thinking level: `{ level; calls; output; reasoning }` |
| `toolStats(records, range)` | per tool: `{ tool; calls; errors; durMs: number[]; source: "builtin" \| "mcp" \| "extension" }` (builtin = read, bash, edit, write, grep, find, ls; mcp = name starts with `mcp__`) |
| `toolTransitions(records, range, top = 10)` | `{ tools: string[]; matrix: number[][] }` — counts of tool → next tool within a session, ordered by tT, limited to the `top` most used tools |
| `toolDna(records, limit)` | latest `limit` sessions: `{ id; title; tools: number[] }` where tools are indices into a shared `names: string[]` (return `{ names, rows }`) |
| `topCounts(records, field)` | merge `bashCmds` / `gitSubs` / `codeLangs` / `customTypes` / `skills` / `words` maps: `{ key; count }[]` desc |
| `fileStats(records)` | `{ path; read; edit; write }[]` desc by total; `languages`: `{ ext; count }[]` by file extension of edited/written paths; `dirs`: `{ dir; count }[]` (parent directory, edits+writes) |
| `fileTimeline(records, range, top = 10)` | `{ files: string[]; days: string[]; matrix: number[][] }` edits per file per day from `ev.dT/dFile` |
| `projectStats(records, range)` | per cwd: `{ cwd; name; sessions; cost; tokens; first; last; weekly: number[] }` |
| `userStats(records, range)` | `{ messages; avgUserLen; avgAssistantLen; hanRatio; polite; rush; aborted; images; browserCtx; skillRefs; toolsPerTurn: number[] }` — toolsPerTurn = for each user message, number of tool results until the next user message |
| `costStats(records, range)` | `{ total; warm; byProject: { cwd; cost }[]; bySession: { id; title; cwd; cost }[] (desc, top 50); cumulative: { day: string; cost: number }[]; milestones: { amount: 1 \| 10 \| 100 \| 1000; day: string }[]; cacheHitByDay: { day; ratio }[] (cacheRead / (input + cacheRead)) }` |
| `budget(records, monthlyBudget, now)` | `{ spent; projected; ratio }` linear projection to month end |
| `longestRuns(records, n)` | `{ id; title; ms; prompt }[]` from `longestRunMs` |
| `subagentTree(records)` | `TreeNode[]` (from `charts/tree.ts`) — sessions whose `parentSession` points to another record's `file`; only roots that have children; label = `sessionTitle` |

Implementation notes (binding):
- Iterate the `ev` columns directly; do not allocate per-event objects in hot loops.
- Use `dayKey()` / `startOfDay()` from `src/index/query.ts` for days (local time).
- Export one memo helper: `memo<T>(key: string, revision: number, fn: () => T): T` that caches the
  last result per key and recomputes when `revision` (pass `app.index.revision`) or key changes.

Acceptance A2:
- tsc clean.
- Add `scripts/aggregate-check.ts` that loads `~/.pi/agent/pi-home/index.json`, runs every
  function over range "all", and prints: total cost from `costStats` and the sum of
  `SessionRecord.cost + warmCost` (these two must match within 0.01), total calls from
  `dailySeries` vs sum of `assistantMessages` (must match exactly), and the top 5 of `toolStats`,
  `modelStats`, `topCounts(words)`. Report the printed output.
- Commit: `pi-home: analytics aggregates over the session index`.

## Step A3 — Analytics tab

`src/ui/pages/analytics.ts` exports `class AnalyticsPage implements Page` (title `"ANALYTICS"`).
Register it in `registry.ts` by replacing the analytics placeholder line with
`{ id: "analytics", page: new AnalyticsPage(app) }` (and its import).

Layout inside the content surface:
- Row 0: sub-tab bar `OVERVIEW  TIME  COST  MODELS  TOOLS  FILES  PROJECTS  BEHAVIOUR  WRAPPED`;
  active one in `pal.sel`, others `pal.dim`; clickable; `[` / `]` switch; numbers are NOT used
  (they switch main tabs).
- Row 0 right side: range selector `7D 30D 90D 1Y ALL` (active in `pal.sel`), `r` cycles, clickable;
  then `+SUB` toggle (include subagent sessions), `s` toggles. Defaults: 30D, subagents off.
- Row 1: rule `pal.faint`.
- Rows 2..: the sub-page. Each sub-page is a class in `src/ui/pages/analytics/<name>.ts` with
  `draw(s: Surface, app: App, data: AnalyticsData)` and `key(data: string, app: App): boolean`,
  where `AnalyticsData = { records: SessionRecord[]; range: { from: number; to: number }; rangeId: RangeId }`.
- Sub-pages lay out charts in a grid of panels. Each panel: `section()` title + chart below. Panels
  that do not fit vertically are dropped from the bottom (never overlap). Up/Down scroll the
  sub-page by whole panels when content is taller than the screen (`pageUp`/`pageDown` too).
- Animations: pass `progress: app.progress(500)` to charts. `app.progress` restarts when the page
  is entered; also call a local restart (store `Date.now()` on sub-tab change and compute your own
  eased progress the same way) when switching sub-tab or range.
- Drill-down: clicking a heat cell / bar / treemap tile, or pressing Enter on a keyboard-selected
  item, calls `drillDown(app, patch, label)` from `src/ui/nav.ts`. Patch fields are `SessionFilter`
  fields, e.g. a day cell → `{ from: startOfDay(t), to: startOfDay(t) + DAY_MS }`, a model bar →
  `{ model }`, a tool bar → `{ tool }`, a project tile → `{ cwd }`, a file → `{ file }`.
  Clicking a session in a ranking calls `openSession(app, rec)`.

Sub-page contents (SESSIONS.md §5 is the source; this table decides which ones are in scope):

| Sub-page | Panels (in order) |
|---|---|
| OVERVIEW | 5 big-number cards in one row (SESSIONS, TURNS, TOKENS, COST, ACTIVE HOURS; each with a `sparkline` of the last 14 days and `▲ x%`/`▼ x%` vs the previous equal-length range in `pal.ok`/`pal.err`); TODAY gauge (`donut` of today's tokens vs 30-day daily average, label `xx% of avg`); `calendarHeat` (53 weeks, tokens per day); 30-day stacked `vbars` (input, cacheRead, cacheWrite, output); TOP-5 `hbars` ×3 side by side (projects by cost, models by calls, tools by calls) |
| TIME | `calendarHeat` with metric switch `m` cycling SESSIONS/TOKENS/COST/MINUTES and a keyboard cursor (arrows move, Enter drills down, the selected day's numbers are shown under it); punch card `heatGrid` 7×24 (weekday × hour, labels); `polar24`; streak card (big numbers current/longest + active days); session length histogram (`vbars`, log buckets 0-5m,5-15m,15-30m,30-60m,1-2h,2-4h,4h+ using `activeMinutes`); day-type badge: NIGHT OWL (≥25% of calls 0–5h), EARLY BIRD (≥25% 5–9h), WEEKEND WARRIOR (≥35% Sat/Sun), OFFICE HOURS (≥60% Mon–Fri 9–18h), else BALANCED — show the badge in a double box with the percentage |
| COST | cumulative cost `lineChart` (area) with milestone markers; daily cost `vbars` with a 7-day moving average overlaid (`lineChart` on the same rectangle, no axis); token composition waterfall (`hbars`: input, cacheRead, cacheWrite, output, reasoning); cache hit ratio `lineChart`; cache warm-up ledger (two `hbars`: warm-up spend vs estimated savings = cacheRead tokens × (input price − cacheRead price); since prices are unknown, show only the spend and the number of warm-ups — ask the lead before inventing any price data); `treemap` project → cost; cost per call `boxplot` per model; budget gauge (`progressBar` + projected month-end, hidden when `config.analytics.monthlyBudget` is 0); equivalence card (tokens ÷ `config.analytics.bookTokens` = books, cost ÷ `coffeePrice` = coffees) |
| MODELS | `waffle` share by calls (`c` toggles calls/cost); weekly stacked share `vbars` (100% stacked); TPS `violin` per model (top 6); latency vs output `scatter` (log both axes); thinking level stacked `hbars`; `flow` of model switches; failure rate `hbars` (error+aborted+length / calls) per model; `radar` for the selected model (Up/Down select among top 6: axes SPEED = median TPS / max, PRICE = 1 − cost per call / max, VOLUME = calls / max, RELIABILITY = 1 − failure rate, CACHE = cache hit ratio) |
| TOOLS | `hbars` calls with error `part`; `boxplot` durations per tool (top 10, log); transition `heatGrid` matrix with tool labels; tool DNA wall (last N sessions, one row each, one cell per tool call coloured `pal.series(toolIndex)`, legend); top bash commands `hbars`; git sub-commands `waffle`; extension footprint `hbars` (customTypes); tool source `donut` (builtin/extension/mcp) |
| FILES | top 20 files `hbars` (edit+write, `read` as a second number in the value label); language `waffle`; directory `treemap`; file × day `heatGrid` timeline (top 10 files, 30 days); daily added/deleted lines `mirrorBars`; code block languages `hbars` |
| PROJECTS | project card wall (grid of boxes: name, cost, sessions, last activity, `sparkline` of weekly calls; Enter/click drills down); bubble `scatter` (x sessions, y cost, log); lifeline `gantt` (first → last activity); weekly share stacked `vbars` |
| BEHAVIOUR | talk ratio (two `hbars`: you vs assistant average characters); Han/Latin ratio bar (`progressBar`-style two-colour bar); `tagCloud` of words; politeness and rush gauges (`donut` each, count and per-100-messages rate, title badge: POLITE ≥ 20/100, BLUNT ≤ 2/100); tools-per-turn histogram `vbars`; longest runs ranking (top 10, duration + prompt preview, click → `openSession`); references (`hbars`: browser context, skill references, images); subagent family `tree` (scrollable) |
| WRAPPED | handled in A4; in A3 show the text `Press enter to start Pi Wrapped` |

Acceptance A3:
- tsc clean.
- For each sub-page, a tmux text capture at 160×48 and at 100×30 (range 30D), showing no
  overlapping panels and no text running into the frame. Report the captures for OVERVIEW, TIME,
  COST at 160×48 and one at 100×30; for the other sub-pages report the first 15 rows.
- Also run `PI_HOME_TIER=plain` at 160×48 for OVERVIEW and report the capture.
- One commit per sub-page group is fine: `pi-home: analytics tab shell, overview and time`,
  `pi-home: analytics cost and models`, `pi-home: analytics tools, files, projects and behaviour`.

## Step A4 — Pi Wrapped and HTML report

- `src/ui/pages/wrapped.ts`: `class WrappedPage implements Page` (title `"WRAPPED"`), pushed with
  `app.push(new WrappedPage(app, period))` from the WRAPPED sub-page when Enter is pressed;
  `period` is `"month" | "quarter" | "all"` chosen with Left/Right on the WRAPPED sub-page before
  Enter. Nine full-screen cards (SESSIONS.md §5.9), `←`/`→` (and click on left/right halves) to
  move, `esc` to go back. Each card: big title with `drawBigText` (px from `bigTextScale`), one
  chart or big number, one sentence in English. Card transition: content slides in from the side over
  250 ms using `app.animate(300)` and a local start time.
- `src/report/html.ts`: `writeHtmlReport(records: SessionRecord[], range, config, outPath): void`
  writes one self-contained HTML file (inline CSS, data embedded as JSON, charts drawn with plain
  `<canvas>` 2D code you write — no external scripts, no CDN). Colours come from the palette
  (`toHex` from `src/term/color.ts`), dark background `pal.screenBg`, monospace font, the same
  sections as the Analytics sub-pages (one heading per sub-page with its main 2–3 charts).
  From the WRAPPED sub-page, key `h` writes `~/.pi/agent/pi-home/report-<YYYYMMDD-HHmm>.html`
  and shows a toast with the path; key `H` additionally runs `xdg-open <path>` detached
  (`spawn(..., { detached: true, stdio: "ignore" }).unref()`).

Acceptance A4:
- tsc clean.
- tmux captures of cards 1, 4 and 9 at 160×48.
- Generate a report with a small script call (do not press `H`): report the file size and
  `grep -c '<canvas' file`. Do not open a browser.
- Commit: `pi-home: Pi Wrapped cards and self-contained HTML report`.
