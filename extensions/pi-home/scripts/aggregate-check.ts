// Dev tool: runs every aggregate over the cached index (range "all") and prints sanity numbers.
// Usage: node scripts/aggregate-check.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as A from "../src/index/aggregate.ts";
import type { IndexFile } from "../src/index/types.ts";

const index = JSON.parse(readFileSync(join(homedir(), ".pi/agent/pi-home/index.json"), "utf8")) as IndexFile;
const records = Object.values(index.records);
const all = { from: 0, to: Number.POSITIVE_INFINITY };
const now = Date.now();
const time = <T>(name: string, fn: () => T): T => {
	const t0 = performance.now();
	const v = fn();
	console.log(`  ${name.padEnd(18)} ${(performance.now() - t0).toFixed(1)} ms`);
	return v;
};

console.log(`records: ${records.length}`);
const daily = time("dailySeries", () => A.dailySeries(records, all));
time("hourWeekday", () => A.hourWeekday(records, all));
time("hourOfDay", () => A.hourOfDay(records, all));
const streak = time("streaks", () => A.streaks(daily));
const models = time("modelStats", () => A.modelStats(records, all));
time("modelWeekly", () => A.modelWeekly(records, all));
const switches = time("modelSwitches", () => A.modelSwitches(records, all));
const thinking = time("thinkingStats", () => A.thinkingStats(records, all));
const tools = time("toolStats", () => A.toolStats(records, all));
const trans = time("toolTransitions", () => A.toolTransitions(records, all));
const dna = time("toolDna", () => A.toolDna(records, 30));
const words = time("topCounts(words)", () => A.topCounts(records, "words"));
for (const f of ["bashCmds", "gitSubs", "codeLangs", "customTypes", "skills"] as const) time(`topCounts(${f})`, () => A.topCounts(records, f));
const files = time("fileStats", () => A.fileStats(records));
const ftl = time("fileTimeline", () => A.fileTimeline(records, all));
const projects = time("projectStats", () => A.projectStats(records, all));
const user = time("userStats", () => A.userStats(records, all));
const cost = time("costStats", () => A.costStats(records, all));
const bud = time("budget", () => A.budget(records, 100, now));
const runs = time("longestRuns", () => A.longestRuns(records, 5));
const sub = time("subagentTree", () => A.subagentTree(records));

const sumCost = records.reduce((a, r) => a + r.cost + r.warmCost, 0);
const callsDaily = [...daily.values()].reduce((a, d) => a + d.calls, 0);
const callsRec = records.reduce((a, r) => a + r.assistantMessages, 0);
console.log(`\ncostStats.total = ${cost.total.toFixed(4)}  sum(cost+warmCost) = ${sumCost.toFixed(4)}  diff = ${Math.abs(cost.total - sumCost).toFixed(6)} ${Math.abs(cost.total - sumCost) < 0.01 ? "OK" : "MISMATCH"}`);
console.log(`dailySeries calls = ${callsDaily}  sum(assistantMessages) = ${callsRec} ${callsDaily === callsRec ? "OK" : "MISMATCH"}`);
console.log(`streaks ${JSON.stringify(streak)}  milestones ${JSON.stringify(cost.milestones)}`);
console.log("top 5 toolStats:", tools.slice(0, 5).map((t) => `${t.tool}=${t.calls}(${t.errors} err,${t.source})`).join("  "));
console.log("top 5 modelStats:", models.slice(0, 5).map((m) => `${m.model}=${m.calls} $${m.cost.toFixed(2)}`).join("  "));
console.log("top 5 words:", words.slice(0, 5).map((w) => `${w.key}=${w.count}`).join("  "));
console.log("thinking:", thinking.map((t) => `${t.level}=${t.calls}`).join(" "), "| switches:", switches.slice(0, 3).map((s) => `${s.from}->${s.to}=${s.value}`).join("  "));
console.log(`transitions tools=${trans.tools.length} dna rows=${dna.rows.length}/${dna.names.length} names; files=${files.files.length} langs=${files.languages.slice(0, 3).map((l) => l.ext)} fileTimeline ${ftl.files.length}x${ftl.days.length}`);
console.log(`projects=${projects.length} user.messages=${user.messages} hanRatio=${user.hanRatio.toFixed(2)} toolsPerTurn=${user.toolsPerTurn.length} budget=${JSON.stringify(bud)} runs=${runs.length} subagent roots=${sub.length}`);
