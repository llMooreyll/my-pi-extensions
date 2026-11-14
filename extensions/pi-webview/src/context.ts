import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { type Doc, displayPath, docId, expandPath, pageUnit } from "./docs.ts";

export type Anchor =
  | { kind: "md"; text: string; lines: [number, number]; headings: string[] }
  | { kind: "pdf"; text: string; page: number; context: string; region?: number[]; image?: string }
  | { kind: "html"; text: string; selector: string; tag?: string; outer?: string; hint: { id?: string; classes: string[]; text?: string } };

export interface AskRequest {
  doc: string;
  mode: "ask" | "pin";
  question: string;
  replyTo?: string;
  anchor: Anchor;
}

/** A located reference into a document, as shown in the browser (never carries image data). */
export interface Ref {
  docId: string;
  path: string;
  label: string;
  anchor: Anchor;
}

const MAX_SOURCE_LINES = 80;
const MAX_SOURCE_CHARS = 8000;
const IMAGE_PREFIX = "data:image/png;base64,";

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function posInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

function strList(v: unknown, count: number, max: number): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, count).map((x) => x.slice(0, max)) : [];
}

/** Validate the browser payload; everything from the page is untrusted input. */
export function parseAsk(body: unknown): AskRequest {
  if (!body || typeof body !== "object") throw new Error("Invalid request body");
  const b = body as Record<string, unknown>;
  const doc = str(b.doc, 40);
  const mode = b.mode === "ask" || b.mode === "pin" ? b.mode : undefined;
  const a = b.anchor as Record<string, unknown> | null | undefined;
  if (!doc || !mode || !a || typeof a !== "object") throw new Error("Missing doc, mode or anchor");
  const question = str(b.question, 8000).trim();
  const replyTo = str(b.replyTo, 40).trim() || undefined;
  const text = str(a.text, 6000);

  if (a.kind === "md") {
    const lines = Array.isArray(a.lines) ? a.lines : [];
    const start = posInt(lines[0]);
    if (!start) throw new Error("Markdown reference without a line number");
    const end = Math.max(start, posInt(lines[1]) ?? start);
    return { doc, mode, question, replyTo, anchor: { kind: "md", text, lines: [start, end], headings: strList(a.headings, 6, 160) } };
  }
  if (a.kind === "pdf") {
    const page = posInt(a.page);
    if (!page) throw new Error("PDF reference without a page number");
    const region =
      Array.isArray(a.region) && a.region.length === 4 && a.region.every((n) => typeof n === "number" && n >= 0 && n <= 1)
        ? (a.region as number[])
        : undefined;
    const image = str(a.image, 16_000_000);
    return {
      doc,
      mode,
      question,
      replyTo,
      anchor: { kind: "pdf", text, page, context: str(a.context, 2400), region, image: image.startsWith(IMAGE_PREFIX) ? image : undefined },
    };
  }
  if (a.kind === "html") {
    const selector = str(a.selector, 600);
    if (!selector) throw new Error("HTML reference without a selector");
    const hint = (a.hint && typeof a.hint === "object" ? a.hint : {}) as Record<string, unknown>;
    return {
      doc,
      mode,
      question,
      replyTo,
      anchor: {
        kind: "html",
        text,
        selector,
        tag: str(a.tag, 40) || undefined,
        outer: str(a.outer, 4000) || undefined,
        hint: { id: str(hint.id, 200) || undefined, classes: strList(hint.classes, 8, 80), text: str(hint.text, 120) || undefined },
      },
    };
  }
  throw new Error(`Unknown reference kind: ${String(a.kind)}`);
}

export function imageData(anchor: Anchor): string | undefined {
  return anchor.kind === "pdf" && anchor.image ? anchor.image.slice(IMAGE_PREFIX.length) : undefined;
}

/** The anchor as stored and sent back to pages: without the screenshot. */
export function withoutImage(anchor: Anchor): Anchor {
  if (anchor.kind !== "pdf" || !anchor.image) return anchor;
  const { image: _image, ...rest } = anchor;
  return rest;
}

const attr = (v: string | number) => String(v).replace(/"/g, "'").replace(/\s+/g, " ");
// Page text must not be able to close the block early.
const body = (v: string) => v.replace(/<\/?browser-context/gi, (m) => m.replace("<", "‹"));

function readSourceLines(path: string, start: number, end: number): string | undefined {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    const last = Math.min(end, start + MAX_SOURCE_LINES - 1, lines.length);
    let out = lines.slice(start - 1, last).join("\n");
    if (out.length > MAX_SOURCE_CHARS) out = out.slice(0, MAX_SOURCE_CHARS) + "\n…";
    else if (last < end) out += `\n… (${end - last} more lines not included)`;
    return out;
  } catch {
    return undefined;
  }
}

/** Best-effort source line of a picked element: only a needle that occurs exactly once counts. */
function locateHtml(path: string, hint: { id?: string; classes: string[]; text?: string }): number | undefined {
  let src: string;
  try {
    src = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const needles: string[] = [];
  if (hint.id) needles.push(`id="${hint.id}"`, `id='${hint.id}'`);
  if (hint.classes.length) needles.push(`class="${hint.classes.join(" ")}"`);
  if (hint.text && hint.text.length >= 6) needles.push(hint.text);
  for (const n of needles) {
    const at = src.indexOf(n);
    if (at >= 0 && src.indexOf(n, at + 1) === -1) return src.slice(0, at).split("\n").length;
  }
  return undefined;
}

function shortSelector(selector: string): string {
  return selector.length > 48 ? "…" + selector.slice(-47) : selector;
}

function labelFor(file: string, anchor: Anchor, unit: "page" | "slide", line?: number): string {
  if (anchor.kind === "md") {
    const [s, e] = anchor.lines;
    return `${file} · L${s}${e > s ? `–${e}` : ""}`;
  }
  if (anchor.kind === "pdf") return `${file} · ${unit === "slide" ? "slide " : "p."}${anchor.page}${anchor.region ? " ▭" : ""}`;
  return `${file}${line ? `:${line}` : ""} · ${shortSelector(anchor.selector)}`;
}

export interface BuiltBlock {
  block: string;
  label: string;
}

export function buildBlock(doc: Doc, anchor: Anchor, opts: { cwd?: string; note?: string; imagePath?: string }): BuiltBlock {
  const file = displayPath(doc.path, opts.cwd);
  const unit = doc.kind === "office" ? pageUnit(doc) : "page";
  const parts: string[] = [];
  let head: string;
  let line: number | undefined;

  if (anchor.kind === "md") {
    const [s, e] = anchor.lines;
    head = `<browser-context kind="md" file="${attr(file)}" lines="${s}-${e}">`;
    if (anchor.headings.length) parts.push(`<heading-path>${body(anchor.headings.join(" › "))}</heading-path>`);
    if (anchor.text.trim()) parts.push(`<selection>\n${body(anchor.text.trim())}\n</selection>`);
    const src = readSourceLines(doc.path, s, e);
    if (src !== undefined) parts.push(`<source lines="${s}-${e}">\n${body(src)}\n</source>`);
  } else if (anchor.kind === "pdf") {
    const kind = doc.kind === "office" ? extname(doc.path).slice(1).toLowerCase() : "pdf";
    const region = anchor.region ? ` region="${anchor.region.map((n) => n.toFixed(3)).join(",")}"` : "";
    head = `<browser-context kind="${kind}" file="${attr(file)}" ${unit}="${anchor.page}"${region}>`;
    if (anchor.text.trim()) parts.push(`<selection>\n${body(anchor.text.trim())}\n</selection>`);
    if (anchor.context.trim()) parts.push(`<surrounding>\n${body(anchor.context.trim())}\n</surrounding>`);
    if (anchor.region) {
      parts.push(`<region-note>The user marked a region of this ${unit} (x,y,w,h as fractions of the ${unit})${opts.imagePath ? `; screenshot: ${opts.imagePath}` : ""}</region-note>`);
    }
  } else {
    line = locateHtml(doc.path, anchor.hint);
    head = `<browser-context kind="html" file="${attr(file)}"${line ? ` line="${line}"` : ""} selector="${attr(anchor.selector)}">`;
    if (anchor.text.trim()) parts.push(`<selection>\n${body(anchor.text.trim())}\n</selection>`);
    if (anchor.outer) parts.push(`<element>\n${body(anchor.outer)}\n</element>`);
  }

  if (opts.note) parts.push(`<note>${body(opts.note)}</note>`);
  return { block: `${head}\n${parts.join("\n")}\n</browser-context>`, label: labelFor(file, anchor, unit, line) };
}

export function composeMessage(blocks: string[], question: string): string {
  return [...blocks, question].filter(Boolean).join("\n\n");
}

// Attribute values may contain ">" (CSS selectors), never '"' (see attr()), so match attributes one by one.
const BLOCK_RE = /<browser-context((?:\s+[\w-]+="[^"]*")*)\s*>([\s\S]*?)<\/browser-context>/g;
const FOLLOW_UP_RE = /<follow-up((?:\s+[\w-]+="[^"]*")*)\s*>([\s\S]*?)<\/follow-up>/g;
const followUpBody = (v: string) => v.replace(/<\/?follow-up/gi, (m) => m.replace("<", "‹"));

function attrOf(attrs: string, key: string): string | undefined {
  return new RegExp(`\\b${key}="([^"]*)"`).exec(attrs)?.[1];
}

function selectionOf(inner: string): string {
  return /<selection>\s*([\s\S]*?)\s*<\/selection>/.exec(inner)?.[1] ?? "";
}

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

/** Build a compact follow-up anchor referencing an earlier thread by number, question, and answer opening. */
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

/** The message text with its context and follow-up blocks removed: what the user actually asked. */
export function stripBlocks(text: string): string {
  return text.replace(BLOCK_RE, "").replace(FOLLOW_UP_RE, "").trim();
}

/**
 * Recover document references from the <browser-context> blocks of a user message.
 * Used for live messages and for rebuilding the browser view from session history.
 */
export function parseBlocks(text: string, cwd: string): Ref[] {
  const refs: Ref[] = [];
  for (const m of text.matchAll(BLOCK_RE)) {
    const [, attrs = "", inner = ""] = m;
    const file = attrOf(attrs, "file");
    if (!file) continue;
    const path = expandPath(file, cwd);
    const selection = selectionOf(inner);
    let anchor: Anchor | undefined;
    let unit: "page" | "slide" = "page";
    const lines = attrOf(attrs, "lines");
    const page = attrOf(attrs, "page") ?? attrOf(attrs, "slide");
    const selector = attrOf(attrs, "selector");
    if (lines) {
      const [s = 0, e = s] = lines.split("-").map(Number);
      if (s > 0) anchor = { kind: "md", text: selection, lines: [s, Math.max(s, e)], headings: [] };
    } else if (page) {
      if (attrOf(attrs, "slide")) unit = "slide";
      const region = attrOf(attrs, "region")?.split(",").map(Number);
      anchor = {
        kind: "pdf",
        text: selection,
        page: Number(page),
        context: "",
        region: region?.length === 4 && region.every((n) => n >= 0 && n <= 1) ? region : undefined,
      };
    } else if (selector) {
      anchor = { kind: "html", text: selection, selector, hint: { classes: [] } };
    }
    if (!anchor) continue;
    const line = Number(attrOf(attrs, "line")) || undefined;
    refs.push({ docId: docId(path), path, label: labelFor(file, anchor, unit, line), anchor });
  }
  return refs;
}

/** Display-only: fold each context and follow-up block in a user message into one quoted line. */
export function foldContexts(markdown: string): string {
  let out = markdown;
  if (out.includes("<browser-context")) {
    out = out.replace(BLOCK_RE, (_m, attrs: string, inner: string) => {
      const lines = attrOf(attrs, "lines");
      const loc = lines
        ? `L${lines}`
        : attrOf(attrs, "page")
          ? `p.${attrOf(attrs, "page")}`
          : attrOf(attrs, "slide")
            ? `slide ${attrOf(attrs, "slide")}`
            : (attrOf(attrs, "selector") ?? "");
      const sel = selectionOf(inner).replace(/\s+/g, " ");
      const note = /<note>([\s\S]*?)<\/note>/.exec(inner)?.[1]?.replace(/\s+/g, " ");
      const excerpt = sel ? ` — “${sel.slice(0, 72)}${sel.length > 72 ? "…" : ""}”` : "";
      const region = /\bregion="/.test(attrs) ? " ▭" : "";
      return `> ⌖ \`${attrOf(attrs, "file") ?? "?"}\` · ${loc}${region}${excerpt}${note ? `  \n> ✎ ${note}` : ""}`;
    });
  }
  if (out.includes("<follow-up")) {
    out = out.replace(FOLLOW_UP_RE, (_m, attrs: string, inner: string) => {
      const ref = attrOf(attrs, "ref") ?? "";
      const pq = /<previous-question>([\s\S]*?)<\/previous-question>/.exec(inner)?.[1]?.replace(/\s+/g, " ").trim();
      return `> ↳ ${ref}${pq ? ` — “${pq.slice(0, 72)}${pq.length > 72 ? "…" : ""}”` : ""}`;
    });
  }
  return out;
}

/** Plain text of a message's content (text parts only). */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "text")
    .map((c) => String((c as { text?: unknown }).text ?? ""))
    .join("");
}

/** Latest thinking text from an assistant message's content array. */
export function thinkingOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "thinking")
    .map((c) => String((c as { thinking?: unknown }).thinking ?? ""))
    .join("\n")
    .trim();
}

/** Name of the last toolCall block currently present in an assistant message. */
export function toolCallNameOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (let i = content.length - 1; i >= 0; i--) {
    const c = content[i];
    if (c && typeof c === "object" && (c as { type?: unknown }).type === "toolCall") {
      const name = (c as { name?: unknown }).name;
      if (typeof name === "string" && name) return name;
    }
  }
  return undefined;
}
