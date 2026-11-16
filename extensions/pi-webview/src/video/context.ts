import { homedir } from "node:os";
import { attr, attrOf } from "../shared/blocks.ts";
import type { VideoMeta } from "./sites.ts";
import type { Cue } from "./subtitles.ts";

/** Playback position as shown by players: m:ss, or h:mm:ss past an hour. */
export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** "1:02:03", "12:34", "95", "95.5" → seconds. */
export function parseTime(input: string | number): number | undefined {
  if (typeof input === "number") return Number.isFinite(input) && input >= 0 ? input : undefined;
  const parts = input.trim().split(":");
  if (!parts.length || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return undefined;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

// Text inside a block must not close or open our tags.
const body = (v: string) => v.replace(/<\/?(video-context|subtitle)/gi, (m) => m.replace("<", "‹"));
// Page titles go into attributes: no quotes (attr) and no tags.
const vattr = (v: string | number) => attr(v).replace(/</g, "‹");

/**
 * The block sent to the model: where the learner is in which lesson. Subtitle lines are attached
 * only when the question is about them; material paths are never sent (the model finds them itself).
 * `framePath` is a captured frame on disk, named for models that cannot take the image inline.
 */
export function buildVideoBlock(meta: VideoMeta, time: number, cues?: readonly Cue[], framePath?: string): string {
  const home = homedir();
  const frame = framePath?.startsWith(`${home}/`) ? `~${framePath.slice(home.length)}` : framePath;
  const attrs = [
    `site="${meta.site}"`,
    `video="${vattr(meta.key)}"`,
    meta.course ? `course="${vattr(meta.course)}"` : "",
    meta.episode ? `episode="${vattr(meta.total ? `${meta.episode}/${meta.total}` : meta.episode)}"` : "",
    `episode-title="${vattr(meta.episodeTitle)}"`,
    `time="${formatTime(time)}"`,
    frame ? `frame="${vattr(frame)}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (!cues?.length) return `<video-context ${attrs}/>`;
  const from = cues[0]!.start;
  const to = cues.at(-1)!.end;
  const lines = cues.map((c) => `[${formatTime(c.start)}] ${body(c.text.replace(/\s*\n\s*/g, " "))}`);
  return `<video-context ${attrs}>\n<subtitle from="${formatTime(from)}" to="${formatTime(to)}">\n${lines.join("\n")}\n</subtitle>\n</video-context>`;
}

const BLOCK_RE = /<video-context((?:\s+[\w-]+="[^"]*")*)\s*(?:\/>|>([\s\S]*?)<\/video-context>)/g;

export interface VideoRef {
  key: string;
  time: number;
  from?: number;
  to?: number;
  excerpt?: string;
}

/** The video reference of a user message (first block), for placing its thread in the panel. */
export function parseVideoBlock(text: string): VideoRef | undefined {
  if (!text.includes("<video-context")) return undefined;
  for (const m of text.matchAll(BLOCK_RE)) {
    const [, attrs = "", inner = ""] = m;
    const key = attrOf(attrs, "video");
    if (!key) continue;
    const time = parseTime(attrOf(attrs, "time") ?? "") ?? 0;
    const sub = /<subtitle\s+from="([^"]*)"\s+to="([^"]*)"\s*>([\s\S]*?)<\/subtitle>/.exec(inner);
    if (!sub) return { key, time };
    const excerpt = sub[3]!
      .trim()
      .split("\n")
      .map((l) => l.replace(/^\[[\d:]+\]\s*/, ""))
      .join(" ");
    return { key, time, from: parseTime(sub[1]!), to: parseTime(sub[2]!), excerpt };
  }
  return undefined;
}

export function stripVideoBlocks(text: string): string {
  return text.replace(BLOCK_RE, "");
}

/** Display-only: one quoted line per block in the terminal. */
export function foldVideoBlocks(markdown: string): string {
  if (!markdown.includes("<video-context")) return markdown;
  return markdown.replace(BLOCK_RE, (_m, attrs: string, inner: string | undefined) => {
    const course = attrOf(attrs, "course");
    const episode = attrOf(attrs, "episode");
    const title = attrOf(attrs, "episode-title") ?? "";
    const time = attrOf(attrs, "time") ?? "";
    const head = [course, episode ? `E${episode}` : "", title].filter(Boolean).join(" · ");
    const lines = inner
      ? /<subtitle[^>]*>([\s\S]*?)<\/subtitle>/
          .exec(inner)?.[1]
          ?.trim()
          .split("\n")
          .map((l) => l.replace(/^\[[\d:]+\]\s*/, ""))
          .join(" ")
      : undefined;
    const excerpt = lines ? ` — “${lines.slice(0, 72)}${lines.length > 72 ? "…" : ""}”` : "";
    return `> ▶ ${head} @ ${time}${excerpt}`;
  });
}
