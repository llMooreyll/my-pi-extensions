import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

/** One subtitle line as the user prepared it; the extension only displays files, it never re-segments them. */
export interface Cue {
  start: number;
  end: number;
  text: string;
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

const cleanText = (s: string) =>
  s
    .replace(/<\d{1,2}:\d{2}[:.\d]*>/g, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");

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
    const text = cleanText(lines.slice(at + 1).join("\n"));
    if (start === undefined || end === undefined || !text) continue;
    cues.push({ start, end: Math.max(end, start), text });
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
    const text = cleanText(
      values
        .slice(textAt)
        .join(",")
        .replace(/\\[Nn]/g, "\n")
        .replace(/\\h/g, " "),
    );
    if (start === undefined || end === undefined || !text) continue;
    cues.push({ start, end: Math.max(end, start), text });
  }
  return cues;
}

export function parseSubtitles(src: string, path: string): Cue[] {
  const ext = extname(path).toLowerCase();
  const cues = ext === ".ass" || ext === ".ssa" ? parseAss(src) : parseBlocks(src.replace(/^\uFEFF/, ""));
  return cues.sort((a, b) => a.start - b.start);
}

export async function loadSubtitles(path: string): Promise<Cue[]> {
  return parseSubtitles(await readFile(path, "utf8"), path);
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
