import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

/** A piece of a line: plain text, or a base with its annotation (ruby) shown beside it. */
export type RubyPart = string | [base: string, annotation: string];

/** One subtitle line as the user prepared it; the extension only displays files, it never re-segments them. */
export interface Cue {
  start: number;
  end: number;
  /** Plain text, annotations in parentheses after their base: what the model and the terminal see. */
  text: string;
  /** Only for lines with annotations: the pieces the panel lays out as ruby. */
  ruby?: RubyPart[];
}

export const SUBTITLE_EXTS = new Set([".srt", ".vtt", ".ass", ".ssa"]);

export function isSubtitleFile(path: string): boolean {
  return SUBTITLE_EXTS.has(extname(path).toLowerCase());
}

/** "01:02:03,456", "02:03.456", "1:02:03.45" → seconds. */
function clock(s: string): number | undefined {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(s.trim());
  if (!m) return undefined;
  const frac = m[4] ? Number(m[4]) / 10 ** m[4].length : 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

const decodeEntities = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
const stripTags = (s: string) => s.replace(/<\/?[a-z][^>]*>/gi, "");
const piece = (s: string) => decodeEntities(stripTags(s));

const RUBY_RE = /<ruby\b[^>]*>([\s\S]*?)<\/ruby>/gi;

/**
 * The base/annotation pairs of one <ruby> element (WebVTT ruby, accepted in every format):
 * "<ruby>depletion region<rt>耗尽区</rt></ruby>", several pairs in one element, <rp> fallbacks ignored.
 */
function rubyPairs(inner: string): RubyPart[] {
  const parts = inner.replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, "").split(/<rt\b[^>]*>/i);
  const out: RubyPart[] = [];
  let base = parts[0] ?? "";
  for (const p of parts.slice(1)) {
    const end = p.search(/<\/rt>/i);
    const note = piece(end < 0 ? p : p.slice(0, end)).trim();
    const b = piece(base);
    if (note && b.trim()) out.push([b, note]);
    else if (b) out.push(b);
    base = end < 0 ? "" : p.slice(end + 5);
  }
  if (base) out.push(piece(base));
  return out;
}

/**
 * A cue's text as displayed: formatting tags and ASS overrides removed, empty lines dropped, and ruby
 * kept as base/annotation pairs. The plain text writes each annotation in parentheses after its base.
 */
function parseText(raw: string): { text: string; ruby?: RubyPart[] } {
  const src = raw
    .replace(/<\d{1,2}:\d{2}[:.\d]*>/g, "")
    .replace(/<\/?(?!(?:ruby|rt|rp)\b)[a-z][^>]*>/gi, "")
    .replace(/\{\\[^}]*\}/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => stripTags(l).trim())
    .join("\n");
  if (!/<ruby\b/i.test(src)) return { text: piece(src) };
  const ruby: RubyPart[] = [];
  let at = 0;
  for (const m of src.matchAll(RUBY_RE)) {
    if (m.index > at) ruby.push(piece(src.slice(at, m.index)));
    ruby.push(...rubyPairs(m[1] ?? ""));
    at = m.index + m[0].length;
  }
  if (at < src.length) ruby.push(piece(src.slice(at)));
  const parts = ruby.filter((p) => p !== "");
  const text = parts.map((p) => (typeof p === "string" ? p : `${p[0]} (${p[1]})`)).join("");
  return parts.some((p) => typeof p !== "string") ? { text, ruby: parts } : { text };
}

/** SRT and WebVTT: blocks of an optional id, a "start --> end" line and text lines. */
function parseBlocks(src: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of src.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [a = "", rest = ""] = lines[at]!.split("-->");
    const start = clock(a);
    const end = clock(rest.trim().split(/\s+/)[0] ?? "");
    const body = parseText(lines.slice(at + 1).join("\n"));
    if (start === undefined || end === undefined || !body.text) continue;
    cues.push({ start, end: Math.max(end, start), ...body });
  }
  return cues;
}

/** ASS/SSA: Dialogue lines of the [Events] section, fields named by its Format line. */
function parseAss(src: string): Cue[] {
  const cues: Cue[] = [];
  let fields: string[] | undefined;
  let inEvents = false;
  for (const raw of src.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (/^\[.+\]$/.test(line)) {
      inEvents = /^\[events\]$/i.test(line);
      continue;
    }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(line)) {
      fields = line.replace(/^format\s*:/i, "").split(",").map((f) => f.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue\s*:/i.test(line) || !fields) continue;
    const values = line.replace(/^dialogue\s*:/i, "").split(",");
    // Text is the last field and may itself contain commas.
    const textAt = fields.indexOf("text");
    const get = (name: string) => values[fields!.indexOf(name)]?.trim() ?? "";
    const start = clock(get("start"));
    const end = clock(get("end"));
    const body = parseText(
      values
        .slice(textAt)
        .join(",")
        .replace(/\\[Nn]/g, "\n")
        .replace(/\\h/g, " "),
    );
    if (start === undefined || end === undefined || !body.text) continue;
    cues.push({ start, end: Math.max(end, start), ...body });
  }
  return cues;
}

/**
 * Bilingual files often give each language its own entry with the same timing (two ASS styles, or two
 * SRT blocks): such entries become one line with a row per language, in file order. Identical text at
 * the same time (ASS layers drawn twice for an outline effect) is kept once. Text is never changed.
 */
function mergeSameTime(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  const byTime = new Map<string, Cue>();
  for (const c of cues) {
    const key = `${Math.round(c.start * 100)}|${Math.round(c.end * 100)}`;
    const same = byTime.get(key);
    if (!same) {
      const cue = { ...c };
      byTime.set(key, cue);
      out.push(cue);
    } else if (!same.text.split("\n").includes(c.text)) {
      if (same.ruby || c.ruby) same.ruby = [...(same.ruby ?? [same.text]), "\n", ...(c.ruby ?? [c.text])];
      same.text += `\n${c.text}`;
    }
  }
  return out;
}

export function parseSubtitles(src: string, path: string): Cue[] {
  const ext = extname(path).toLowerCase();
  const text = src.replace(/^\uFEFF/, "");
  const cues = ext === ".ass" || ext === ".ssa" ? parseAss(text) : parseBlocks(text);
  return mergeSameTime(cues).sort((a, b) => a.start - b.start);
}

/** UTF-8, UTF-16 with a byte order mark (common for ASS) or, failing UTF-8, GB18030 (covers GBK, common for Chinese files). */
function decodeSubtitle(buf: Uint8Array): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("gb18030").decode(buf);
  }
}

export async function loadSubtitles(path: string): Promise<Cue[]> {
  return parseSubtitles(decodeSubtitle(await readFile(path)), path);
}

const MAX_DEPTH = 8;
const MAX_FILES = 5000;

/** Subtitle files under the working directory, for the panel's subtitle browser. */
export async function findSubtitleFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.isFile() && isSubtitleFile(e.name)) out.push(full);
    }
  };
  await walk(root, 0);
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * A file named after the video (yt-dlp style "Title [id].en.vtt", "BV1xx…_p3.srt") is picked
 * automatically; for multi-part videos the part number must also appear in the name.
 */
export function matchSubtitleFile(files: string[], id: string, part?: number): string | undefined {
  const named = files.filter((f) => basename(f).includes(id));
  if (!part) return named[0];
  const partRe = new RegExp(`(^|[^0-9])p0*${part}([^0-9]|$)`, "i");
  return named.find((f) => partRe.test(basename(f).replace(id, ""))) ?? (named.length === 1 && part === 1 ? named[0] : undefined);
}
