// Markdown engines shared by the document viewer and the reply renderers of every feature module.
type Renderer = { render(src: string): string };
interface Renderers {
  /** Local documents: raw HTML allowed, blocks carry source line anchors. */
  doc: Renderer;
  /** Model replies: raw HTML disabled, so a reply cannot inject markup into the page. */
  reply: Renderer;
  /** Model replies with MathML-only formulas, for pages that cannot load the KaTeX stylesheet and fonts. */
  replyMathml: Renderer;
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

  const tex = (src: string, displayMode: boolean, output: "htmlAndMathml" | "mathml") => {
    try {
      return katex.renderToString(src, { displayMode, throwOnError: false, output });
    } catch {
      return `<code class="math-error">${escapeHtml(src)}</code>`;
    }
  };

  const mathPlugin = (output: "htmlAndMathml" | "mathml") => (md: any) => {
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

    md.renderer.rules.math_inline = (tokens: any[], i: number) => tex(tokens[i].content, false, output);
    md.renderer.rules.math_inline_display = (tokens: any[], i: number) => `<span class="math-display">${tex(tokens[i].content, true, output)}</span>`;
    md.renderer.rules.math_block = (tokens: any[], i: number, _o: unknown, _e: unknown, self: any) =>
      `<div class="math-block"${self.renderAttrs(tokens[i])}>${tex(tokens[i].content, true, output)}</div>\n`;
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
  docMd.use(mathPlugin("htmlAndMathml")).use(taskPlugin);
  // Source line anchors: every block gets its 1-based [start, end] line range.
  docMd.core.ruler.push("pv_lines", (state: any) => {
    for (const t of state.tokens) {
      if (t.map && t.nesting >= 0 && t.type !== "inline") {
        t.attrSet("data-line", String(t.map[0] + 1));
        t.attrSet("data-line-end", String(t.map[1]));
      }
    }
  });

  const replyRenderer = (output: "htmlAndMathml" | "mathml") => {
    const md = new MarkdownIt({ html: false, linkify: true, highlight });
    md.use(mathPlugin(output)).use(taskPlugin);
    // Links in replies open outside the viewer.
    const linkOpen = md.renderer.rules.link_open ?? ((tokens: any[], i: number, o: any, _e: any, self: any) => self.renderToken(tokens, i, o));
    md.renderer.rules.link_open = (tokens: any[], i: number, o: any, e: any, self: any) => {
      tokens[i].attrSet("target", "_blank");
      tokens[i].attrSet("rel", "noopener noreferrer");
      return linkOpen(tokens, i, o, e, self);
    };
    return md;
  };
  const replyMd = replyRenderer("htmlAndMathml");
  const replyMathmlMd = replyRenderer("mathml");

  return {
    doc: { render: (s) => docMd.render(s) },
    reply: { render: (s) => replyMd.render(s) },
    replyMathml: { render: (s) => replyMathmlMd.render(s) },
  };
}

function renderers(): Promise<Renderers> {
  renderersPromise ??= loadRenderers().catch((e) => {
    renderersPromise = undefined;
    throw e;
  });
  return renderersPromise;
}

/** Render a document body with the source-line-anchored engine. */
export async function renderDocMarkdown(body: string): Promise<string> {
  return (await renderers()).doc.render(body);
}

/** Render a model reply; raw HTML is disabled. `mathml` drops KaTeX's HTML layer for pages without its stylesheet. */
export async function renderReply(src: string, opts: { mathml?: boolean } = {}): Promise<string> {
  if (!src.trim()) return "";
  try {
    const r = await renderers();
    return (opts.mathml ? r.replyMathml : r.reply).render(src);
  } catch {
    return `<pre>${escapeHtml(src)}</pre>`;
  }
}
