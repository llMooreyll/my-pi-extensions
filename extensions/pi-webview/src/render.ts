import { type Doc, pageUnit } from "./docs.ts";

type Renderer = { render(src: string): string };
interface Renderers {
  /** Local documents: raw HTML allowed, blocks carry source line anchors. */
  doc: Renderer;
  /** Model replies: raw HTML disabled, so a reply cannot inject markup into the page. */
  reply: Renderer;
}

// Loaded lazily so a missing `npm install` reports a readable error instead of breaking extension load.
let renderersPromise: Promise<Renderers> | undefined;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function loadRenderers(): Promise<Renderers> {
  const [{ default: MarkdownIt }, { default: katex }, { default: hljs }] = await Promise.all([
    import("markdown-it"),
    import("katex"),
    import("highlight.js"),
  ]).catch((e: unknown) => {
    throw new Error(`pi-webview dependencies are missing; run npm install in the extension directory (${e instanceof Error ? e.message : String(e)})`);
  });

  const highlight = (code: string, lang: string) => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {
        // Fall back to plain escaped code.
      }
    }
    return "";
  };

  const tex = (src: string, displayMode: boolean) => {
    try {
      return katex.renderToString(src, { displayMode, throwOnError: false, output: "htmlAndMathml" });
    } catch {
      return `<code class="math-error">${escapeHtml(src)}</code>`;
    }
  };

  const mathPlugin = (md: any) => {
    // $…$, $$…$$ inline; "$5 and $6" stays text because the closing $ may not precede a digit.
    md.inline.ruler.before("escape", "math_dollar", (state: any, silent: boolean) => {
      const src: string = state.src;
      const pos: number = state.pos;
      if (src.charCodeAt(pos) !== 0x24) return false;
      const display = src.charCodeAt(pos + 1) === 0x24;
      const delim = display ? "$$" : "$";
      const start = pos + delim.length;
      if (!display && /\s/.test(src[start] ?? " ")) return false;
      let end = start;
      while ((end = src.indexOf(delim, end)) !== -1 && src.charCodeAt(end - 1) === 0x5c) end++;
      if (end === -1 || end === start) return false;
      if (!display && (/\s/.test(src[end - 1]!) || /\d/.test(src[end + 1] ?? ""))) return false;
      if (!silent) {
        const t = state.push(display ? "math_inline_display" : "math_inline", "math", 0);
        t.content = src.slice(start, end);
      }
      state.pos = end + delim.length;
      return true;
    });

    // \( … \) and \[ … \] inline, common in model-written text.
    md.inline.ruler.before("escape", "math_paren", (state: any, silent: boolean) => {
      const src: string = state.src;
      const pos: number = state.pos;
      if (src.charCodeAt(pos) !== 0x5c) return false;
      const c = src[pos + 1];
      if (c !== "(" && c !== "[") return false;
      const close = c === "(" ? "\\)" : "\\]";
      const end = src.indexOf(close, pos + 2);
      if (end === -1) return false;
      if (!silent) {
        const t = state.push(c === "(" ? "math_inline" : "math_inline_display", "math", 0);
        t.content = src.slice(pos + 2, end);
      }
      state.pos = end + 2;
      return true;
    });

    // Block math: lines starting with $$ or \[ up to the closing delimiter.
    md.block.ruler.before(
      "fence",
      "math_block",
      (state: any, startLine: number, endLine: number, silent: boolean) => {
        if (state.sCount[startLine] - state.blkIndent >= 4) return false;
        const lineText = (n: number) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]) as string;
        const first = lineText(startLine);
        const close = first.startsWith("$$") ? "$$" : first.startsWith("\\[") ? "\\]" : undefined;
        if (!close) return false;
        const rest = first.slice(2).trimEnd();
        let line = startLine;
        let content: string;
        if (rest.length >= close.length && rest.endsWith(close)) {
          content = rest.slice(0, -close.length);
        } else {
          const parts = [rest];
          let found = false;
          while (++line < endLine) {
            const text = lineText(line).trimEnd();
            if (text.endsWith(close)) {
              parts.push(text.slice(0, -close.length));
              found = true;
              break;
            }
            parts.push(text);
          }
          if (!found) return false;
          content = parts.join("\n");
        }
        if (silent) return true;
        const t = state.push("math_block", "div", 0);
        t.block = true;
        t.content = content;
        t.map = [startLine, line + 1];
        state.line = line + 1;
        return true;
      },
      { alt: ["paragraph", "reference", "blockquote", "list"] },
    );

    md.renderer.rules.math_inline = (tokens: any[], i: number) => tex(tokens[i].content, false);
    md.renderer.rules.math_inline_display = (tokens: any[], i: number) => `<span class="math-display">${tex(tokens[i].content, true)}</span>`;
    md.renderer.rules.math_block = (tokens: any[], i: number, _o: unknown, _e: unknown, self: any) =>
      `<div class="math-block"${self.renderAttrs(tokens[i])}>${tex(tokens[i].content, true)}</div>\n`;
  };

  // GitHub-style task lists: "- [ ] item" / "- [x] item".
  const taskPlugin = (md: any) => {
    md.core.ruler.after("inline", "task_lists", (state: any) => {
      const tokens = state.tokens;
      for (let i = 2; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type !== "inline" || tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open") continue;
        const m = /^\[([ xX])\]\s+/.exec(t.content);
        const first = t.children?.[0];
        if (!m || first?.type !== "text" || !first.content.startsWith(m[0])) continue;
        first.content = first.content.slice(m[0].length);
        const box = new state.Token("html_inline", "", 0);
        box.content = `<input class="task-box" type="checkbox" disabled${m[1] === " " ? "" : " checked"}> `;
        t.children.unshift(box);
        tokens[i - 2].attrJoin("class", "task");
      }
    });
  };

  const docMd = new MarkdownIt({ html: true, linkify: true, highlight });
  docMd.use(mathPlugin).use(taskPlugin);
  // Source line anchors: every block gets its 1-based [start, end] line range.
  docMd.core.ruler.push("pv_lines", (state: any) => {
    for (const t of state.tokens) {
      if (t.map && t.nesting >= 0 && t.type !== "inline") {
        t.attrSet("data-line", String(t.map[0] + 1));
        t.attrSet("data-line-end", String(t.map[1]));
      }
    }
  });

  const replyMd = new MarkdownIt({ html: false, linkify: true, highlight });
  replyMd.use(mathPlugin).use(taskPlugin);
  // Links in replies open outside the viewer.
  const linkOpen = replyMd.renderer.rules.link_open ?? ((tokens: any[], i: number, o: any, _e: any, self: any) => self.renderToken(tokens, i, o));
  replyMd.renderer.rules.link_open = (tokens: any[], i: number, o: any, e: any, self: any) => {
    tokens[i].attrSet("target", "_blank");
    tokens[i].attrSet("rel", "noopener noreferrer");
    return linkOpen(tokens, i, o, e, self);
  };

  return { doc: { render: (s) => docMd.render(s) }, reply: { render: (s) => replyMd.render(s) } };
}

function renderers(): Promise<Renderers> {
  renderersPromise ??= loadRenderers().catch((e) => {
    renderersPromise = undefined;
    throw e;
  });
  return renderersPromise;
}

/** Front matter is blanked line-for-line so block line numbers still match the file. */
function splitFrontMatter(src: string): { body: string; front?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(src);
  if (!m) return { body: src };
  const lines = m[0].split("\n").length - 1;
  return { front: m[1], body: "\n".repeat(lines) + src.slice(m[0].length) };
}

export async function renderMarkdown(src: string): Promise<string> {
  const { doc } = await renderers();
  return doc.render(splitFrontMatter(src).body);
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

export async function renderReply(src: string): Promise<string> {
  if (!src.trim()) return "";
  try {
    return (await renderers()).reply.render(src);
  } catch {
    return `<pre>${escapeHtml(src)}</pre>`;
  }
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
  <a class="mark" href="${base}/" title="All open documents">pi<i>/</i>view</a>
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

export function indexPage(base: string, items: { id: string; kind: string; file: string; live: number }[], session: string): string {
  const rows = items.length
    ? items
        .map(
          (d, i) =>
            `<li><a href="${base}/v/${d.id}"><span class="n">${String(i + 1).padStart(2, "0")}</span><span class="k">${escapeHtml(d.kind.toUpperCase())}</span><span class="f">${escapeHtml(d.file)}</span><span class="l">${d.live ? `● ${d.live}` : ""}</span></a></li>`,
        )
        .join("")
    : `<li class="empty">Nothing open yet. Run <code>/view &lt;file&gt;</code> in pi.</li>`;
  return `<!doctype html>
<html lang="en" class="flow index">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>pi/view</title>
${fontLinks}<link rel="stylesheet" href="${base}/assets/doc.css">
${THEME_BOOT}
</head>
<body><div class="grain" aria-hidden="true"></div>
<header class="topbar"><span class="mark">pi<i>/</i>view</span><span class="tag">INDEX</span><span class="path">${escapeHtml(session)}</span></header>
<header class="mast"><h1 class="mast-title">Reading <i>room</i></h1></header>
<main class="doc"><ol class="shelf">${rows}</ol></main>
</body></html>`;
}
