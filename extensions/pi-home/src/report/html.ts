import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { costStats, dailySeries, fileStats, hourOfDay, hourWeekday, longestRuns, modelStats, modelWeekly, projectStats, toolStats, topCounts, userStats } from "../index/aggregate.ts";
import type { HomeConfig } from "../config.ts";
import { fmtDate } from "../ui/format.ts";
import type { SessionRecord } from "../index/types.ts";
import { toHex } from "../term/color.ts";
import { detectCaps } from "../term/caps.ts";
import { loadThemeColors, makePalette } from "../theme.ts";

const median = (a: number[]): number => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]! : 0);

/** Drawing code that runs in the browser: plain canvas 2D, no libraries. Uses no template literals. */
const SCRIPT = String.raw`
var D = JSON.parse(document.getElementById('data').textContent);
var C = D.colors;
var FONT = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
function fmt(v) {
  var a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v % 1 === 0 ? String(v) : v.toFixed(2);
}
function money(v) { return '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2)); }
function setup(id) {
  var cv = document.getElementById(id);
  var dpr = window.devicePixelRatio || 1;
  var w = cv.clientWidth, h = cv.clientHeight;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  var g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.font = FONT; g.textBaseline = 'middle';
  return { g: g, w: w, h: h };
}
function nodata(c) { c.g.fillStyle = C.dim; c.g.textAlign = 'center'; c.g.fillText('NO DATA', c.w / 2, c.h / 2); }
function hbars(id, labels, values, fmtFn, colors) {
  var c = setup(id), g = c.g;
  var max = Math.max.apply(null, values.concat([0]));
  if (!labels.length || !(max > 0)) return nodata(c);
  var lw = 0; labels.forEach(function (l) { lw = Math.max(lw, g.measureText(l).width); });
  lw = Math.min(lw, c.w * 0.38) + 8;
  var rowH = Math.min(26, (c.h - 4) / labels.length);
  labels.forEach(function (l, i) {
    var y = 2 + i * rowH + rowH / 2;
    g.textAlign = 'left'; g.fillStyle = C.text;
    var t = l; while (t.length > 3 && g.measureText(t).width > lw - 8) t = t.slice(0, -2);
    if (t !== l) t += '…';
    g.fillText(t, 0, y);
    var bw = Math.max(1, (c.w - lw - 70) * values[i] / max);
    g.fillStyle = colors ? colors[i % colors.length] : C.series[0];
    g.fillRect(lw, y - rowH * 0.32, bw, rowH * 0.64);
    g.fillStyle = C.dim; g.fillText((fmtFn || fmt)(values[i]), lw + bw + 6, y);
  });
}
function axisY(c, max, left, bottom, money_) {
  var g = c.g; g.textAlign = 'right'; g.fillStyle = C.dim;
  [0, 0.5, 1].forEach(function (t) {
    var y = c.h - bottom - t * (c.h - bottom - 8);
    g.fillText(money_ ? money(max * t) : fmt(max * t), left - 6, y);
    g.strokeStyle = C.faint; g.beginPath(); g.moveTo(left, y); g.lineTo(c.w, y); g.stroke();
  });
}
function stacked(id, labels, stacks, colors, money_, pct) {
  var c = setup(id), g = c.g, n = labels.length;
  var totals = labels.map(function (_, i) { return stacks.reduce(function (a, s) { return a + s[i]; }, 0); });
  var max = pct ? 1 : Math.max.apply(null, totals.concat([0]));
  if (!n || !(max > 0)) return nodata(c);
  var left = 54, bottom = 20, pw = c.w - left, bw = Math.max(1, pw / n);
  axisY(c, max, left, bottom, money_);
  labels.forEach(function (l, i) {
    var y = c.h - bottom, tot = pct ? (totals[i] || 1) : 1;
    stacks.forEach(function (s, k) {
      var hh = (s[i] / tot / (pct ? 1 : max)) * (c.h - bottom - 8);
      g.fillStyle = colors[k % colors.length];
      g.fillRect(left + i * bw + 1, y - hh, Math.max(1, bw - 2), hh);
      y -= hh;
    });
  });
  g.fillStyle = C.dim; g.textAlign = 'center';
  var step = Math.max(1, Math.ceil(n / Math.floor(pw / 60)));
  labels.forEach(function (l, i) { if (i % step === 0) g.fillText(l, left + i * bw + bw / 2, c.h - 8); });
}
function line(id, labels, values, color, money_, ymax) {
  var c = setup(id), g = c.g, n = values.length;
  var max = ymax || Math.max.apply(null, values.concat([0]));
  if (n < 2 || !(max > 0)) return nodata(c);
  var left = 54, bottom = 20, pw = c.w - left;
  axisY(c, max, left, bottom, money_);
  var X = function (i) { return left + i * pw / (n - 1); };
  var Y = function (v) { return c.h - bottom - v / max * (c.h - bottom - 8); };
  g.beginPath(); g.moveTo(X(0), c.h - bottom);
  values.forEach(function (v, i) { g.lineTo(X(i), Y(v)); });
  g.lineTo(X(n - 1), c.h - bottom); g.closePath();
  g.globalAlpha = 0.18; g.fillStyle = color; g.fill(); g.globalAlpha = 1;
  g.beginPath(); values.forEach(function (v, i) { if (i) g.lineTo(X(i), Y(v)); else g.moveTo(X(i), Y(v)); });
  g.strokeStyle = color; g.lineWidth = 2; g.stroke(); g.lineWidth = 1;
  g.fillStyle = C.dim; g.textAlign = 'center';
  [0, Math.floor((n - 1) / 2), n - 1].forEach(function (i) { g.fillText(labels[i], Math.min(c.w - 30, Math.max(left + 30, X(i))), c.h - 8); });
}
function heat(id, rows, cols, fn, rowLabels, colLabels) {
  var c = setup(id), g = c.g, left = 40, top = 16;
  var max = 0; for (var r = 0; r < rows; r++) for (var k = 0; k < cols; k++) max = Math.max(max, fn(r, k));
  if (!(max > 0)) return nodata(c);
  var cw = (c.w - left) / cols, ch = (c.h - top) / rows;
  for (r = 0; r < rows; r++) {
    g.fillStyle = C.dim; g.textAlign = 'right'; g.fillText(rowLabels[r] || '', left - 6, top + r * ch + ch / 2);
    for (k = 0; k < cols; k++) {
      var v = fn(r, k); if (v < 0) continue;
      g.fillStyle = C.ramp[Math.round(v / max * (C.ramp.length - 1))];
      g.fillRect(left + k * cw + 1, top + r * ch + 1, cw - 2, ch - 2);
    }
  }
  g.fillStyle = C.dim; g.textAlign = 'center';
  colLabels.forEach(function (l, k) { if (l) g.fillText(l, left + k * cw + cw / 2, 7); });
}
function dstr(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
function calendar(id, map) {
  var weeks = 53, end = new Date(); end.setHours(0, 0, 0, 0);
  var mon = new Date(end); mon.setDate(end.getDate() - ((end.getDay() + 6) % 7));
  var cols = [];
  for (var w = 0; w < weeks; w++) { var col = []; for (var r = 0; r < 7; r++) { var d = new Date(mon); d.setDate(mon.getDate() - (weeks - 1 - w) * 7 + r); col.push(d > end ? null : d); } cols.push(col); }
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  heat(id, 7, weeks, function (r, k) { var d = cols[k][r]; return d ? (map[dstr(d)] || 0) : -1; },
    ['Mon', '', 'Wed', '', 'Fri', '', ''],
    cols.map(function (col, k) { return k === 0 || col[0].getMonth() !== cols[k - 1][0].getMonth() ? months[col[0].getMonth()] : ''; }));
}
function draw() {
  var dl = D.daily.map(function (d) { return d.d.slice(5); });
  stacked('c-tokens', dl, [D.daily.map(function (d) { return d.input; }), D.daily.map(function (d) { return d.cacheRead; }), D.daily.map(function (d) { return d.cacheWrite; }), D.daily.map(function (d) { return d.output; })], C.series);
  var tok = {}; D.daily.forEach(function (d) { tok[d.d] = d.input + d.output + d.cacheRead + d.cacheWrite; });
  calendar('c-calendar', tok);
  var wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  heat('c-punch', 7, 24, function (r, k) { return D.punch[r][k]; }, wd, D.punch[0].map(function (_, k) { return k % 6 === 0 ? String(k) : ''; }));
  stacked('c-hours', D.hours.map(function (_, k) { return String(k); }), [D.hours], [C.series[0]]);
  line('c-cum', D.cumulative.map(function (c) { return c.day.slice(5); }), D.cumulative.map(function (c) { return c.cost; }), C.series[0], true);
  stacked('c-daycost', dl, [D.daily.map(function (d) { return d.cost; })], [C.series[1]], true);
  hbars('c-models', D.models.map(function (m) { return m.model; }), D.models.map(function (m) { return m.calls; }), fmt, C.series);
  stacked('c-modelweek', D.weekly.weeks.map(function (w) { return w.slice(5); }), D.weekly.models.map(function (_, mi) { return D.weekly.calls.map(function (row) { return row[mi]; }); }), C.series, false, true);
  hbars('c-tools', D.tools.map(function (t) { return t.tool; }), D.tools.map(function (t) { return t.calls; }), fmt, C.series);
  hbars('c-toolerr', D.tools.filter(function (t) { return t.errors > 0; }).map(function (t) { return t.tool; }), D.tools.filter(function (t) { return t.errors > 0; }).map(function (t) { return t.errors; }), fmt, [C.err]);
  hbars('c-files', D.files.map(function (f) { return f.path; }), D.files.map(function (f) { return f.edit + f.write; }), fmt, C.series);
  hbars('c-langs', D.langs.map(function (l) { return l.ext; }), D.langs.map(function (l) { return l.count; }), fmt, C.series);
  hbars('c-proj', D.projects.map(function (p) { return p.name; }), D.projects.map(function (p) { return p.cost; }), money, C.series);
  hbars('c-projsess', D.projects.map(function (p) { return p.name; }), D.projects.map(function (p) { return p.sessions; }), fmt, C.series);
  stacked('c-tpt', D.toolsPerTurn.labels, [D.toolsPerTurn.counts], [C.series[2]]);
}
window.addEventListener('load', draw);
window.addEventListener('resize', draw);
`;

const CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; background: var(--bg); color: var(--text); font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
h1 { margin: 0 0 4px; font-size: 22px; color: var(--strong); letter-spacing: 2px; }
h2 { margin: 36px 0 12px; font-size: 15px; letter-spacing: 2px; color: var(--title); border-bottom: 1px solid var(--faint); padding-bottom: 4px; }
h3 { margin: 12px 0 6px; font-size: 12px; color: var(--dim); letter-spacing: 1px; font-weight: normal; }
.sub { color: var(--dim); margin-bottom: 18px; }
.grid { display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); }
.kpis { display: flex; flex-wrap: wrap; gap: 14px; margin: 14px 0; }
.kpi { background: var(--panel); border: 1px solid var(--faint); padding: 10px 16px; min-width: 150px; }
.kpi b { display: block; font-size: 24px; color: var(--strong); }
.kpi span { color: var(--dim); font-size: 11px; letter-spacing: 1px; }
.panel { background: var(--panel); border: 1px solid var(--faint); padding: 10px 14px 14px; }
canvas { width: 100%; display: block; }
table { border-collapse: collapse; width: 100%; }
td { padding: 2px 10px 2px 0; vertical-align: top; }
td:first-child { color: var(--strong); white-space: nowrap; }
.words span { display: inline-block; margin: 0 14px 4px 0; }
`;

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * Write a self-contained HTML report (inline CSS, data embedded as JSON, charts drawn on plain
 * <canvas> elements by the script above) for `records` over `range`. One section per Analytics
 * sub-page with its main charts. Colours come from the current theme palette.
 */
export function writeHtmlReport(records: SessionRecord[], range: { from: number; to: number }, config: HomeConfig, outPath: string): void {
	const pal = makePalette(loadThemeColors(), detectCaps({ ...process.env, PI_HOME_TIER: undefined }, "truecolor", false));
	const daily = dailySeries(records, range);
	const keys = [...daily.keys()].sort();
	const days = keys.map((k) => {
		const d = daily.get(k)!;
		return { d: k, input: d.input, output: d.output, cacheRead: d.cacheRead, cacheWrite: d.cacheWrite, cost: d.cost + d.warmCost, minutes: d.activeMinutes, sessions: d.sessions.size, turns: d.userTurns };
	});
	const sum = (f: (d: (typeof days)[number]) => number): number => days.reduce((a, d) => a + f(d), 0);
	const ids = new Set<string>();
	for (const d of daily.values()) for (const id of d.sessions) ids.add(id);
	const tokens = sum((d) => d.input + d.output + d.cacheRead + d.cacheWrite);
	const cost = costStats(records, range);
	const models = modelStats(records, range);
	const files = fileStats(records);
	const user = userStats(records, range);
	const words = topCounts(records, "words").slice(0, 40);
	const runs = longestRuns(records, 8);
	const buckets = [
		{ label: "0", max: 1 },
		{ label: "1", max: 2 },
		{ label: "2", max: 3 },
		{ label: "3-4", max: 5 },
		{ label: "5-9", max: 10 },
		{ label: "10-19", max: 20 },
		{ label: "20+", max: Number.POSITIVE_INFINITY },
	];
	const counts = buckets.map(() => 0);
	for (const n of user.toolsPerTurn) counts[buckets.findIndex((b) => n < b.max)]!++;
	const weekly = modelWeekly(records, range);
	const topModels = weekly.models.slice(0, 6);
	const data = {
		colors: {
			series: pal.seriesColors.map(toHex),
			ramp: Array.from({ length: 9 }, (_, i) => toHex(pal.ramp(i / 8))),
			dim: toHex(pal.p45),
			text: toHex(pal.p100),
			faint: toHex(pal.p25),
			err: toHex(pal.err),
		},
		daily: days,
		punch: hourWeekday(records, range),
		hours: hourOfDay(records, range),
		cumulative: cost.cumulative,
		models: models.slice(0, 12).map((m) => ({ model: m.model, calls: m.calls, cost: m.cost, tps: median(m.tps) })),
		weekly: { weeks: weekly.weeks, models: topModels, calls: weekly.calls.map((row) => row.slice(0, 6)) },
		tools: toolStats(records, range).slice(0, 15).map((t) => ({ tool: t.tool, calls: t.calls, errors: t.errors })),
		files: files.files.slice(0, 15).map((f) => ({ path: f.path.split("/").slice(-2).join("/"), edit: f.edit, write: f.write, read: f.read })),
		langs: files.languages.slice(0, 10),
		projects: projectStats(records, range).slice(0, 15).map((p) => ({ name: p.name, cost: p.cost, sessions: p.sessions })),
		toolsPerTurn: { labels: buckets.map((b) => b.label), counts },
	};
	const json = JSON.stringify(data).replace(/</g, "\\u003c");
	const rangeText = `${range.from > 0 ? fmtDate(range.from) : "start"} to ${fmtDate(Math.min(Date.now(), Number.isFinite(range.to) ? range.to : Date.now()))}`;
	const kpi = (label: string, value: string): string => `<div class="kpi"><b>${esc(value)}</b><span>${label}</span></div>`;
	const books = tokens / Math.max(1, config.analytics.bookTokens);
	const coffees = cost.total / Math.max(0.01, config.analytics.coffeePrice);
	const canvas = (id: string, title: string, h = 240): string => `<div class="panel"><h3>${title}</h3>\n<canvas id="${id}" style="height:${h}px"></canvas>\n</div>`;
	const css = `:root { --bg:${toHex(pal.screenBg)}; --panel:${toHex(pal.panelBg)}; --text:${toHex(pal.p100)}; --dim:${toHex(pal.p45)}; --faint:${toHex(pal.p25)}; --title:${toHex(pal.p70)}; --strong:${toHex(pal.strong.fg ?? pal.p100)}; }${CSS}`;
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>pi-home report</title>
<style>${css}</style>
</head>
<body>
<h1>PI.HOME REPORT</h1>
<div class="sub">${esc(rangeText)} &middot; ${records.length} sessions in range &middot; generated ${esc(new Date().toISOString().slice(0, 16).replace("T", " "))}</div>

<h2>OVERVIEW</h2>
<div class="kpis">${kpi("SESSIONS", String(ids.size))}${kpi("TURNS", String(sum((d) => d.turns)))}${kpi("TOKENS", `${(tokens / 1e6).toFixed(1)}M`)}${kpi("COST", `$${cost.total.toFixed(2)}`)}${kpi("ACTIVE HOURS", (sum((d) => d.minutes) / 60).toFixed(1))}</div>
<div class="grid">
${canvas("c-tokens", "TOKENS PER DAY (input, cache read, cache write, output)")}
${canvas("c-calendar", "ACTIVITY CALENDAR (tokens per day, last 53 weeks)", 170)}
</div>

<h2>TIME</h2>
<div class="grid">
${canvas("c-punch", "PUNCH CARD (weekday x hour)", 200)}
${canvas("c-hours", "CALLS BY HOUR OF DAY", 200)}
</div>

<h2>COST</h2>
<div class="sub">${esc(`~${Math.round(books).toLocaleString("en-US")} books of ${config.analytics.bookTokens.toLocaleString("en-US")} tokens, ~${Math.round(coffees).toLocaleString("en-US")} coffees at $${config.analytics.coffeePrice}`)}</div>
<div class="grid">
${canvas("c-cum", "CUMULATIVE COST")}
${canvas("c-daycost", "DAILY COST")}
</div>

<h2>MODELS</h2>
<div class="grid">
${canvas("c-models", "CALLS BY MODEL", 300)}
${canvas("c-modelweek", `WEEKLY SHARE (${esc(topModels.join(", "))})`, 300)}
</div>

<h2>TOOLS</h2>
<div class="grid">
${canvas("c-tools", "TOOL CALLS", 340)}
${canvas("c-toolerr", "TOOL ERRORS", 340)}
</div>

<h2>FILES</h2>
<div class="grid">
${canvas("c-files", "MOST EDITED FILES (edit + write)", 340)}
${canvas("c-langs", "EDITED FILE TYPES", 300)}
</div>

<h2>PROJECTS</h2>
<div class="grid">
${canvas("c-proj", "COST BY PROJECT", 340)}
${canvas("c-projsess", "SESSIONS BY PROJECT", 340)}
</div>

<h2>BEHAVIOUR</h2>
<div class="grid">
${canvas("c-tpt", "TOOL RESULTS PER USER MESSAGE", 220)}
<div class="panel"><h3>YOUR WORDS</h3><div class="words">${words.map((w, i) => `<span style="font-size:${Math.round(12 + 14 * (w.count / (words[0]?.count ?? 1)))}px;color:${toHex(pal.series(i % 3))}">${esc(w.key)}</span>`).join("")}</div>
<h3>LONGEST RUNS</h3><table>${runs.map((r) => `<tr><td>${Math.floor(r.ms / 3_600_000)}h ${String(Math.floor((r.ms % 3_600_000) / 60_000)).padStart(2, "0")}m</td><td>${esc((r.prompt || r.title).slice(0, 120))}</td></tr>`).join("")}</table></div>
</div>

<script id="data" type="application/json">${json}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, html, "utf8");
}
