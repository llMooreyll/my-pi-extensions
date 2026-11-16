import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type Doc, displayPath, pageUnit } from "./docs.ts";
import { type Hub } from "./hub.ts";
import { escapeHtml, frontMatterHtml, markdownTitle, renderMarkdown } from "./render.ts";
import { snapshotThreads, starPayload } from "./threads.ts";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const requireFromHere = createRequire(import.meta.url);
const MAX_INLINE_BYTES = 12 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

export interface ExportPdfSpan {
  text: string;
  left: number;
  top: number;
  fontSize: number;
  fontFamily?: string;
  transform?: string;
}

export interface ExportPdfPage {
  page: number;
  width: number;
  height: number;
  image: string;
  spans: ExportPdfSpan[];
}

function escapeScriptTag(s: string): string {
  return s.replace(/<\/(script)/gi, "<\\/$1");
}

function escapeStyleTag(s: string): string {
  return s.replace(/<\/(style)/gi, "<\\/$1");
}

function safeJsonScript(id: string, data: unknown): string {
  const raw = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<script id="${id}" type="application/json">${raw}</script>`;
}

function safeTextScript(id: string, text: string): string {
  return `<script id="${id}" type="text/plain">${escapeScriptTag(text)}</script>`;
}

function resolveLocalPath(ref: string, baseDir: string, rootDir: string): string | undefined {
  const clean = ref.split(/[?#]/)[0]?.trim();
  if (!clean || /^(?:https?:|data:|blob:|mailto:|tel:|javascript:|\/\/)/i.test(clean)) return undefined;
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    // Keep raw path if malformed URI escape.
  }
  const full = resolve(baseDir, decoded);
  const normRoot = rootDir.endsWith(sep) ? rootDir : rootDir + sep;
  if (full !== rootDir && !full.startsWith(normRoot)) return undefined;
  return existsSync(full) ? full : undefined;
}

function fileDataUri(fullPath: string): string | undefined {
  const mime = MIME_BY_EXT[extname(fullPath).toLowerCase()];
  if (!mime) return undefined;
  try {
    const buf = readFileSync(fullPath);
    if (buf.byteLength > MAX_INLINE_BYTES) return undefined;
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}

function inlineCssUrls(css: string, cssDir: string, rootDir: string): string {
  return css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/g, (m, a, b, c) => {
    const ref = (a ?? b ?? c ?? "").trim();
    const full = resolveLocalPath(ref, cssDir, rootDir);
    if (!full) return m;
    const uri = fileDataUri(full);
    return uri ? `url("${uri}")` : m;
  });
}

let katexPkgDir: string | undefined;
function katexInlineCss(): string {
  try {
    katexPkgDir ??= dirname(requireFromHere.resolve("katex/package.json"));
    const cssPath = join(katexPkgDir, "dist", "katex.min.css");
    let css = readFileSync(cssPath, "utf8");
    // Keep only woff2 font faces when inlining so exported single files stay compact.
    css = css.replace(/@font-face\{[^}]*\}/g, (block) => {
      const m = /url\((fonts\/[^)]+\.woff2)\)/.exec(block);
      if (!m?.[1]) return "";
      const full = join(katexPkgDir!, "dist", m[1]);
      const uri = existsSync(full) ? fileDataUri(full) : undefined;
      if (!uri) return "";
      return block.replace(/src:[^;}]+/, `src:url("${uri}") format("woff2")`);
    });
    return css;
  } catch {
    return "";
  }
}

function inlineHtmlAssets(html: string, doc: Doc): string {
  let out = html;
  // Strip any accidental live pi-webview injections.
  out = out.replace(/<script\b[^>]*data-doc="[^"]*"[^>]*><\/script>/gi, "");

  // Inline local <link rel="stylesheet" href="...">
  out = out.replace(/<link\b([^>]*\brel=["']stylesheet["'][^>]*)>/gi, (tag, attrs: string) => {
    const href = /\bhref=["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!href) return tag;
    const full = resolveLocalPath(href, doc.dir, doc.dir);
    if (!full) return tag;
    try {
      const css = inlineCssUrls(readFileSync(full, "utf8"), dirname(full), doc.dir);
      return `<style>${escapeStyleTag(css)}</style>`;
    } catch {
      return tag;
    }
  });

  // Inline local <img src="...">
  out = out.replace(/<img\b([^>]*?)>/gi, (tag, attrs: string) => {
    const m = /\bsrc=(["'])([^"']+)\1/i.exec(attrs);
    if (!m?.[2]) return tag;
    const full = resolveLocalPath(m[2], doc.dir, doc.dir);
    if (!full) return tag;
    const uri = fileDataUri(full);
    return uri ? tag.replace(m[0], `src="${uri}"`) : tag;
  });

  // Inline local <script src="...">
  out = out.replace(/<script\b([^>]*\bsrc=(["'])([^"']+)\2[^>]*)><\/script>/gi, (tag, attrs: string, _q: string, src: string) => {
    if (/\btype=["']module["']/i.test(attrs)) return tag;
    const full = resolveLocalPath(src, doc.dir, doc.dir);
    if (!full) return tag;
    try {
      return `<script>${escapeScriptTag(readFileSync(full, "utf8"))}</script>`;
    } catch {
      return tag;
    }
  });

  return out;
}

function inlineMarkdownImages(html: string, doc: Doc): string {
  return html.replace(/<img\b([^>]*?)>/gi, (tag, attrs: string) => {
    const m = /\bsrc=(["'])([^"']+)\1/i.exec(attrs);
    if (!m?.[2]) return tag;
    const full = resolveLocalPath(m[2], doc.dir, doc.dir);
    if (!full) return tag;
    const uri = fileDataUri(full);
    return uri ? tag.replace(m[0], `src="${uri}"`) : tag;
  });
}

function sanitizePdfPages(raw: unknown): ExportPdfPage[] {
  if (!Array.isArray(raw)) return [];
  const pages: ExportPdfPage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const page = typeof p.page === "number" && Number.isInteger(p.page) && p.page > 0 ? p.page : 0;
    const width = typeof p.width === "number" && p.width > 0 ? p.width : 0;
    const height = typeof p.height === "number" && p.height > 0 ? p.height : 0;
    const image = typeof p.image === "string" && /^data:image\/(png|webp|jpeg);base64,/.test(p.image) ? p.image : "";
    if (!page || !width || !height || !image) continue;
    const spans: ExportPdfSpan[] = [];
    if (Array.isArray(p.spans)) {
      for (const s of p.spans) {
        if (!s || typeof s !== "object") continue;
        const sr = s as Record<string, unknown>;
        const text = typeof sr.text === "string" ? sr.text : "";
        if (!text) continue;
        spans.push({
          text,
          left: typeof sr.left === "number" ? sr.left : 0,
          top: typeof sr.top === "number" ? sr.top : 0,
          fontSize: typeof sr.fontSize === "number" && sr.fontSize > 0 ? sr.fontSize : 12,
          ...(typeof sr.fontFamily === "string" && sr.fontFamily ? { fontFamily: sr.fontFamily } : {}),
          ...(typeof sr.transform === "string" && sr.transform ? { transform: sr.transform } : {}),
        });
      }
    }
    pages.push({ page, width, height, image, spans });
  }
  return pages.sort((a, b) => a.page - b.page);
}

function renderPdfPagesHtml(pages: ExportPdfPage[]): string {
  const items = pages
    .map((p) => {
      const spansHtml = p.spans
        .map((s) => {
          const style = [
            `left:${s.left.toFixed(2)}px`,
            `top:${s.top.toFixed(2)}px`,
            `font-size:${s.fontSize.toFixed(2)}px`,
            s.fontFamily ? `font-family:${escapeHtml(s.fontFamily)}` : "",
            s.transform && s.transform !== "none" ? `transform:${escapeHtml(s.transform)}` : "",
          ]
            .filter(Boolean)
            .join(";");
          return `<span style="${style}">${escapeHtml(s.text)}</span>`;
        })
        .join("");
      return `<div class="page pv-export-page" data-page-number="${p.page}" data-base-w="${p.width}" data-base-h="${p.height}" style="width:${p.width}px;height:${p.height}px"><img class="pv-page-img" src="${p.image}" alt="Page ${p.page}"><div class="textLayer" style="width:${p.width}px;height:${p.height}px">${spansHtml}</div></div>`;
    })
    .join("\n");
  return `<div id="viewerContainer"><div id="viewer" class="pdfViewer">${items}</div></div>`;
}

const EXPORT_PDF_CSS = `
.pv-export-page{position:relative;overflow:hidden;margin:2.2rem auto;background:#fff}
.pv-export-page .pv-page-img{display:block;width:100%;height:100%;pointer-events:none;user-select:none}
.pv-export-page .textLayer{position:absolute;left:0;top:0;transform-origin:0 0;transform:scale(var(--tl-scale,1));opacity:1;line-height:1;text-size-adjust:none}
.pv-export-page .textLayer span{position:absolute;white-space:pre;color:transparent;transform-origin:0 0;cursor:text}
[data-theme="carbon"] .pv-export-page .pv-page-img{filter:invert(.9) hue-rotate(180deg) contrast(.92)}
`;

const THEME_BOOT = `<script>document.documentElement.dataset.theme=localStorage.getItem("pv-theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"carbon":"paper")</script>`;

export interface ExportResult {
  filename: string;
  html: string;
}

/** Package a document + its pi-webview threads and stars into one standalone offline HTML file. */
export async function exportDocumentHtml(h: Hub, doc: Doc, rawPages?: unknown): Promise<ExportResult> {
  const file = displayPath(doc.path, h.cwd);
  const unit = doc.kind === "office" ? pageUnit(doc) : "page";
  const allThreads = await snapshotThreads(h);
  const docStars = h.stars.filter((s) => s.docId === doc.id).map(starPayload);
  const starSeqs = new Set(docStars.map((s) => s.threadSeq));
  const docThreads = allThreads.filter((t) => t.refs.some((r) => r.docId === doc.id) || starSeqs.has(t.seq));

  const [uiCss, docCss, coreJs, mdJs, htmlJs, pdfJs] = await Promise.all([
    readFile(join(WEB_DIR, "ui.css"), "utf8"),
    readFile(join(WEB_DIR, "doc.css"), "utf8"),
    readFile(join(WEB_DIR, "core.js"), "utf8"),
    readFile(join(WEB_DIR, "md.js"), "utf8"),
    readFile(join(WEB_DIR, "html.js"), "utf8"),
    readFile(join(WEB_DIR, "pdf.js"), "utf8"),
  ]);

  const snapshot = {
    version: 1,
    exportedAt: Date.now(),
    doc: { id: doc.id, kind: doc.kind, file, name: doc.name, unit },
    threads: docThreads,
    stars: docStars,
  };

  const baseName = doc.name.replace(/\.[^.]+$/, "") || doc.name;
  const filename = `${baseName}.annotated.html`;

  if (doc.kind === "html") {
    const rawHtml = await readFile(doc.path, "utf8");
    const inlined = inlineHtmlAssets(rawHtml, doc);
    const hasMath = /class=["'][^"']*katex/.test(inlined) || docThreads.some((t) => t.html.includes("katex"));
    const katexCss = hasMath ? katexInlineCss() : "";
    const headExtras = katexCss ? `<style>${escapeStyleTag(katexCss)}</style>` : "";
    const overlayScripts = [
      safeTextScript("pv-ui-css", uiCss),
      katexCss ? safeTextScript("pv-katex-css", katexCss) : "",
      safeJsonScript("pv-snapshot", snapshot),
      `<script data-base="" data-doc="${doc.id}" data-kind="html" data-unit="${unit}" data-file="${escapeHtml(file)}" data-export="1">${escapeScriptTag(coreJs)}</script>`,
      `<script>(() => {\n${escapeScriptTag(htmlJs)}\n})();</script>`,
    ]
      .filter(Boolean)
      .join("\n");

    let htmlOut = inlined;
    if (headExtras && /<\/head>/i.test(htmlOut)) {
      htmlOut = htmlOut.replace(/<\/head>/i, `${headExtras}\n</head>`);
    } else if (headExtras) {
      htmlOut = `${headExtras}\n${htmlOut}`;
    }
    if (/<\/body>/i.test(htmlOut)) {
      htmlOut = htmlOut.replace(/<\/body>/i, `${overlayScripts}\n</body>`);
    } else if (/<\/html>/i.test(htmlOut)) {
      htmlOut = htmlOut.replace(/<\/html>/i, `${overlayScripts}\n</html>`);
    } else {
      htmlOut = `${htmlOut}\n${overlayScripts}`;
    }
    return { filename, html: htmlOut };
  }

  let bodyHtml = "";
  let title = baseName;
  let meta = "";
  let adapterJs = mdJs;
  let extraCss = "";
  let hasMath = docThreads.some((t) => t.html.includes("katex"));

  if (doc.kind === "md") {
    const src = await readFile(doc.path, "utf8");
    title = markdownTitle(src, doc.name);
    meta = frontMatterHtml(src);
    bodyHtml = inlineMarkdownImages(await renderMarkdown(src), doc);
    if (bodyHtml.includes("katex")) hasMath = true;
    adapterJs = mdJs;
  } else {
    const pages = sanitizePdfPages(rawPages);
    if (!pages.length) {
      throw new Error("PDF/Office export requires rendered page payloads from the browser tab");
    }
    bodyHtml = renderPdfPagesHtml(pages);
    extraCss = EXPORT_PDF_CSS;
    adapterJs = pdfJs;
  }

  const katexCss = hasMath ? katexInlineCss() : "";
  const paged = doc.kind === "pdf" || doc.kind === "office";
  const kindLabel = doc.kind === "office" ? doc.name.split(".").pop()!.toUpperCase() : doc.kind.toUpperCase();
  const stamp = new Date(snapshot.exportedAt).toLocaleString();

  const html = `<!doctype html>
<html lang="en" data-kind="${doc.kind}" class="${paged ? "paged" : "flow"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — pi/view export</title>
${katexCss ? `<style>${escapeStyleTag(katexCss)}</style>` : ""}
<style>${escapeStyleTag(docCss + extraCss)}</style>
${THEME_BOOT}
</head>
<body>
<div class="grain" aria-hidden="true"></div>
<header class="topbar">
  <span class="mark">pi<i>/</i>view</span>
  <span class="tag">${escapeHtml(kindLabel)} · EXPORT</span>
  <span class="doc-title">${escapeHtml(title)}</span>
  <span class="path">${escapeHtml(file)} · ${escapeHtml(stamp)}</span>
</header>
<header class="mast">
  <h1 class="mast-title">${escapeHtml(title)}</h1>
  ${meta}
</header>
<nav class="rail" id="rail" aria-label="Contents"></nav>
<main id="doc" class="doc doc-${doc.kind}">${bodyHtml}</main>
${safeTextScript("pv-ui-css", uiCss)}
${katexCss ? safeTextScript("pv-katex-css", katexCss) : ""}
${safeJsonScript("pv-snapshot", snapshot)}
<script data-base="" data-doc="${doc.id}" data-kind="${doc.kind}" data-unit="${unit}" data-file="${escapeHtml(file)}" data-export="1">${escapeScriptTag(coreJs)}</script>
<script>(() => {\n${escapeScriptTag(adapterJs)}\n})();</script>
</body>
</html>`;

  return { filename, html };
}
