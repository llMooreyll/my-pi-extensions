import { escapeHtml, renderDocMarkdown } from "../shared/markdown.ts";
import { type Doc, pageUnit } from "./docs.ts";

export { escapeHtml };

/** Front matter is blanked line-for-line so block line numbers still match the file. */
function splitFrontMatter(src: string): { body: string; front?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(src);
  if (!m) return { body: src };
  const lines = m[0].split("\n").length - 1;
  return { front: m[1], body: "\n".repeat(lines) + src.slice(m[0].length) };
}

export async function renderMarkdown(src: string): Promise<string> {
  return renderDocMarkdown(splitFrontMatter(src).body);
}

/** Front matter shown as a key/value list under the title (simple `key: value` lines). */
export function frontMatterHtml(src: string): string {
  const front = splitFrontMatter(src).front;
  if (!front) return "";
  const rows = front
    .split("\n")
    .map((line) => /^([\w.-]+):\s*(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m && m[1] !== "title" && !!m[2]?.trim())
    .map((m) => `<div><dt>${escapeHtml(m[1]!)}</dt><dd>${escapeHtml(m[2]!.replace(/^["']|["']$/g, ""))}</dd></div>`);
  return rows.length ? `<dl class="frontmatter">${rows.join("")}</dl>` : "";
}

export function markdownTitle(src: string, fallback: string): string {
  const front = splitFrontMatter(src).front;
  const fm = front ? /^title:\s*["']?(.+?)["']?\s*$/m.exec(front) : null;
  if (fm?.[1]) return fm[1];
  const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(src);
  return h1?.[1]?.replace(/[*_`]/g, "") ?? fallback;
}

const FONTS =
  "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..900;1,9..144,300..900&family=Newsreader:ital,opsz,wght@0,6..72,300..700;1,6..72,300..700&family=JetBrains+Mono:wght@400;600;800&display=swap";

const fontLinks = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${FONTS}">`;

// KaTeX declares @font-face, which only takes effect in the document, not inside the overlay's shadow root.
const katexLink = (base: string) => `<link rel="stylesheet" href="${base}/vendor/katex/dist/katex.min.css">`;

function coreScript(base: string, doc: Doc, file: string, defer: boolean): string {
  const unit = doc.kind === "office" ? pageUnit(doc) : "page";
  return `<script${defer ? " defer" : ""} src="${base}/assets/core.js" data-base="${base}" data-doc="${doc.id}" data-kind="${doc.kind}" data-unit="${unit}" data-file="${escapeHtml(file)}"></script>`;
}

const THEME_BOOT = `<script>document.documentElement.dataset.theme=localStorage.getItem("pv-theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"carbon":"paper")</script>`;

export interface ShellOptions {
  base: string;
  doc: Doc;
  file: string;
  title: string;
  body: string;
  /** Extra masthead content under the title (front matter). */
  meta?: string;
}

export function shellPage(o: ShellOptions): string {
  const { base, doc } = o;
  const paged = doc.kind === "pdf" || doc.kind === "office";
  const kindLabel = doc.kind === "office" ? doc.name.split(".").pop()!.toUpperCase() : doc.kind.toUpperCase();
  const pdfCss = paged ? `<link rel="stylesheet" href="${base}/vendor/pdfjs-dist/web/pdf_viewer.css">` : "";
  return `<!doctype html>
<html lang="en" data-kind="${doc.kind}" class="${paged ? "paged" : "flow"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(o.title)} — pi/view</title>
<base href="${base}/f/${doc.id}/">
${fontLinks}
${katexLink(base)}
${pdfCss}
<link rel="stylesheet" href="${base}/assets/doc.css">
${THEME_BOOT}
</head>
<body>
<div class="grain" aria-hidden="true"></div>
<header class="topbar">
  <span class="mark">pi<i>/</i>view</span>
  <span class="tag">${escapeHtml(kindLabel)}</span>
  <span class="doc-title">${escapeHtml(o.title)}</span>
  <span class="path">${escapeHtml(o.file)}</span>
</header>
<header class="mast">
  <h1 class="mast-title">${escapeHtml(o.title)}</h1>
  ${o.meta ?? ""}
</header>
<nav class="rail" id="rail" aria-label="Contents"></nav>
<main id="doc" class="doc doc-${doc.kind}">${o.body}</main>
${coreScript(base, doc, o.file, false)}
<script type="module" src="${base}/assets/${paged ? "pdf" : "md"}.js"></script>
</body>
</html>`;
}

export const PDF_STAGE = `<div id="viewerContainer"><div id="viewer" class="pdfViewer"></div></div><div id="pdf-status" class="pdf-status"><span class="spin"></span><b>RENDERING</b><em></em></div>`;

/** Inject the overlay into a user HTML page without touching anything else. */
export function injectHtml(html: string, base: string, doc: Doc, file: string): string {
  const snippet = `${fontLinks}${katexLink(base)}${coreScript(base, doc, file, true)}<script defer src="${base}/assets/html.js"></script>`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + snippet + html.slice(head.index + head[0].length);
  const root = /<html\b[^>]*>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + snippet + html.slice(root.index + root[0].length);
  return snippet + html;
}
