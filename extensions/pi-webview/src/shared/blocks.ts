/**
 * Context blocks are the tagged sections a feature module prepends to a user message
 * (<browser-context>, <video-context>, <follow-up>). Each module registers how to strip its
 * blocks (to recover the question the user typed) and how to fold them for the terminal.
 */
export interface ContextBlockCodec {
  /** Remove this module's blocks from a message. */
  strip(text: string): string;
  /** Display-only: replace this module's blocks with compact quoted lines. */
  fold(markdown: string): string;
}

// Keyed by name so a module that registers again after /reload replaces its codec.
const codecs = new Map<string, ContextBlockCodec>();

export function registerContextBlock(name: string, codec: ContextBlockCodec): void {
  codecs.set(name, codec);
}

/** Attribute value safe inside double quotes: '"' never appears, whitespace collapses. */
export const attr = (v: string | number) => String(v).replace(/"/g, "'").replace(/\s+/g, " ");

export function attrOf(attrs: string, key: string): string | undefined {
  return new RegExp(`\\b${key}="([^"]*)"`).exec(attrs)?.[1];
}

export function composeMessage(blocks: string[], question: string): string {
  return [...blocks, question].filter(Boolean).join("\n\n");
}

const FOLLOW_UP_RE = /<follow-up((?:\s+[\w-]+="[^"]*")*)\s*>([\s\S]*?)<\/follow-up>/g;
const followUpBody = (v: string) => v.replace(/<\/?follow-up/gi, (m) => m.replace("<", "‹"));

function answerExcerpt(parts: readonly string[], maxChars = 150): string {
  const joined = parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!joined) return "";
  return joined.length > maxChars ? `${joined.slice(0, maxChars).trimEnd()}…` : joined;
}

/** Build a compact follow-up anchor referencing an earlier turn by number, question, and answer opening. */
export function buildFollowUpBlock(seq: number, prevQuestion: string, prevParts: readonly string[]): string {
  const lines = [`<follow-up ref="#${seq}">`];
  const q = prevQuestion.replace(/\s+/g, " ").trim();
  if (q) lines.push(`<previous-question>${followUpBody(q.slice(0, 400))}</previous-question>`);
  const excerpt = answerExcerpt(prevParts, 150);
  if (excerpt) lines.push(`<previous-answer>${followUpBody(excerpt)}</previous-answer>`);
  lines.push("</follow-up>");
  return lines.join("\n");
}

export function parseFollowUpSeq(text: string): number | undefined {
  const m = /<follow-up\b[^>]*\bref="#(\d+)"[^>]*>/.exec(text);
  const n = m ? Number(m[1]) : 0;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The message text with every registered block and follow-up removed: what the user actually asked. */
export function stripContextBlocks(text: string): string {
  let out = text;
  for (const c of codecs.values()) out = c.strip(out);
  return out.replace(FOLLOW_UP_RE, "").trim();
}

/** Display-only: fold every registered block and follow-up in a user message into quoted lines. */
export function foldContextBlocks(markdown: string): string {
  let out = markdown;
  for (const c of codecs.values()) out = c.fold(out);
  if (out.includes("<follow-up")) {
    out = out.replace(FOLLOW_UP_RE, (_m, attrs: string, inner: string) => {
      const ref = attrOf(attrs, "ref") ?? "";
      const pq = /<previous-question>([\s\S]*?)<\/previous-question>/.exec(inner)?.[1]?.replace(/\s+/g, " ").trim();
      return `> ↳ ${ref}${pq ? ` — “${pq.slice(0, 72)}${pq.length > 72 ? "…" : ""}”` : ""}`;
    });
  }
  return out;
}
