import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import {
	type FileStat,
	type SessionEvents,
	type SessionRecord,
	USER_FLAG_BROWSER,
	USER_FLAG_IMAGE,
	USER_FLAG_POLITE,
	USER_FLAG_RUSH,
	USER_FLAG_SKILL,
} from "./types.ts";

export interface ParseOptions {
	politeWords: string[];
	rushWords: string[];
}

const ACTIVE_GAP_MS = 5 * 60_000;
const MAX_FILES = 300;
const MAX_WORDS = 80;
const WORD_TEXT_LIMIT = 4000;

const STOP_WORDS = new Set(
	(
		"the and for that this with you are was have not but can will from what all your has its into then them than " +
		"一下 一个 这个 那个 我们 你们 他们 就是 还是 或者 以及 然后 因为 所以 但是 如果 可以 需要 现在 已经 没有 不是 什么 怎么 这样 那样 这些 那些 进行 一些 自己 时候 的话 应该 能够 不要 比如 而且 其实 还有 之后 之前 里面 上面 下面 这里 那里 部分 方面"
	).split(" "),
);

const wordSegmenter = new Intl.Segmenter("zh", { granularity: "word" });
const HAN = /\p{Script=Han}/u;

function emptyEvents(): SessionEvents {
	return {
		dict: [],
		cT: [],
		cDur: [],
		cIn: [],
		cOut: [],
		cCR: [],
		cCW: [],
		cRsn: [],
		cCost: [],
		cModel: [],
		cThink: [],
		cStop: [],
		cTools: [],
		cText: [],
		cThinkLen: [],
		tT: [],
		tTool: [],
		tDur: [],
		tErr: [],
		tLen: [],
		uT: [],
		uLen: [],
		uHan: [],
		uImg: [],
		uFlags: [],
		eT: [],
		eKind: [],
		eVal: [],
		dT: [],
		dAdd: [],
		dDel: [],
		dFile: [],
	};
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const ts = (v: unknown): number => {
	if (typeof v === "number") return v;
	if (typeof v === "string") {
		const t = Date.parse(v);
		return Number.isFinite(t) ? t : 0;
	}
	return 0;
};

function inc(map: Record<string, number>, key: string, by = 1): void {
	map[key] = (map[key] ?? 0) + by;
}

function topN(map: Record<string, number>, n: number): Record<string, number> {
	const entries = Object.entries(map);
	if (entries.length <= n) return map;
	entries.sort((a, b) => b[1] - a[1]);
	return Object.fromEntries(entries.slice(0, n));
}

function lineCount(s: unknown): number {
	if (typeof s !== "string" || s.length === 0) return 0;
	let n = 1;
	for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
	return n;
}

interface Block {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

function textOf(content: unknown): { text: string; images: number } {
	if (typeof content === "string") return { text: content, images: 0 };
	if (!Array.isArray(content)) return { text: "", images: 0 };
	let text = "";
	let images = 0;
	for (const b of content as Block[]) {
		if (b?.type === "text" && typeof b.text === "string") text += (text ? "\n" : "") + b.text;
		else if (b?.type === "image") images++;
	}
	return { text, images };
}

/** Parse one session .jsonl file into a SessionRecord. Malformed lines are counted and skipped. */
export async function parseSessionFile(
	file: string,
	stat: { size: number; mtimeMs: number },
	opts: ParseOptions,
): Promise<SessionRecord> {
	const ev = emptyEvents();
	const dictIdx = new Map<string, number>();
	const d = (s: string): number => {
		let i = dictIdx.get(s);
		if (i === undefined) {
			i = ev.dict.length;
			ev.dict.push(s);
			dictIdx.set(s, i);
		}
		return i;
	};

	const rec: SessionRecord = {
		file,
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		id: "",
		cwd: "",
		created: 0,
		parentSession: null,
		name: null,
		firstUserMessage: "",
		lastActivity: 0,
		isSubagent: false,
		badLines: 0,
		userTurns: 0,
		assistantMessages: 0,
		toolCalls: 0,
		errors: 0,
		aborted: 0,
		truncated: 0,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
		cost: 0,
		warmCost: 0,
		warmCount: 0,
		models: {},
		tools: {},
		files: {},
		compactions: 0,
		branches: 0,
		activeMinutes: 0,
		maxContext: 0,
		profile: null,
		customTypes: {},
		bashCmds: {},
		gitSubs: {},
		codeLangs: {},
		words: {},
		skills: {},
		politeCount: 0,
		rushCount: 0,
		editAdd: 0,
		editDel: 0,
		longestRunMs: 0,
		longestRunPrompt: "",
		ev,
	};

	const politeWords = opts.politeWords.map((w) => w.toLowerCase());
	const rushWords = opts.rushWords.map((w) => w.toLowerCase());
	const childCount = new Map<string, number>();
	const times: number[] = [];
	const files: Record<string, FileStat> = {};
	let currentModel = "";
	let currentThinking = "";

	const fileStat = (p: string): FileStat => {
		let f = files[p];
		if (!f) {
			f = { read: 0, edit: 0, write: 0 };
			files[p] = f;
		}
		return f;
	};

	const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
	let first = true;
	for await (const line of rl) {
		if (!line) continue;
		let e: Record<string, unknown>;
		try {
			e = JSON.parse(line) as Record<string, unknown>;
		} catch {
			rec.badLines++;
			continue;
		}
		const type = e.type;
		const t = ts(e.timestamp);
		if (t) times.push(t);
		if (first) {
			first = false;
			if (type === "session") {
				rec.id = String(e.id ?? "");
				rec.cwd = String(e.cwd ?? "");
				rec.created = t;
				rec.parentSession = typeof e.parentSession === "string" ? e.parentSession : null;
				continue;
			}
		}
		if (typeof e.parentId === "string") childCount.set(e.parentId, (childCount.get(e.parentId) ?? 0) + 1);

		switch (type) {
			case "message": {
				const m = (e.message ?? {}) as Record<string, unknown>;
				const role = m.role;
				const mt = ts(m.timestamp) || t;
				if (role === "assistant") {
					const u = (m.usage ?? {}) as Record<string, unknown>;
					const cost = num((u.cost as Record<string, unknown> | undefined)?.total);
					const input = num(u.input);
					const output = num(u.output);
					const cr = num(u.cacheRead);
					const cw = num(u.cacheWrite);
					const rsn = num(u.reasoning);
					const model = `${String(m.provider ?? "?")}/${String(m.model ?? "?")}`;
					const stop = String(m.stopReason ?? "");
					const dur = typeof m.durationMs === "number" ? m.durationMs : -1;
					let toolCount = 0;
					let textLen = 0;
					let thinkLen = 0;
					if (Array.isArray(m.content)) {
						for (const b of m.content as Block[]) {
							if (b?.type === "text" && typeof b.text === "string") {
								textLen += b.text.length;
								for (const match of b.text.matchAll(/```([A-Za-z0-9_+#.-]+)/g)) inc(rec.codeLangs, match[1]!.toLowerCase());
							} else if (b?.type === "thinking" && typeof b.thinking === "string") {
								thinkLen += b.thinking.length;
							} else if (b?.type === "toolCall") {
								toolCount++;
								handleToolCall(b, mt);
							}
						}
					}
					rec.assistantMessages++;
					rec.toolCalls += toolCount;
					rec.tokens.input += input;
					rec.tokens.output += output;
					rec.tokens.cacheRead += cr;
					rec.tokens.cacheWrite += cw;
					rec.tokens.reasoning += rsn;
					rec.cost += cost;
					rec.maxContext = Math.max(rec.maxContext, input + cr + cw);
					if (stop === "error") rec.errors++;
					else if (stop === "aborted") rec.aborted++;
					else if (stop === "length") rec.truncated++;
					const ms = (rec.models[model] ??= {
						calls: 0,
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
						ms: 0,
						errors: 0,
					});
					ms.calls++;
					ms.input += input;
					ms.output += output;
					ms.cacheRead += cr;
					ms.cacheWrite += cw;
					ms.cost += cost;
					if (dur > 0) ms.ms += dur;
					if (stop === "error" || stop === "aborted") ms.errors++;
					const think = typeof m.thinkingLevel === "string" ? m.thinkingLevel : currentThinking;
					ev.cT.push(mt);
					ev.cDur.push(dur);
					ev.cIn.push(input);
					ev.cOut.push(output);
					ev.cCR.push(cr);
					ev.cCW.push(cw);
					ev.cRsn.push(rsn);
					ev.cCost.push(cost);
					ev.cModel.push(d(model));
					ev.cThink.push(d(think));
					ev.cStop.push(d(stop));
					ev.cTools.push(toolCount);
					ev.cText.push(textLen);
					ev.cThinkLen.push(thinkLen);
				} else if (role === "toolResult") {
					const name = String(m.toolName ?? "?");
					const isErr = m.isError === true;
					const dur = typeof m.durationMs === "number" ? m.durationMs : -1;
					const ts_ = (rec.tools[name] ??= { calls: 0, errors: 0, ms: 0 });
					ts_.calls++;
					if (isErr) ts_.errors++;
					if (dur > 0) ts_.ms += dur;
					ev.tT.push(mt);
					ev.tTool.push(d(name));
					ev.tDur.push(dur);
					ev.tErr.push(isErr ? 1 : 0);
					ev.tLen.push(textOf(m.content).text.length);
				} else if (role === "user") {
					handleUser(m, mt);
				}
				break;
			}
			case "session_info":
				if (typeof e.name === "string" && e.name.trim()) rec.name = e.name.trim();
				break;
			case "model_change": {
				currentModel = `${String(e.provider ?? "?")}/${String(e.modelId ?? "?")}`;
				pushEvent("model_change", t, d(currentModel));
				break;
			}
			case "thinking_level_change":
				currentThinking = String(e.thinkingLevel ?? "");
				pushEvent("thinking_level_change", t, d(currentThinking));
				break;
			case "compaction":
				rec.compactions++;
				pushEvent("compaction", t, num(e.tokensBefore));
				break;
			case "branch_summary":
				pushEvent("branch_summary", t, 0);
				break;
			case "context_edit":
				pushEvent("context_edit", t, 0);
				break;
			case "usage": {
				if (e.kind === "cache_warm") {
					const cost = num(((e.usage as Record<string, unknown> | undefined)?.cost as Record<string, unknown> | undefined)?.total);
					rec.warmCost += cost;
					rec.warmCount++;
					pushEvent("cache_warm", t, Math.round(cost * 1e6));
				}
				break;
			}
			case "custom":
			case "custom_message": {
				const ct = typeof e.customType === "string" ? e.customType : "?";
				inc(rec.customTypes, ct);
				if (type === "custom" && ct === "pi-home/profile") rec.profile = e.data ?? null;
				if (ct === "run-timer-state") {
					const data = (e.data ?? {}) as Record<string, unknown>;
					const longest = num(data.longestRunDurationMs);
					if (longest > rec.longestRunMs) {
						rec.longestRunMs = longest;
						rec.longestRunPrompt = typeof data.longestRunPrompt === "string" ? data.longestRunPrompt.slice(0, 200) : "";
					}
				}
				break;
			}
		}
	}

	function pushEvent(kind: string, t: number, val: number): void {
		ev.eT.push(t);
		ev.eKind.push(d(kind));
		ev.eVal.push(val);
	}

	function handleToolCall(b: Block, t: number): void {
		const args = (b.arguments ?? {}) as Record<string, unknown>;
		const name = b.name ?? "";
		const path = typeof args.path === "string" ? args.path : undefined;
		if (name === "read" && path) fileStat(path).read++;
		else if (name === "edit" && path) {
			fileStat(path).edit++;
			let add = 0;
			let del = 0;
			const edits = Array.isArray(args.edits) ? (args.edits as Record<string, unknown>[]) : [args];
			for (const ed of edits) {
				const o = lineCount(ed?.oldText);
				const n = lineCount(ed?.newText);
				// Lines replaced count as both removed and added, like a unified diff.
				add += n;
				del += o;
			}
			rec.editAdd += add;
			rec.editDel += del;
			ev.dT.push(t);
			ev.dAdd.push(add);
			ev.dDel.push(del);
			ev.dFile.push(d(path));
		} else if (name === "write" && path) {
			fileStat(path).write++;
			const add = lineCount(args.content);
			rec.editAdd += add;
			ev.dT.push(t);
			ev.dAdd.push(add);
			ev.dDel.push(0);
			ev.dFile.push(d(path));
		} else if (name === "bash" && typeof args.command === "string") {
			const cmd = args.command.trim();
			// First word of the last simple command after cd/&&, e.g. "cd x && git status" → git.
			const parts = cmd.split(/&&|\|\||;|\n/).map((p) => p.trim()).filter(Boolean);
			for (const part of parts) {
				const words = part.split(/\s+/);
				let w = words[0] ?? "";
				let k = 0;
				while ((w === "sudo" || w === "timeout" || /^\w+=/.test(w) || /^\d+$/.test(w)) && k < words.length - 1) w = words[++k] ?? "";
				w = w.replace(/^.*\//, "");
				if (!w || w === "cd" || w.startsWith("#")) continue;
				inc(rec.bashCmds, w);
				if (w === "git" && words[k + 1] && !words[k + 1]!.startsWith("-")) inc(rec.gitSubs, words[k + 1]!);
				else if (w === "git") {
					// git -C dir sub
					const sub = words.slice(k + 1).find((x, i, arr) => !x.startsWith("-") && arr[i - 1] !== "-C");
					if (sub) inc(rec.gitSubs, sub);
				}
			}
		}
	}

	function handleUser(m: Record<string, unknown>, t: number): void {
		const { text, images } = textOf(m.content);
		rec.userTurns++;
		let flags = 0;
		if (text.includes("<browser-context")) flags |= USER_FLAG_BROWSER;
		if (images > 0) flags |= USER_FLAG_IMAGE;
		for (const match of text.matchAll(/<skill name="([^"]+)"|\/skill:([\w.-]+)/g)) {
			flags |= USER_FLAG_SKILL;
			inc(rec.skills, match[1] ?? match[2]!);
		}
		// Strip quoted context blocks before measuring how the user writes.
		const own = text.replace(/<(browser-context|skill)[\s\S]*?<\/\1>/g, " ");
		const lower = own.toLowerCase();
		if (politeWords.some((w) => lower.includes(w))) {
			flags |= USER_FLAG_POLITE;
			rec.politeCount++;
		}
		if (rushWords.some((w) => lower.includes(w))) {
			flags |= USER_FLAG_RUSH;
			rec.rushCount++;
		}
		let han = 0;
		let visible = 0;
		for (const ch of own) {
			if (/\s/.test(ch)) continue;
			visible++;
			if (HAN.test(ch)) han++;
		}
		for (const seg of wordSegmenter.segment(own.slice(0, WORD_TEXT_LIMIT))) {
			if (!seg.isWordLike) continue;
			const w = seg.segment.toLowerCase();
			const isHan = HAN.test(w);
			if ((isHan && w.length < 2) || (!isHan && w.length < 3) || /^\d+$/.test(w) || STOP_WORDS.has(w)) continue;
			inc(rec.words, w);
		}
		if (!rec.firstUserMessage && own.trim()) rec.firstUserMessage = own.replace(/\s+/g, " ").trim().slice(0, 200);
		ev.uT.push(t);
		ev.uLen.push(own.length);
		ev.uHan.push(visible ? Math.round((han / visible) * 100) : 0);
		ev.uImg.push(images);
		ev.uFlags.push(flags);
	}

	rec.files = Object.fromEntries(
		Object.entries(files)
			.sort((a, b) => b[1].read + b[1].edit + b[1].write - (a[1].read + a[1].edit + a[1].write))
			.slice(0, MAX_FILES),
	);
	rec.words = topN(rec.words, MAX_WORDS);
	for (const n of childCount.values()) if (n > 1) rec.branches++;
	times.sort((a, b) => a - b);
	let active = 0;
	for (let i = 1; i < times.length; i++) {
		const gap = times[i]! - times[i - 1]!;
		if (gap > 0 && gap < ACTIVE_GAP_MS) active += gap;
	}
	rec.activeMinutes = Math.round(active / 60_000);
	rec.lastActivity = times.length ? times[times.length - 1]! : rec.created || stat.mtimeMs;
	if (!rec.created) rec.created = times[0] ?? stat.mtimeMs;
	// pi-interactive-subagents names one-shot subagents "<subagent:…>" and team members "<team:…>".
	rec.isSubagent = /^<(subagent|team):/.test(rec.name ?? "");
	return rec;
}
